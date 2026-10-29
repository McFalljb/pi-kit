// Helpers for the background shell extension (unit-tested in test/unit.test.ts).

import { spawnSync } from "node:child_process";
import { MessageChannel, receiveMessageOnPort, Worker } from "node:worker_threads";
import { redact } from "../guardrails/core.ts";

export const MAX_LINE = 300; // characters kept per delivered line
export const MAX_BATCH = 20; // lines kept per monitor notice; the rest are counted
export const MATCH_CAP = 4096; // chars of a line that are matched and redacted (bounds their cost)
export const MATCH_BUDGET_MS = 1000; // a pattern gets this long per batch of lines, then the watch ends
export const KEY_REDACTED = "[private key block redacted]";

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;
const KEY_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const KEY_END = /-----END [A-Z ]*PRIVATE KEY-----/;

/** Split a new chunk of output into complete lines; `rest` is the unterminated tail to carry over. */
export function splitLines(carry: string, chunk: string): { lines: string[]; rest: string } {
	const parts = (carry + chunk).split(/\r?\n/);
	const rest = parts.pop() ?? "";
	return { lines: parts, rest };
}

/**
 * Strip terminal escapes and carriage-return redraws, redact secrets, then cap the length.
 * Redaction runs before the cut, so a cut never leaves a token too short to be recognised.
 */
export function clip(line: string): string {
	const plain = line.replace(ANSI, "");
	const shown = plain.slice(plain.lastIndexOf("\r") + 1);
	// Past MATCH_CAP, drop the token-like fragment the cut leaves, since it may be part of a secret.
	const head = shown.length > MATCH_CAP ? shown.slice(0, MATCH_CAP).replace(/[\w+/=.-]+$/, "") : shown;
	const safe = redact(head, true);
	const more = shown.length - head.length + Math.max(0, safe.length - MAX_LINE);
	return more > 0 ? `${safe.slice(0, MAX_LINE)}… [${more} more chars]` : safe;
}

/**
 * Drop the lines of a private key block that spans several lines: the BEGIN line becomes
 * KEY_REDACTED, the lines up to and including END are dropped (undefined).
 */
export function keyFilter(state: { inKey: boolean }, line: string): string | undefined {
	if (state.inKey) {
		if (KEY_END.test(line)) state.inKey = false;
		return undefined;
	}
	const at = line.search(KEY_BEGIN);
	if (at < 0 || KEY_END.test(line.slice(at))) return line;
	state.inKey = true;
	return line.slice(0, at) + KEY_REDACTED;
}

/**
 * Where to start reading lines that may begin inside a key block (a window into the output, or the
 * output after a skip): just past an END marker that has no BEGIN before it, else 0.
 */
export function afterOpenKey(lines: string[]): number {
	const end = lines.findIndex((l) => KEY_END.test(l));
	return end >= 0 && !lines.slice(0, end + 1).some((l) => KEY_BEGIN.test(l)) ? end + 1 : 0;
}

/**
 * The last `n` non-empty lines of the end of an output file, clipped and redacted. `fromStart` says
 * whether `text` starts at the start of the file; if not, its first (partial) line is dropped, and
 * so is everything before an END marker whose BEGIN lies before the window.
 */
export function lastLines(text: string, n: number, fromStart = true): string[] {
	let lines = text.split(/\r?\n/);
	if (!fromStart) lines = lines.slice(1);
	const out: string[] = [];
	const start = afterOpenKey(lines);
	if (start > 0) {
		lines = lines.slice(start);
		out.push(KEY_REDACTED);
	}
	const state = { inKey: false };
	for (const l of lines) {
		const kept = keyFilter(state, l);
		if (kept !== undefined && kept.trim() !== "") out.push(clip(kept));
	}
	return out.slice(-n);
}

// A repeated group that itself contains a repeat, like (a+)+ or (\w+\s?)*: exponential backtracking.
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*(?:[*+]|\{\d+,\d*\})(?:[^()\\]|\\.)*\)(?:[*+]|\{\d+,)/;

/** Compile a monitor pattern; undefined means every line. Throws a readable error when invalid. */
export function compilePattern(pattern: string | undefined): RegExp | undefined {
	if (pattern === undefined || pattern === "") return undefined;
	let re: RegExp;
	try {
		re = new RegExp(pattern);
	} catch (e) {
		throw new Error(`Invalid pattern ${JSON.stringify(pattern)}: ${(e as Error).message}`);
	}
	if (NESTED_QUANTIFIER.test(pattern)) {
		throw new Error(`Pattern ${JSON.stringify(pattern)} repeats a group that itself repeats (like (a+)+), which can take exponential time. Rewrite it without the nested repeat.`);
	}
	return re;
}

const MATCHER_JS = `
const { workerData: { source, flags, flag, port } } = require("node:worker_threads");
const re = new RegExp(source, flags);
const done = new Int32Array(flag);
port.on("message", (lines) => {
	port.postMessage(lines.map((l) => re.test(l)));
	Atomics.store(done, 0, 1);
	Atomics.notify(done, 0);
});`;

/**
 * Test lines against `re` in a worker thread, waiting at most `budgetMs` per batch. Returns one
 * boolean per line, or undefined when the budget ran out (the worker is then terminated and the
 * matcher must not be used again). Any regex can backtrack for minutes on one line; this bounds it.
 */
export function lineMatcher(re: RegExp, budgetMs = MATCH_BUDGET_MS): { test(lines: string[]): boolean[] | undefined; close(): void } {
	const flag = new SharedArrayBuffer(4);
	const done = new Int32Array(flag);
	const { port1, port2 } = new MessageChannel();
	const worker = new Worker(MATCHER_JS, { eval: true, workerData: { source: re.source, flags: re.flags, flag, port: port2 }, transferList: [port2] });
	worker.on("error", () => {}); // an uncaught error in the worker must not take pi down; test() then times out
	worker.unref();
	port1.unref();
	const close = () => {
		port1.close();
		void worker.terminate();
	};
	return {
		test(lines) {
			if (!lines.length) return [];
			Atomics.store(done, 0, 0);
			port1.postMessage(lines);
			if (Atomics.wait(done, 0, 0, budgetMs) === "timed-out") {
				close();
				return undefined;
			}
			return receiveMessageOnPort(port1)?.message as boolean[] | undefined;
		},
		close,
	};
}

/** Whether any process is left in process group `pgid` (signal 0 sends nothing). */
export function groupAlive(pgid: number): boolean {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM"; // exists, but owned by another user
	}
}

/** How many processes are in process group `pgid`, or undefined when pgrep cannot say. */
export function groupSize(pgid: number): number | undefined {
	const r = spawnSync("pgrep", ["-g", String(pgid)], { encoding: "utf8", timeout: 2000 });
	if (r.status !== 0 && r.status !== 1) return undefined;
	return r.stdout.split("\n").filter(Boolean).length;
}

/**
 * Whether a task's process group is known to be gone. Latched: once the group is empty its id may
 * be reused by an unrelated group, so a later check could wrongly say it is back.
 */
export function groupGone(t: { pid: number; ended?: number; gone?: boolean }, alive = groupAlive): boolean {
	if (!t.gone && t.ended !== undefined && !alive(t.pid)) t.gone = true;
	return !!t.gone;
}

/** Finished tasks to forget beyond the newest `keep`: never one whose group may still be alive. */
export function evictable<T extends { ended?: number; gone?: boolean }>(tasks: T[], keep: number): T[] {
	const finished = tasks.filter((t) => t.ended !== undefined && t.gone).sort((a, b) => a.ended! - b.ended!);
	return finished.slice(0, Math.max(0, finished.length - keep));
}

export function duration(ms: number): string {
	const s = Math.round(ms / 1000);
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}
