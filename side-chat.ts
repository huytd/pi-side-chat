/**
 * Side chat for pi — ask questions about the current conversation without touching it.
 *
 * - /side [question]  or  alt+s   → open the side-chat overlay (optionally sending a question)
 * - /side-clear                   → wipe side-chat history for this session
 *
 * Isolation: the main session is only ever READ (buildSessionContext on a snapshot of entries).
 * Model calls go through ctx.modelRegistry.streamSimple directly, so nothing is appended to the
 * session tree. Side-chat history lives in its own file: <agentDir>/side-chats/<sessionId>.jsonl
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import {
	buildSessionContext,
	convertToLlm,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	getMarkdownTheme,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { type Focusable, Input, Markdown, matchesKey, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type Turn = { role: "user" | "assistant"; text: string; ts: number; model?: string };

const SIDE_PREAMBLE =
	"[SIDE CHAT] The user is asking a side question about the conversation above. " +
	"This exchange is NOT part of the main conversation and will not be seen by the main agent. " +
	"Answer directly and concisely. Do NOT call any tools — answer from the context you already have.";

function historyFile(ctx: ExtensionContext): string {
	const dir = join(getAgentDir(), "side-chats");
	mkdirSync(dir, { recursive: true });
	return join(dir, `${ctx.sessionManager.getSessionId()}.jsonl`);
}

function loadHistory(ctx: ExtensionContext): Turn[] {
	const file = historyFile(ctx);
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as Turn);
}

function saveTurn(ctx: ExtensionContext, turn: Turn) {
	appendFileSync(historyFile(ctx), `${JSON.stringify(turn)}\n`);
}

/** Read-only snapshot of the main conversation as LLM messages. */
function mainContext(ctx: ExtensionContext): Message[] {
	const sm = ctx.sessionManager;
	const { messages } = buildSessionContext(sm.getEntries(), sm.getLeafId());
	const llm = convertToLlm(messages);
	// Drop a trailing incomplete assistant message (main agent may be mid-stream).
	while (llm.length && llm[llm.length - 1]!.role === "assistant") {
		const last = llm[llm.length - 1] as AssistantMessage;
		if (last.stopReason === "stop" || last.stopReason === "length") break;
		llm.pop();
	}
	return llm;
}

function textOf(msg: AssistantMessage): string {
	return msg.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("");
}

class SideChatPanel implements Focusable {
	focused = false;
	private input = new Input({ prompt: "› ", placeholder: "Ask about this conversation…" });
	private streaming: string | null = null;
	private abort: AbortController | null = null;
	private scroll = 0; // lines scrolled up from bottom
	private cache = new Map<string, { width: number; lines: string[] }>();

	constructor(
		private tui: TUI,
		private theme: Theme,
		private ctx: ExtensionContext,
		private pi: ExtensionAPI,
		private history: Turn[],
		private close: () => void,
	) {
		this.input.onSubmit = (v) => {
			const q = v.trim();
			if (!q || this.streaming !== null) return;
			this.input.setValue("");
			void this.ask(q);
		};
	}

	async ask(question: string) {
		const ctx = this.ctx;
		if (!ctx.model) {
			this.push({ role: "assistant", text: "_No model selected._", ts: Date.now() });
			return;
		}
		this.push({ role: "user", text: question, ts: Date.now() });

		const sideMsgs: Message[] = this.history.slice(0, -1).map((t) =>
			t.role === "user"
				? { role: "user", content: [{ type: "text", text: t.text }], timestamp: t.ts }
				: ({ role: "assistant", content: [{ type: "text", text: t.text }], timestamp: t.ts } as unknown as Message),
		);
		const messages: Message[] = [
			...mainContext(ctx),
			...sideMsgs,
			{ role: "user", content: [{ type: "text", text: `${SIDE_PREAMBLE}\n\n${question}` }], timestamp: Date.now() },
		];

		// Same system prompt + tool list as the main agent → maximizes prompt-cache reuse.
		const active = new Set(this.pi.getActiveTools());
		const tools = this.pi
			.getAllTools()
			.filter((t) => active.has(t.name))
			.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters as object }));

		this.streaming = "";
		this.abort = new AbortController();
		this.scroll = 0;
		this.tui.requestRender();
		try {
			const stream = ctx.modelRegistry.streamSimple(
				ctx.model,
				{ systemPrompt: ctx.getSystemPrompt(), messages, tools },
				{ signal: this.abort.signal },
			);
			for await (const ev of stream) {
				if (ev.type === "text_delta") {
					this.streaming += ev.delta;
					this.tui.requestRender();
				}
			}
			const final = await stream.result();
			let text = textOf(final) || this.streaming;
			const calls = final.content.filter((c) => c.type === "toolCall").map((c) => (c as { name: string }).name);
			if (calls.length) text += `\n\n_(tried to call ${calls.join(", ")} — side chat is read-only)_`;
			if (final.stopReason === "error") text += `\n\n_Error: ${final.errorMessage ?? "unknown"}_`;
			if (final.stopReason === "aborted") text += "\n\n_(cancelled)_";
			this.push({ role: "assistant", text: text || "_(empty response)_", ts: Date.now(), model: ctx.model.id });
		} catch (e) {
			this.push({ role: "assistant", text: `_Error: ${(e as Error).message}_`, ts: Date.now() });
		} finally {
			this.streaming = null;
			this.abort = null;
			this.tui.requestRender();
		}
	}

	private push(turn: Turn) {
		this.history.push(turn);
		saveTurn(this.ctx, turn);
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			if (this.abort) this.abort.abort();
			else this.close();
			return;
		}
		if (matchesKey(data, "pageUp")) {
			this.scroll += 10;
		} else if (matchesKey(data, "pageDown")) {
			this.scroll = Math.max(0, this.scroll - 10);
		} else {
			this.input.handleInput(data);
		}
		this.tui.requestRender();
	}

	private renderTurn(t: Turn, i: number, width: number): string[] {
		const key = `${i}:${t.ts}`;
		const hit = this.cache.get(key);
		if (hit && hit.width === width) return hit.lines;
		const lines = this.renderText(t, width);
		this.cache.set(key, { width, lines });
		return lines;
	}

	private renderText(t: Turn, width: number): string[] {
		const th = this.theme;
		if (t.role === "user") {
			return new Markdown(t.text, 1, 0, getMarkdownTheme(), { color: (s: string) => th.fg("accent", s) }).render(width);
		}
		return new Markdown(t.text, 1, 0, getMarkdownTheme()).render(width);
	}

	render(width: number): string[] {
		const th = this.theme;
		const inner = Math.max(10, width - 2);
		const height = Math.max(8, this.tui.terminal.rows - 2);
		const row = (s: string) => {
			const t = truncateToWidth(s, inner);
			return th.fg("border", "│") + t + " ".repeat(Math.max(0, inner - visibleWidth(t))) + th.fg("border", "│");
		};

		const body: string[] = [];
		this.history.forEach((t, i) => {
			body.push(th.fg("dim", t.role === "user" ? " you" : ` side · ${t.model ?? ""}`));
			body.push(...this.renderTurn(t, i, inner));
			body.push("");
		});
		if (this.streaming !== null) {
			body.push(th.fg("dim", ` side · ${this.ctx.model?.id ?? ""} …`));
			body.push(...new Markdown(this.streaming || "…", 1, 0, getMarkdownTheme()).render(inner));
		}
		if (!body.length) body.push(th.fg("dim", " Side questions see the main conversation but never change it."));

		const bodyH = height - 5; // top border, header, sep, input, bottom border
		this.scroll = Math.min(this.scroll, Math.max(0, body.length - bodyH));
		const end = body.length - this.scroll;
		const visible = body.slice(Math.max(0, end - bodyH), end);
		while (visible.length < bodyH) visible.unshift("");

		const hint = this.streaming !== null ? "esc cancel" : "esc close · pgup/pgdn scroll";
		const title = ` ${th.fg("accent", "◆ side chat")} ${th.fg("dim", `(${this.history.length} msgs) · ${hint}`)}`;
		this.input.focused = this.focused;
		return [
			th.fg("border", `╭${"─".repeat(inner)}╮`),
			row(title),
			th.fg("border", `├${"─".repeat(inner)}┤`),
			...visible.map(row),
			row(this.input.render(inner)[0] ?? ""),
			th.fg("border", `╰${"─".repeat(inner)}╯`),
		];
	}

	invalidate(): void {
		this.cache.clear();
	}
}

export default function (pi: ExtensionAPI) {
	const open = async (ctx: ExtensionContext, initial?: string) => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("side chat needs interactive mode", "error");
			return;
		}
		const history = loadHistory(ctx);
		await ctx.ui.custom<void>(
			(tui, theme, _kb, done) => {
				const panel = new SideChatPanel(tui, theme, ctx, pi, history, () => done());
				if (initial?.trim()) void panel.ask(initial.trim());
				return panel;
			},
			{ overlay: true, overlayOptions: { anchor: "right-center", width: "45%", minWidth: 40, maxHeight: "100%", margin: 1 } },
		);
	};

	pi.registerCommand("side", {
		description: "Open side chat (sees this conversation, never modifies it)",
		handler: async (args, ctx) => open(ctx, args),
	});
	pi.registerShortcut("alt+s", { description: "Open side chat", handler: async (ctx) => open(ctx) });
	pi.registerCommand("side-clear", {
		description: "Clear side-chat history for this session",
		handler: async (_args, ctx) => {
			rmSync(historyFile(ctx), { force: true });
			ctx.ui.notify("Side chat history cleared", "info");
		},
	});
}
