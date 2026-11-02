// Pure helpers for the pi-desk bridge (unit-tested in test/unit.test.ts). The protocol is pi-desk's
// docs/PROTOCOL.md: NDJSON over a Unix socket, `hello` first, then the pi-tab schema (§4).

import { one, type Run, runningLeaves, type ShellRow } from "../sidebar/rows.ts";

export const V = 1;
// Where a connection's token for the next hello is kept, in memory only (globalThis, so it survives
// a reload or session switch), by the env variable it came from.
const tokenKey = (env: string) => Symbol.for(env === "PI_DESK_TOKEN" ? "pi-kit.desk-bridge.token" : `pi-kit.desk.token.${env}`);

/**
 * The token for the next `hello` from env variable `env`. pi-desk's env tokens are single-use: the
 * first successful hello revokes it and returns a `reconnect_token`, valid until the tab exits,
 * which keepToken stores for every later hello. `take` also deletes the env variable; that does
 * not remove it from the process's initial environment (`ps eww` still shows it), which is why
 * the env token must be single-use.
 */
export function envToken(env: string, take = false): string | undefined {
	const g = globalThis as Record<symbol, string | undefined>;
	const token = g[tokenKey(env)] || process.env[env];
	if (take && token) {
		g[tokenKey(env)] = token;
		delete process.env[env];
	}
	return token;
}
/** Keep a hello result's reconnect token for every later hello with `env`'s token. */
export function keepToken(env: string, token: unknown): void {
	if (typeof token === "string" && token) (globalThis as Record<symbol, string | undefined>)[tokenKey(env)] = token;
}
/** The pi tab's token (PI_DESK_TOKEN, caller `panel`). */
export const deskToken = (take = false) => envToken("PI_DESK_TOKEN", take);
export const keepReconnectToken = (token: unknown) => keepToken("PI_DESK_TOKEN", token);

/** Whether this pi runs in a pi-desk tab (other extensions can drop terminal-only chrome). */
export const inDesk = () => !!process.env.PI_DESK_SOCKET && !!deskToken();

export type Agent = "idle" | "working" | "error";
export interface Status {
	agent: Agent;
	waiting: boolean; // a pi dialog is open
	question: boolean; // idle after a final answer ending with "?"
	blockers: string[];
}

/** One NDJSON line: a request from the bridge, or a reply (`type: "result"`) to one from pi-desk. */
export const line = (msg: Record<string, unknown>) => `${JSON.stringify({ v: V, ...msg })}\n`;
export const reply = (id: unknown, result: { ok: boolean; error?: string }) => line({ id, type: "result", result });

/** A received line as an object, or undefined (not JSON, not an object, wrong version). */
export function parse(text: string): Record<string, any> | undefined {
	try {
		const m = JSON.parse(text);
		return m && typeof m === "object" && !Array.isArray(m) && (m.v === undefined || m.v === V) ? m : undefined;
	} catch {
		return undefined;
	}
}

/** Reconnect delay after `attempt` failures: 0.5 s doubling to 30 s. */
export const backoff = (attempt: number) => Math.min(30_000, 500 * 2 ** Math.min(attempt, 6));

interface Msg {
	role?: string;
	stopReason?: string;
	content?: unknown;
}
/** How a run ended, from agent_end's messages: an error, or a final answer that asks the user something. */
export function runOutcome(messages: unknown): { error: boolean; question: boolean } {
	const last = (Array.isArray(messages) ? (messages as Msg[]) : []).filter((m) => m?.role === "assistant").pop();
	if (!last) return { error: false, question: false };
	const text = typeof last.content === "string" ? last.content : Array.isArray(last.content) ? last.content.map((c) => (c?.type === "text" ? String(c.text ?? "") : "")).join("") : "";
	return { error: last.stopReason === "error", question: last.stopReason === "stop" && /\?\s*$/.test(text) };
}

/**
 * The pi-tab status. `idle`: pi's own isIdle() (no run, retry, compaction or queued continuation
 * left; agent_end alone is not idle). `waiting`: a dialog is open. `question`: pi is idle after a
 * final answer that ends with a question.
 */
export function status(s: { idle: boolean; error: boolean; dialogs: number; question: boolean; shells: ShellRow[]; runs: Run[] }): Status {
	return { agent: !s.idle ? "working" : s.error ? "error" : "idle", waiting: s.dialogs > 0, question: s.idle && s.question, blockers: blockers(s.shells, s.runs) };
}

/** Why pi is not idle for wait_idle and reload (a reload would cut these off); empty when it is. */
export function busyReasons(s: Status, queued: boolean): string[] {
	return [...(s.agent === "working" ? ["agent working"] : []), ...(s.waiting ? ["a dialog is open"] : []), ...(queued ? ["messages queued"] : []), ...s.blockers];
}

/**
 * Why pi.prompt must be refused, or undefined. pi rejects a prompt during a manual /compact (it
 * throws inside sendUserMessage, where the error never reaches the caller), so it is refused here.
 */
export function promptRefusal(s: { dialogs: number; compacting: boolean }): string | undefined {
	if (s.dialogs) return "pi is waiting on the user (a dialog is open)";
	if (s.compacting) return "pi is compacting the session; retry when it is idle";
}

/** Background work a reload would kill or that will start another run: kit shells and timers, running subagents. Redacted. */
export function blockers(shells: ShellRow[], runs: Run[]): string[] {
	const out: string[] = [];
	for (const r of Array.isArray(shells) ? shells : []) {
		if (!r?.id) out.push(one(r?.status));
		else out.push(`${r.id.startsWith("wk") ? "timer" : "shell"} ${one(r.id)}: ${one(r.label)}`);
	}
	for (const r of Array.isArray(runs) ? runs : []) if (r && runningLeaves(r)) out.push(`subagent ${one(r.label) || one(r.kind) || one(r.id) || "run"}`);
	return out;
}

// ---- comments that go with the user's next message (pi-desk docs/BROWSER.md §3.7) ----

export type Image = { type: "image"; data: string; mimeType: string };
/** What pi-desk's `pi.attach` holds until the user's next message: pi-desk's text block and images. */
export interface Attachment {
	id: string | number;
	text: string;
	images: Image[];
}
export const ATTACH_IMAGES_MAX = 8;
export const ATTACH_DATA_MAX = 6 * 1024 * 1024; // base64 characters across one message's images
const MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Images on the wire (`[{mime, data}]`, data base64) as pi's image content; undefined if absent,
 * a string if invalid (the error).
 */
export function wireImages(v: unknown): Image[] | string | undefined {
	if (v === undefined) return undefined;
	if (!Array.isArray(v)) return "images must be a list";
	if (v.length > ATTACH_IMAGES_MAX) return `at most ${ATTACH_IMAGES_MAX} images`;
	const out: Image[] = [];
	let size = 0;
	for (const [i, x] of v.entries()) {
		if (!MIMES.includes(x?.mime)) return `image ${i + 1}: mime must be image/png, image/jpeg, image/gif or image/webp`;
		if (typeof x.data !== "string" || x.data.length % 4 !== 0 || !BASE64.test(x.data)) return `image ${i + 1}: data must be base64`;
		size += x.data.length;
		out.push({ type: "image", data: x.data, mimeType: x.mime });
	}
	if (size > ATTACH_DATA_MAX) return "images too large";
	return out;
}

/** A `pi.attach` message as an attachment, or the error. */
export function parseAttach(m: Record<string, any>): Attachment | string {
	const id = m.attachment_id;
	if ((typeof id !== "number" && typeof id !== "string") || id === "") return "attachment_id is required";
	if (typeof m.text !== "string" || !m.text.trim()) return "text is required";
	const images = wireImages(m.images);
	if (typeof images === "string") return images;
	return { id, text: m.text, images: images ?? [] };
}

/**
 * The input transform: the user's next message typed in pi (source `interactive`) gets the pending
 * attachment after its own text and images. undefined: leave the input as it is (nothing pending,
 * a message from pi.prompt, RPC or another extension, or a `/` command: pi expands templates and
 * skills after this hook, and the block would end up in their arguments).
 */
export function attachInput(e: { text: string; images?: Image[]; source: string }, a: Attachment | undefined): { text: string; images: Image[] } | undefined {
	if (!a || e.source !== "interactive" || e.text.startsWith("/")) return undefined; // pi's own check
	// restored from pi's queue (Esc) with the block already in it: only the images again
	if (e.text.includes(a.text)) return { text: e.text, images: [...(e.images ?? []), ...a.images] };
	return { text: e.text.trim() ? `${e.text}\n\n${a.text}` : a.text, images: [...(e.images ?? []), ...a.images] };
}

/** A message's text (a user message's content is a string or text and image parts). */
function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((p) => (p?.type === "text" && typeof p.text === "string" ? p.text : "")).join("\n");
}

/**
 * pi-desk's pending comments in the bridge: what `pi.attach` holds. A message queued while pi works
 * takes them and acks at once (pi has it; Esc puts its text, block included, back in the editor),
 * so pi-desk stops showing them pending (Send now, Clear or Edit cannot double them). An idle
 * prompt acks once its message starts (`started`, from pi's `message_start`): pi may still refuse
 * it (no model, no auth) or another extension take it, and then the comments go with the next.
 */
export class Attacher {
	held: Attachment | undefined;

	/** pi.attach: replaces what is held. */
	set(a: Attachment) {
		this.held = a;
	}
	/** pi.attach_clear, or the connection dropped (pi-desk sends it again, or clears it). */
	clear() {
		this.held = undefined;
	}
	/** The input transform for the user's message (attachInput), with `ack` for a queued one. */
	input(e: { text: string; images?: Image[]; source: string; streamingBehavior?: string }): { text: string; images: Image[]; ack?: string | number } | undefined {
		const a = this.held;
		const out = attachInput(e, a);
		if (!out || !a) return undefined;
		if (!e.streamingBehavior) return out;
		this.held = undefined;
		return { ...out, ack: a.id };
	}
	/** A message started (pi's message_start): the held attachment if it carries it (ack it). */
	started(message: { role?: string; content?: unknown }): (string | number)[] {
		const a = this.held;
		if (!a || message?.role !== "user" || !messageText(message.content).includes(a.text)) return [];
		this.held = undefined;
		return [a.id];
	}
}

/** pi.prompt's message for sendUserMessage: the text alone, or text then images. */
export function promptContent(text: string, images: Image[]): string | ({ type: "text"; text: string } | Image)[] {
	return images.length ? [{ type: "text", text }, ...images] : text;
}

// ---- commands other extensions send over the bridge's connection (kit:desk:command) ----

/** The pi.events names of the command RPC: desk-bridge serves COMMAND_EVENT, desk (Home) CONTROL_EVENT. */
export const COMMAND_EVENT = "kit:desk:command";
export const CONTROL_EVENT = "kit:desk:control:command";
/** desk (Home) says whether its control connection is up: true / false. */
export const CONTROL_READY = "kit:desk:control";
export type CommandOutcome = { result: Record<string, any> } | { error: string };
/** The commands extensions/desk-browser sends: the only ones either route forwards. */
export const BROWSER_COMMANDS: ReadonlySet<string> = new Set(["browser_tabs", "browser_open", "browser_navigate", "browser_read", "browser_screenshot", "browser_wait", "browser_console", "browser_network", "browser_comments"]);
/** Why a command may not go over kit:desk:command / kit:desk:control:command, or undefined. */
export function browserRefusal(cmd: unknown): string | undefined {
	const type = (cmd as Record<string, unknown> | undefined)?.type;
	if (typeof type !== "string" || !BROWSER_COMMANDS.has(type)) return `This route forwards only the browser tools' commands (${[...BROWSER_COMMANDS].join(", ")}), not ${JSON.stringify(type ?? null)}.`;
}

/**
 * pi-desk commands in flight on one connection, by our line id: a command's `result` line ends it,
 * or, when pending, the `finished` event with its request_id (pi-desk sends that to the requester
 * even without a subscription). A finished event seen before its result line is kept (a few).
 */
export class CommandCalls {
	private byId = new Map<string, { done: (o: CommandOutcome) => void; rid?: number }>();
	private byRid = new Map<number, string>();
	private early = new Map<number, Record<string, any>>();
	/** Waits for line `id`'s outcome. */
	start(id: string, done: (o: CommandOutcome) => void) {
		this.byId.set(id, { done, rid: undefined });
	}
	/** A `result` line: true if it was one of ours. */
	onResult(m: Record<string, any>): boolean {
		const call = this.byId.get(m.id);
		if (!call) return false;
		const result = m.result ?? { ok: false, error: "no result" };
		if (result.pending && typeof m.request_id === "number") {
			if (this.early.has(m.request_id)) {
				const r = this.early.get(m.request_id)!;
				this.early.delete(m.request_id);
				this.end(m.id, { result: r });
			} else {
				call.rid = m.request_id;
				this.byRid.set(m.request_id, m.id);
			}
			return true;
		}
		this.end(m.id, { result });
		return true;
	}
	/** A `finished` event: true if it ended one of ours. */
	onFinished(m: Record<string, any>): boolean {
		if (typeof m.request_id !== "number") return false;
		const id = this.byRid.get(m.request_id);
		if (id === undefined) {
			this.early.set(m.request_id, m.result ?? {});
			if (this.early.size > 32) this.early.delete(this.early.keys().next().value!);
			return false;
		}
		this.end(id, { result: m.result ?? {} });
		return true;
	}
	/** Stop waiting for one (cancelled, timed out). */
	end(id: string, o: CommandOutcome) {
		const call = this.byId.get(id);
		if (!call) return;
		this.byId.delete(id);
		if (call.rid !== undefined) this.byRid.delete(call.rid);
		call.done(o);
	}
	/** The connection closed: every call ends with `error`. */
	failAll(error: string) {
		for (const id of [...this.byId.keys()]) this.end(id, { error });
		this.early.clear();
	}
	get size() {
		return this.byId.size;
	}
}
