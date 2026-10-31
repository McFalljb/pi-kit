// Pure helpers for the pi-desk bridge (unit-tested in test/unit.test.ts). The protocol is pi-desk's
// docs/PROTOCOL.md: NDJSON over a Unix socket, `hello` first, then the pi-tab schema (§4).

import { one, type Run, runningLeaves, type ShellRow } from "../sidebar/rows.ts";

export const V = 1;
const TOKEN_KEY = Symbol.for("pi-kit.desk-bridge.token"); // the token for the next hello, in memory only

/**
 * The token for the next `hello`. pi-desk's env token (PI_DESK_TOKEN) is single-use: the first
 * successful hello revokes it and returns a `reconnect_token`, valid until the tab exits, which
 * the bridge keeps here (globalThis, so it survives a reload or session switch) for every later
 * hello. `take` also deletes the env variable; that does not remove it from the process's initial
 * environment (`ps eww` still shows it), which is why the env token must be single-use.
 */
export function deskToken(take = false): string | undefined {
	const g = globalThis as { [TOKEN_KEY]?: string };
	const token = g[TOKEN_KEY] || process.env.PI_DESK_TOKEN;
	if (take && token) {
		g[TOKEN_KEY] = token;
		delete process.env.PI_DESK_TOKEN;
	}
	return token;
}
/** Keep the hello result's reconnect token for every later hello. */
export function keepReconnectToken(token: unknown): void {
	if (typeof token === "string" && token) (globalThis as { [TOKEN_KEY]?: string })[TOKEN_KEY] = token;
}

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
export function status(s: { idle: boolean; error: boolean; dialog: boolean; question: boolean; shells: ShellRow[]; runs: Run[] }): Status {
	return { agent: !s.idle ? "working" : s.error ? "error" : "idle", waiting: s.dialog, question: s.idle && s.question, blockers: blockers(s.shells, s.runs) };
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
