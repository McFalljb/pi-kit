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
