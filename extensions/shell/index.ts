/**
 * Background shells and monitors, modelled on Claude Code's background Bash, Monitor and TaskStop.
 *
 * - bash_bg: start a command in its own process group; output goes to a file; a notice wakes the
 *   session when it exits (exit code, last lines, output path).
 * - monitor: run a command (or watch a bash_bg task) and send a notice for new output lines that
 *   match a pattern, batched, until it exits, is stopped, or times out.
 * - shell_stop: kill a task's whole process group (or end only its watch). shell_list and /shells:
 *   running and recent tasks. The footer shows the running count.
 *
 * Every command goes through the kit guardrails' checkCommand (confirm dangerous commands, block
 * secret access), and every notice is redacted like bash output. Not registered in read-only
 * sessions (PI_KIT_READONLY=1). Tasks belong to this pi process: they are killed when the session
 * ends or reloads and do not survive a restart. A process that leaves its group (setsid, nohup
 * with its own group, a daemonizing server) escapes shell_stop and cleanup.
 */

import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { checkCommand, redact } from "../guardrails/core.ts";
import { batchText, clip, compilePattern, duration, lastLines, splitLines } from "./lines.ts";

const POLL_MS = 250; // how often a watch reads new output
const BATCH_MS = 1000; // a watch sends at most one notice per this window
const MAX_NOTICES = 50; // per watch; then the watch ends and the task keeps running
const KEEP_FINISHED = 20;
const HEADLESS_DRAIN_MS = 30 * 60 * 1000; // headless sessions wait this long for tasks, then kill them

interface Watch {
	re?: RegExp;
	pending: string[];
	matches: number;
	notices: number;
	offset: number;
	carry: string;
	decoder: StringDecoder;
	poll: NodeJS.Timeout;
	flush?: NodeJS.Timeout;
	until?: NodeJS.Timeout;
}

interface Task {
	id: string;
	command: string;
	cwd: string;
	out: string;
	child: ChildProcess;
	pid: number;
	started: number;
	ended?: number;
	code?: number | null;
	signal?: NodeJS.Signals | null;
	reason?: string; // why we killed it: "timed out after 30s", "stopped"
	quiet?: boolean; // stopped on request: no exit notice
	timer?: NodeJS.Timeout;
	watch?: Watch;
}

export default function (pi: ExtensionAPI) {
	if (process.env.PI_KIT_READONLY === "1") return;

	const tasks = new Map<string, Task>();
	let seq = 0;
	let dir: string | undefined;
	let ui: ExtensionContext["ui"] | undefined;
	let closed = false;
	let noticesThisRun = 0;
	let wake: (() => void) | undefined; // resolves the headless drain wait

	const running = () => [...tasks.values()].filter((t) => t.ended === undefined);

	function footer() {
		const n = running().length;
		try {
			ui?.setStatus("shell", n ? `${n} shell${n === 1 ? "" : "s"} running · /shells` : undefined);
		} catch {}
	}

	function notify(text: string) {
		if (closed) return;
		noticesThisRun++;
		try {
			pi.sendMessage({ customType: "kit-shell", content: redact(text, true), display: true, details: undefined }, { triggerTurn: true, deliverAs: "followUp" });
		} catch {}
		wake?.();
	}

	function killGroup(t: Task, sig: NodeJS.Signals) {
		try {
			process.kill(-t.pid, sig);
		} catch {}
	}

	function stop(t: Task, reason: string) {
		if (t.ended !== undefined) return;
		t.reason ??= reason;
		killGroup(t, "SIGTERM");
		setTimeout(() => killGroup(t, "SIGKILL"), 2000).unref();
	}

	function readNew(t: Task, w: Watch, final: boolean) {
		let chunk = "";
		try {
			const size = fs.statSync(t.out).size;
			if (size > w.offset) {
				const buf = Buffer.alloc(size - w.offset);
				const fd = fs.openSync(t.out, "r");
				try {
					fs.readSync(fd, buf, 0, buf.length, w.offset);
				} finally {
					fs.closeSync(fd);
				}
				w.offset = size;
				chunk = w.decoder.write(buf);
			}
		} catch {
			return;
		}
		const { lines, rest } = splitLines(w.carry, chunk + (final ? w.decoder.end() : ""));
		w.carry = rest;
		if (final && rest) lines.push(rest);
		for (const line of lines) {
			if (w.re && !w.re.test(line)) continue;
			w.matches++;
			w.pending.push(clip(line));
		}
		if (!final && w.pending.length && !w.flush) w.flush = setTimeout(() => flush(t), BATCH_MS);
	}

	function flush(t: Task) {
		const w = t.watch;
		if (!w) return;
		w.flush = undefined;
		if (!w.pending.length) return;
		const lines = w.pending.splice(0);
		w.notices++;
		const capped = w.notices >= MAX_NOTICES;
		notify(
			`Monitor ${t.id}: ${lines.length} new ${w.re ? "matching " : ""}line${lines.length === 1 ? "" : "s"} from \`${clip(t.command)}\`\n${batchText(lines)}` +
				(capped ? `\n\nNotice cap (${MAX_NOTICES}) reached: watch ended, the task keeps running. Output: ${t.out}` : ""),
		);
		if (capped) endWatch(t);
	}

	/** Stop watching; returns lines not yet delivered. */
	function endWatch(t: Task): string[] {
		const w = t.watch;
		if (!w) return [];
		clearInterval(w.poll);
		clearTimeout(w.flush);
		clearTimeout(w.until);
		t.watch = undefined;
		return w.pending.splice(0);
	}

	function watch(t: Task, re: RegExp | undefined, timeoutSec: number | undefined, ownsTask: boolean) {
		endWatch(t);
		const w: Watch = { re, pending: [], matches: 0, notices: 0, offset: 0, carry: "", decoder: new StringDecoder("utf8"), poll: setInterval(() => readNew(t, w, false), POLL_MS) };
		t.watch = w;
		if (timeoutSec) {
			w.until = setTimeout(() => {
				if (ownsTask) return stop(t, `monitor timed out after ${timeoutSec}s`);
				readNew(t, w, true);
				const left = endWatch(t);
				notify(`Monitor ${t.id} timed out after ${timeoutSec}s (${w.matches} lines matched); the task keeps running.${left.length ? `\n${batchText(left)}` : ""}`);
			}, timeoutSec * 1000);
		}
	}

	function onExit(t: Task, code: number | null, signal: NodeJS.Signals | null) {
		t.ended = Date.now();
		t.code = code;
		t.signal = signal;
		clearTimeout(t.timer);
		let left: string[] = [];
		let matched: number | undefined;
		if (t.watch) {
			readNew(t, t.watch, true);
			matched = t.watch.matches;
			left = endWatch(t);
		}
		footer();
		const finished = [...tasks.values()].filter((x) => x.ended !== undefined);
		for (const old of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) tasks.delete(old.id);
		if (t.quiet) return wake?.();
		const status = t.reason ? `${t.reason} (${signal ?? `code ${code}`})` : signal ? `killed by ${signal}` : `exited with code ${code}`;
		let text = `Background shell ${t.id} ${status} after ${duration(t.ended - t.started)}: \`${clip(t.command)}\`\nOutput: ${t.out}`;
		if (left.length) text += `\nUndelivered monitor lines:\n${batchText(left)}`;
		if (matched !== undefined) text += `\nMonitor total: ${matched} matching line${matched === 1 ? "" : "s"}.`;
		else {
			let tail = "";
			try {
				const size = fs.statSync(t.out).size;
				const fd = fs.openSync(t.out, "r");
				const buf = Buffer.alloc(Math.min(size, 4096));
				fs.readSync(fd, buf, 0, buf.length, size - buf.length);
				fs.closeSync(fd);
				tail = lastLines(buf.toString("utf8"), 10).join("\n");
			} catch {}
			text += tail ? `\nLast lines:\n${tail}` : "\n(no output)";
		}
		notify(text);
	}

	async function start(command: string, cwdParam: string | undefined, timeoutSec: number | undefined, ctx: ExtensionContext): Promise<Task> {
		ui = ctx.ui;
		const blocked = await checkCommand(command, false, ctx);
		if (blocked) throw new Error(blocked);
		const cwd = path.resolve(ctx.cwd, cwdParam ?? ".");
		if (!fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`cwd ${cwd} is not a directory`);
		dir ??= fs.mkdtempSync(path.join(os.tmpdir(), "pi-shell-"));
		const id = `sh${++seq}`;
		const out = path.join(dir, `${id}.log`);
		const fd = fs.openSync(out, "a", 0o600);
		let child: ChildProcess;
		try {
			child = spawn("bash", ["-c", command], { cwd, detached: true, stdio: ["ignore", fd, fd] });
		} finally {
			fs.closeSync(fd);
		}
		if (child.pid === undefined) throw new Error(`could not start bash for ${id}`);
		const t: Task = { id, command, cwd, out, child, pid: child.pid, started: Date.now() };
		tasks.set(id, t);
		child.on("exit", (code, signal) => onExit(t, code, signal));
		child.on("error", (e) => fs.appendFileSync(out, `\n[pi-kit] ${e.message}\n`));
		if (timeoutSec) t.timer = setTimeout(() => stop(t, `timed out after ${timeoutSec}s`), timeoutSec * 1000);
		footer();
		return t;
	}

	function describe(t: Task): string {
		const state = t.ended === undefined ? `running ${duration(Date.now() - t.started)}` : (t.reason ?? (t.signal ? `killed by ${t.signal}` : `exit ${t.code}`));
		const w = t.watch ? `, watching ${t.watch.re ? `/${t.watch.re.source}/` : "all lines"} (${t.watch.matches} matched)` : "";
		return `${t.id}  ${state}${w}  \`${clip(t.command)}\`  ${t.out}`;
	}

	function listText(): string {
		const all = [...tasks.values()];
		return all.length ? all.map(describe).join("\n") : "No background shells in this session.";
	}

	const text = (s: string) => ({ content: [{ type: "text" as const, text: s }], details: undefined });
	const timeout = Type.Optional(Type.Number({ description: "Seconds before it is killed (bash_bg) or the watch ends (monitor). Default: none.", minimum: 1 }));
	const cwd = Type.Optional(Type.String({ description: "Working directory, relative to the session's. Default: the session's." }));

	pi.registerTool({
		name: "bash_bg",
		label: "Background shell",
		description:
			"Run a shell command in the background (dev servers, long builds, test suites). Returns at once with an id and an output file. When the command exits, a notice with its exit code, last lines and output path arrives on its own: do not sleep, poll or re-read the file in a loop. Stop it with shell_stop when you no longer need it.",
		promptSnippet: "Run a long command in the background; a notice arrives when it exits",
		parameters: Type.Object({ command: Type.String({ description: "Bash command" }), cwd, timeout }),
		async execute(_id, p, _signal, _onUpdate, ctx) {
			const t = await start(p.command, p.cwd, p.timeout, ctx);
			return text(`Started ${t.id} (pid ${t.pid}) in ${t.cwd}.\nOutput: ${t.out}\nA notice arrives when it exits.`);
		},
	});

	pi.registerTool({
		name: "monitor",
		label: "Monitor",
		description:
			"Watch output and get a notice for each new line matching `pattern` (a JavaScript regex; every line if omitted), batched about once a second. Either give `command` to run and watch it (it is killed at `timeout`), or `id` of a running bash_bg task to watch its output. Ends when the command exits, on shell_stop, or at `timeout`. For \"tell me when X\" use a command that prints when X happens and exits, e.g. `until curl -sf localhost:3000; do sleep 2; done; echo ready`.",
		promptSnippet: "Get notified on each output line matching a pattern, or when a condition becomes true",
		parameters: Type.Object({
			command: Type.Optional(Type.String({ description: "Bash command to run and watch" })),
			id: Type.Optional(Type.String({ description: "Watch this running bash_bg task instead of starting a command" })),
			pattern: Type.Optional(Type.String({ description: "JavaScript regex; lines that match are delivered. Omit for every line." })),
			cwd,
			timeout,
		}),
		async execute(_id, p, _signal, _onUpdate, ctx) {
			if (!!p.command === !!p.id) throw new Error("Give exactly one of `command` or `id`.");
			const re = compilePattern(p.pattern);
			let t: Task | undefined;
			if (p.command) {
				t = await start(p.command, p.cwd, undefined, ctx);
			} else {
				t = tasks.get(p.id!);
				if (!t || t.ended !== undefined) throw new Error(`No running task ${p.id}. Running: ${running().map((x) => x.id).join(", ") || "none"}`);
			}
			watch(t, re, p.timeout, !!p.command);
			return text(`Monitoring ${t.id} for ${re ? `/${re.source}/` : "every line"}.\nOutput: ${t.out}\nMatching lines arrive as notices; stop with shell_stop.`);
		},
	});

	pi.registerTool({
		name: "shell_stop",
		label: "Stop shell",
		description: "Stop a background task: kill its whole process group (SIGTERM, then SIGKILL after 2s). With watch_only, end only the monitor on it and leave the task running.",
		parameters: Type.Object({
			id: Type.String({ description: "Task id, e.g. sh1" }),
			watch_only: Type.Optional(Type.Boolean({ description: "End only the monitor; keep the task running" })),
		}),
		async execute(_id, p) {
			const t = tasks.get(p.id);
			if (!t) throw new Error(`No task ${p.id}. Known: ${[...tasks.keys()].join(", ") || "none"}`);
			if (p.watch_only) {
				if (t.watch) readNew(t, t.watch, true);
				const left = endWatch(t);
				return text(`Stopped watching ${t.id}; it keeps running.${left.length ? `\nUndelivered lines:\n${batchText(left)}` : ""}`);
			}
			if (t.ended !== undefined) return text(`${t.id} already finished: ${describe(t)}`);
			t.quiet = true;
			stop(t, "stopped");
			await new Promise<void>((resolve) => {
				const deadline = setTimeout(resolve, 3000);
				t.child.once("exit", () => {
					clearTimeout(deadline);
					resolve();
				});
			});
			return text(t.ended !== undefined ? `Stopped ${t.id} (${t.signal ?? `code ${t.code}`}). Output: ${t.out}` : `Sent SIGTERM to ${t.id}; SIGKILL follows.`);
		},
	});

	pi.registerTool({
		name: "shell_list",
		label: "List shells",
		description: "List this session's background tasks (running and recently finished) with state, watch and output path.",
		parameters: Type.Object({}),
		async execute() {
			return text(listText());
		},
	});

	pi.registerCommand("shells", {
		description: "List background shells and monitors",
		handler: async (_args, ctx) => ctx.ui.notify(listText(), "info"),
	});

	pi.on("session_start", (_e, ctx) => {
		ui = ctx.ui;
	});
	pi.on("agent_start", () => {
		noticesThisRun = 0;
	});

	// Headless (print/json, subagent children): pi would exit with tasks still running, so wait
	// for the next notice (it starts a follow-up run) or for every task to end.
	pi.on("agent_end", async (_e, ctx) => {
		if (ctx.hasUI || noticesThisRun > 0 || running().length === 0) return;
		const deadline = Date.now() + HEADLESS_DRAIN_MS;
		while (running().length > 0 && noticesThisRun === 0 && Date.now() < deadline) {
			await new Promise<void>((resolve) => {
				wake = resolve;
				setTimeout(resolve, 1000).unref();
			});
			wake = undefined;
		}
		if (running().length > 0 && noticesThisRun === 0) {
			for (const t of running()) stop(t, "killed: headless session ended");
		}
	});

	const killAll = () => {
		for (const t of tasks.values()) killGroup(t, "SIGKILL");
	};
	process.on("exit", killAll);

	pi.on("session_shutdown", async () => {
		if (closed) return;
		closed = true;
		for (const t of tasks.values()) {
			endWatch(t);
			clearTimeout(t.timer);
			if (t.ended === undefined) killGroup(t, "SIGTERM");
		}
		if (running().length) await new Promise((r) => setTimeout(r, 500));
		killAll(); // also catches leftovers of finished tasks still in their group
		process.off("exit", killAll);
		try {
			ui?.setStatus("shell", undefined);
		} catch {}
	});
}
