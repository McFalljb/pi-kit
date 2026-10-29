/**
 * Background shells and monitors, modelled on Claude Code's background Bash, Monitor and TaskStop.
 *
 * - bash_bg: start a command in its own process group; output goes to a file; a notice wakes the
 *   session when it exits (exit code, last lines, output path).
 * - monitor: run a command (or watch a bash_bg task) and send a notice for new output lines that
 *   match a pattern, batched, until it exits, is stopped, or times out.
 * - wake_later: a one-shot timer that wakes the session with a prompt (for checks no shell sees).
 * - shell_stop: kill a task's whole process group (or end only its watch, or cancel a timer).
 *   shell_list and /shells: running and recent tasks. The footer shows the running count.
 *
 * Every command goes through the kit guardrails' checkCommand (confirm dangerous commands, block
 * secret access). Every delivered line is
 * redacted like bash output before it is cut, and private key blocks are dropped. Not registered
 * in read-only sessions (PI_KIT_READONLY=1). Tasks belong to this pi process: they are killed
 * when the session ends or reloads and do not survive a restart. Processes left in a task's
 * group after bash exits are reported and stay killable; a process that leaves its group
 * (setsid, a daemonizing server) escapes shell_stop and cleanup.
 */

import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { checkCommand, redact } from "../guardrails/core.ts";
import {
	afterOpenKey,
	clip,
	compilePattern,
	duration,
	evictable,
	groupGone,
	groupSize,
	keyFilter,
	lastLines,
	lineMatcher,
	MATCH_BUDGET_MS,
	MATCH_CAP,
	MAX_BATCH,
	splitLines,
} from "./lines.ts";

const POLL_MS = 250; // how often a watch reads new output
const BATCH_MS = 1000; // a watch sends at most one notice per this window
const MAX_NOTICES = 50; // per watch; then the watch ends and the task keeps running
const KEEP_FINISHED = 20;
const HEADLESS_DRAIN_MS = 30 * 60 * 1000; // headless sessions wait this long for tasks, then kill them
const READ_CAP = 1 << 20; // bytes a watch reads per poll; a flood is read over several polls
const BACKLOG_CAP = 8 << 20; // unread bytes beyond which a watch skips ahead to the newest output
const TAIL_BYTES = 64 << 10; // bytes of the end of the output read for the exit notice's last lines
// A task whose output file grows past this is killed. PI_KIT_SHELL_LOG_CAP (bytes) is for tests.
const LOG_CAP = Number(process.env.PI_KIT_SHELL_LOG_CAP) || 1 << 30;
const WAKE_MIN = 60;
const WAKE_MAX = 3600;

interface Watch {
	re?: RegExp;
	match?: ReturnType<typeof lineMatcher>; // tests lines against re in a worker, with a time budget
	owns: boolean; // the monitor started the command (it is killed when the watch must end)
	failed?: string; // why the watch had to end early
	pending: string[]; // at most MAX_BATCH lines; the rest are only counted
	skipped: number;
	skippedBytes: number; // output skipped because the reader fell behind
	resync: boolean; // the next lines may start inside a key block (after a skip, or attached mid-file)
	partial: boolean; // and the first of them is a partial line
	inKey: boolean; // inside a private key block: lines are dropped until its END line
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
	cap?: NodeJS.Timeout; // checks the output file size
	reap?: NodeJS.Timeout; // after exit, until the processes left in the group are gone
	gone?: boolean; // the process group is known to be empty: never signal it again (its id may be reused)
	watch?: Watch;
}

interface Wake {
	id: string;
	prompt: string;
	due: number;
	timer: NodeJS.Timeout;
}

export default function (pi: ExtensionAPI) {
	if (process.env.PI_KIT_READONLY === "1") return;

	const tasks = new Map<string, Task>();
	const wakes = new Map<string, Wake>();
	let seq = 0;
	let dir: string | undefined;
	let ui: ExtensionContext["ui"] | undefined;
	let closed = false;
	let noticesThisRun = 0;
	let wake: (() => void) | undefined; // resolves the headless drain wait

	const running = () => [...tasks.values()].filter((t) => t.ended === undefined);
	const busy = () => running().length + wakes.size;

	function footer() {
		const n = busy();
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
		if (groupGone(t)) return;
		try {
			process.kill(-t.pid, sig);
		} catch {}
	}

	/** Kill the task's group: SIGTERM, then SIGKILL after 2 s to whatever is left. */
	function stop(t: Task, reason: string) {
		if (groupGone(t)) return;
		if (t.ended === undefined) t.reason ??= reason;
		killGroup(t, "SIGTERM");
		setTimeout(() => killGroup(t, "SIGKILL"), 2000).unref();
	}

	function scan(w: Watch, chunk: string, final: boolean) {
		if (w.failed) return;
		const { lines, rest } = splitLines(w.carry, chunk);
		w.carry = rest.length > 65536 ? rest.slice(0, 65536) : rest; // a huge unterminated line: keep its start
		if (final && w.carry) lines.push(w.carry);
		if (w.resync && lines.length) {
			w.resync = false;
			lines.splice(0, Math.max(w.partial ? 1 : 0, afterOpenKey(lines)));
		}
		const kept: string[] = [];
		for (const line of lines) {
			const k = keyFilter(w, line);
			if (k !== undefined) kept.push(k);
		}
		let hits = kept;
		if (w.match) {
			const ok = w.match.test(kept.map((l) => l.slice(0, MATCH_CAP)));
			if (!ok) {
				w.failed = `pattern /${w.re!.source}/ took over ${MATCH_BUDGET_MS / 1000}s on one batch of lines`;
				return;
			}
			hits = kept.filter((_, i) => ok[i]);
		}
		for (const line of hits) {
			w.matches++;
			if (w.pending.length < MAX_BATCH) w.pending.push(clip(line));
			else w.skipped++;
		}
	}

	/** Read new output in READ_CAP chunks: one per poll, or all of it when final. */
	function readNew(t: Task, w: Watch, final: boolean) {
		try {
			const fd = fs.openSync(t.out, "r");
			try {
				const size = fs.fstatSync(fd).size;
				if (size - w.offset > BACKLOG_CAP) {
					// Fell behind: skip to the newest READ_CAP bytes (this also bounds the final drain).
					w.skippedBytes += size - READ_CAP - w.offset;
					w.offset = size - READ_CAP;
					w.carry = "";
					w.decoder = new StringDecoder("utf8");
					w.inKey = false;
					w.resync = w.partial = true;
				}
				do {
					const n = Math.min(size - w.offset, READ_CAP);
					if (n <= 0) break;
					const buf = Buffer.alloc(n);
					fs.readSync(fd, buf, 0, n, w.offset);
					w.offset += n;
					scan(w, w.decoder.write(buf), false);
				} while (final && !w.failed);
			} finally {
				fs.closeSync(fd);
			}
		} catch {}
		if (final) scan(w, w.decoder.end(), true);
		else if (w.failed) failWatch(t, w);
		else if ((w.pending.length || w.skippedBytes) && !w.flush) w.flush = setTimeout(() => flush(t), BATCH_MS);
	}

	/** End a watch whose pattern ran out of time; a command the monitor started is stopped too. */
	function failWatch(t: Task, w: Watch) {
		const left = endWatch(t);
		if (w.owns) {
			t.quiet = true;
			stop(t, "stopped: monitor pattern too slow");
		}
		notify(`Monitor ${t.id} ended: ${w.failed}. ${w.owns ? "Its command was stopped." : "The task keeps running."} Output: ${t.out}${left.length ? `\n${left.join("\n")}` : ""}`);
	}

	function flush(t: Task) {
		const w = t.watch;
		if (!w) return;
		w.flush = undefined;
		if (!w.pending.length && !w.skippedBytes) return;
		const n = w.pending.length + w.skipped;
		const lines = takePending(w);
		w.notices++;
		const capped = w.notices >= MAX_NOTICES;
		notify(
			`Monitor ${t.id}: ${n} new ${w.re ? "matching " : ""}line${n === 1 ? "" : "s"} from \`${clip(t.command)}\`\n${lines.join("\n")}` +
				(capped ? `\n\nNotice cap (${MAX_NOTICES}) reached: watch ended, the task keeps running. Output: ${t.out}` : ""),
		);
		if (capped) endWatch(t);
	}

	function takePending(w: Watch): string[] {
		const lines = w.pending.splice(0);
		if (w.skipped) lines.push(`… ${w.skipped} more matching line${w.skipped === 1 ? "" : "s"} (see the output file)`);
		if (w.skippedBytes) lines.push(`… ${w.skippedBytes} bytes skipped: output came faster than the monitor reads (see the output file)`);
		w.skipped = 0;
		w.skippedBytes = 0;
		return lines;
	}

	/** Stop watching; returns lines not yet delivered. */
	function endWatch(t: Task): string[] {
		const w = t.watch;
		if (!w) return [];
		clearInterval(w.poll);
		clearTimeout(w.flush);
		clearTimeout(w.until);
		w.match?.close();
		t.watch = undefined;
		return takePending(w);
	}

	function atLineStart(file: string, offset: number): boolean {
		const b = Buffer.alloc(1);
		let fd: number | undefined;
		try {
			fd = fs.openSync(file, "r");
			return fs.readSync(fd, b, 0, 1, offset - 1) === 1 && b[0] === 10;
		} catch {
			return false;
		} finally {
			if (fd !== undefined) fs.closeSync(fd);
		}
	}

	function watch(t: Task, re: RegExp | undefined, timeoutSec: number | undefined, ownsTask: boolean) {
		// A command the monitor started is read from the start; an attached task from now on.
		const offset = ownsTask ? 0 : (fs.statSync(t.out, { throwIfNoEntry: false })?.size ?? 0);
		const w: Watch = {
			re,
			match: re && lineMatcher(re),
			owns: ownsTask,
			pending: [],
			skipped: 0,
			skippedBytes: 0,
			resync: offset > 0, // an attached watch may start inside a key block
			partial: offset > 0 && !atLineStart(t.out, offset),
			inKey: false,
			matches: 0,
			notices: 0,
			offset,
			carry: "",
			decoder: new StringDecoder("utf8"),
			poll: setInterval(() => readNew(t, w, false), POLL_MS),
		};
		t.watch = w;
		if (timeoutSec) {
			w.until = setTimeout(() => {
				if (ownsTask) return stop(t, `monitor timed out after ${timeoutSec}s`);
				readNew(t, w, true);
				const left = endWatch(t);
				notify(`Monitor ${t.id} timed out after ${timeoutSec}s (${w.matches} lines matched); the task keeps running.${left.length ? `\n${left.join("\n")}` : ""}`);
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
		let failed: string | undefined;
		if (t.watch) {
			readNew(t, t.watch, true);
			matched = t.watch.matches;
			failed = t.watch.failed;
			left = endWatch(t);
		}
		// bash has exited, but what it started in the background may still run in its group.
		const leftover = !groupGone(t);
		// Leftovers keep writing to the output file, so the log cap runs until the group is gone.
		if (leftover) {
			t.reap = setInterval(() => {
				if (groupGone(t)) {
					clearInterval(t.reap);
					clearInterval(t.cap);
				}
			}, 1000).unref();
		} else clearInterval(t.cap);
		footer();
		for (const old of evictable([...tasks.values()], KEEP_FINISHED)) tasks.delete(old.id);
		if (t.quiet) return wake?.();
		const status = t.reason ? `${t.reason} (${signal ?? `code ${code}`})` : signal ? `killed by ${signal}` : `exited with code ${code}`;
		let text = `Background shell ${t.id} ${status} after ${duration(t.ended - t.started)}: \`${clip(t.command)}\`\nOutput: ${t.out}`;
		if (leftover && !t.reason) {
			const n = groupSize(t.pid); // 0: emptied since the check; undefined: no pgrep
			if (n !== 0) text += `\n${n ? `${n} process${n === 1 ? " is" : "es are"}` : "Processes are"} still running in its group; shell_stop ${t.id} kills them.`;
		}
		if (failed) text += `\nMonitor ended early: ${failed}.`;
		if (left.length) text += `\nUndelivered monitor lines:\n${left.join("\n")}`;
		if (matched !== undefined) text += `\nMonitor total: ${matched} matching line${matched === 1 ? "" : "s"}.`;
		else {
			let tail = "";
			try {
				const size = fs.statSync(t.out).size;
				const fd = fs.openSync(t.out, "r");
				const buf = Buffer.alloc(Math.min(size, TAIL_BYTES));
				fs.readSync(fd, buf, 0, buf.length, size - buf.length);
				fs.closeSync(fd);
				tail = lastLines(buf.toString("utf8"), 10, buf.length === size).join("\n");
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
		child.on("error", (e) => fs.appendFileSync(out, `\n[pi-kit] ${e.message}\n`)); // before any throw: an unhandled error would crash pi
		if (child.pid === undefined) throw new Error(`could not start bash for ${id}`);
		const t: Task = { id, command, cwd, out, child, pid: child.pid, started: Date.now() };
		tasks.set(id, t);
		child.on("exit", (code, signal) => onExit(t, code, signal));
		if (timeoutSec) t.timer = setTimeout(() => stop(t, `timed out after ${timeoutSec}s`), timeoutSec * 1000);
		t.cap = setInterval(() => {
			if ((fs.statSync(out, { throwIfNoEntry: false })?.size ?? 0) > LOG_CAP) stop(t, `killed: output file passed ${Math.round(LOG_CAP / 2 ** 20)} MiB`);
		}, 1000).unref();
		footer();
		return t;
	}

	function describe(t: Task): string {
		const state =
			t.ended === undefined
				? `running ${duration(Date.now() - t.started)}`
				: (t.reason ?? (t.signal ? `killed by ${t.signal}` : `exit ${t.code}`)) + (groupGone(t) ? "" : ", processes left in its group");
		const w = t.watch ? `, watching ${t.watch.re ? `/${t.watch.re.source}/` : "all lines"} (${t.watch.matches} matched)` : "";
		return `${t.id}  ${state}${w}  \`${clip(t.command)}\`  ${t.out}`;
	}

	function listText(): string {
		const all = [...tasks.values()].map(describe);
		for (const w of wakes.values()) all.push(`${w.id}  wakes in ${duration(w.due - Date.now())}: ${clip(w.prompt)}`);
		return all.length ? all.join("\n") : "No background shells or timers in this session.";
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
				if (t.watch) throw new Error(`${t.id} already has a monitor. End it first with shell_stop ${t.id} watch_only, then start the new one.`);
			}
			watch(t, re, p.timeout, !!p.command);
			return text(`Monitoring ${t.id} for ${re ? `/${re.source}/` : "every line"}.\nOutput: ${t.out}\nMatching lines arrive as notices; stop with shell_stop.`);
		},
	});

	pi.registerTool({
		name: "wake_later",
		label: "Wake later",
		description: `Wake this session once after \`seconds\` (clamped to ${WAKE_MIN}-${WAKE_MAX}; headless sessions at most ${HEADLESS_DRAIN_MS / 1000}) with \`prompt\` as a notice. Only for checks no shell command can observe; when the check is a command, use monitor or bash_bg instead. Cancel with shell_stop.`,
		parameters: Type.Object({
			seconds: Type.Number({ description: `Delay in seconds (${WAKE_MIN}-${WAKE_MAX})` }),
			prompt: Type.String({ description: "What to do when it fires; written for your future self" }),
		}),
		async execute(_id, p, _signal, _onUpdate, ctx) {
			ui = ctx.ui;
			// Headless sessions wait at most HEADLESS_DRAIN_MS for a notice, so a later timer would never fire.
			const max = ctx.hasUI ? WAKE_MAX : Math.min(WAKE_MAX, HEADLESS_DRAIN_MS / 1000);
			const sec = Math.min(max, Math.max(WAKE_MIN, Math.round(p.seconds)));
			const id = `wk${++seq}`;
			const timer = setTimeout(() => {
				wakes.delete(id);
				footer();
				notify(`Wake-up ${id} after ${duration(sec * 1000)}: ${p.prompt}`);
			}, sec * 1000);
			wakes.set(id, { id, prompt: p.prompt, due: Date.now() + sec * 1000, timer });
			footer();
			return text(`Timer ${id} wakes this session in ${sec}s${sec !== p.seconds ? ` (clamped from ${p.seconds})` : ""}. Cancel with shell_stop.`);
		},
	});

	pi.registerTool({
		name: "shell_stop",
		label: "Stop shell",
		description:
			"Stop a background task: kill its whole process group (SIGTERM, then SIGKILL after 2s), including processes left in the group of a task that has exited. With watch_only, end only the monitor on it and leave the task running. A wake_later id cancels that timer.",
		parameters: Type.Object({
			id: Type.String({ description: "Task id (sh1) or timer id (wk2)" }),
			watch_only: Type.Optional(Type.Boolean({ description: "End only the monitor; keep the task running" })),
		}),
		async execute(_id, p) {
			const wk = wakes.get(p.id);
			if (wk) {
				clearTimeout(wk.timer);
				wakes.delete(p.id);
				footer();
				return text(`Cancelled timer ${p.id}.`);
			}
			const t = tasks.get(p.id);
			if (!t) throw new Error(`No task ${p.id}. Known: ${[...tasks.keys()].join(", ") || "none"}`);
			if (p.watch_only) {
				if (t.watch) readNew(t, t.watch, true);
				const left = endWatch(t);
				return text(`Stopped watching ${t.id}; it keeps running.${left.length ? `\nUndelivered lines:\n${left.join("\n")}` : ""}`);
			}
			// End the watch first, so no monitor notice arrives after the stop.
			if (t.watch) readNew(t, t.watch, true);
			const left = endWatch(t);
			const undelivered = left.length ? `\nUndelivered monitor lines:\n${left.join("\n")}` : "";
			if (t.ended !== undefined) {
				if (groupGone(t)) return text(`${t.id} already finished: ${describe(t)}`);
				stop(t, "stopped");
				for (let i = 0; i < 30 && !groupGone(t); i++) await new Promise((r) => setTimeout(r, 100));
				return text(groupGone(t) ? `Killed the processes left in ${t.id}'s group.` : `Sent SIGTERM to the processes left in ${t.id}'s group; SIGKILL follows.`);
			}
			t.quiet = true;
			stop(t, "stopped");
			await new Promise<void>((resolve) => {
				const deadline = setTimeout(resolve, 3000);
				t.child.once("exit", () => {
					clearTimeout(deadline);
					resolve();
				});
			});
			return text((t.ended !== undefined ? `Stopped ${t.id} (${t.signal ?? `code ${t.code}`}). Output: ${t.out}` : `Sent SIGTERM to ${t.id}; SIGKILL follows.`) + undelivered);
		},
	});

	pi.registerTool({
		name: "shell_list",
		label: "List shells",
		description: "List this session's background tasks (running and recently finished) with state, watch and output path, and pending wake_later timers.",
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

	// Headless (print/json, subagent children): pi would exit with tasks or timers pending, so wait
	// for the next notice (it starts a follow-up run) or for all of them to end.
	pi.on("agent_end", async (_e, ctx) => {
		if (ctx.hasUI || noticesThisRun > 0 || busy() === 0) return;
		const deadline = Date.now() + HEADLESS_DRAIN_MS;
		while (busy() > 0 && noticesThisRun === 0 && Date.now() < deadline) {
			await new Promise<void>((resolve) => {
				wake = resolve;
				setTimeout(resolve, 1000).unref();
			});
			wake = undefined;
		}
		if (busy() > 0 && noticesThisRun === 0) {
			const killed = [...running().map((t) => `${t.id} \`${clip(t.command)}\``), ...[...wakes.keys()].map((id) => `timer ${id}`)];
			for (const w of wakes.values()) clearTimeout(w.timer);
			wakes.clear();
			for (const t of running()) {
				t.quiet = true;
				stop(t, "killed: headless session ended");
			}
			notify(`Background shells: no notice for ${duration(HEADLESS_DRAIN_MS)}, so the headless session killed what was left: ${killed.join(", ")}.`);
		}
	});

	const killAll = () => {
		for (const t of tasks.values()) killGroup(t, "SIGKILL");
	};
	process.on("exit", killAll);

	pi.on("session_shutdown", async () => {
		if (closed) return;
		closed = true;
		for (const w of wakes.values()) clearTimeout(w.timer);
		wakes.clear();
		for (const t of tasks.values()) {
			endWatch(t);
			clearTimeout(t.timer);
			clearInterval(t.cap);
			clearInterval(t.reap);
			killGroup(t, "SIGTERM"); // also leftovers of finished tasks still in their group
		}
		if ([...tasks.values()].some((t) => !groupGone(t))) await new Promise((r) => setTimeout(r, 500));
		killAll();
		process.off("exit", killAll);
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
		try {
			ui?.setStatus("shell", undefined);
		} catch {}
	});
}
