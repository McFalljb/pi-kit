/**
 * pi-desk control for the Home agent: tools to read pi-desk's state, run any pi-desk command,
 * prompt and wait for other pi tabs, and short notices about other sessions. Per pi-desk's
 * docs/PROTOCOL.md (§2 handshake, §3 commands, confirmation, events). Inert unless PI_DESK_SOCKET
 * and PI_DESK_CONTROL_TOKEN are set and pi runs in the interactive TUI.
 *
 * - Connects as caller `control` with PI_DESK_CONTROL_TOKEN, reconnects with backoff. A single-use
 *   env token is swapped for the hello result's `reconnect_token` (kept in memory, see envToken);
 *   the variable is removed from process.env so shell commands and children do not inherit it.
 * - After each handshake: subscribes to events, reads the pi tabs' statuses, and asks for
 *   `list_commands` (proposed; COMMANDS in commands.ts when pi-desk does not answer it) to
 *   generate desk_run's description.
 * - desk_run waits for long-running commands (`finished`) and, when a command needs the user's
 *   confirmation, for the user's confirmed resend or the confirmation's disappearance.
 * - Notices: another pi tab turning waiting, error, question or finished is queued and delivered
 *   as one short message when this pi is idle (coalesced over 10 s, latest per tab, at most one
 *   notice-triggered turn a minute). pi-desk never sends a caller its own events; Home's own tabs
 *   and tabs a desk_prompt/desk_wait call is waiting on are skipped too.
 * - Home's own tabs (the control hello's `tab_id`, and the bridge's tab via `kit:desk:tab`) are
 *   never targeted: desk_run, desk_prompt and desk_wait refuse them; desk_run also refuses
 *   send_text into a pi tab or a tab waiting for the user (see refusal in state.ts).
 *
 * Never throws into pi: socket and protocol errors end the connection, which is retried.
 */

import net from "node:net";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { backoff, envToken, keepToken, line, parse } from "../desk-bridge/protocol.ts";
import { type Cmd, COMMANDS, confirmedBy, parkedFor, parseCommands, runDescription } from "./commands.ts";
import { filterState, findTab, type Notice, noticeDelay, noticeFor, noticeText, piTabOf, refusal, type Seen, seenFrom, stateText, tabLine } from "./state.ts";

const ENV = "PI_DESK_CONTROL_TOKEN";
const HELLO_TIMEOUT_MS = 5000;
const WAIT_S = 600; // default wait for long-running commands, confirmations and idle tabs
const MAX_WAIT_S = 3600;
type R = Record<string, any>;
const text = (s: string) => ({ content: [{ type: "text" as const, text: s }], details: undefined });
const seconds = (s: unknown) => Math.min(MAX_WAIT_S, Math.max(1, Number(s) || WAIT_S));

export default function (pi: ExtensionAPI) {
	let ctx: ExtensionContext | undefined; // set while active
	let sock: net.Socket | undefined;
	let ready = false; // handshake done on the current connection
	let closed = false;
	let attempt = 0;
	let retry: NodeJS.Timeout | undefined;
	let seq = 0;
	const replies = new Map<string, { resolve: (m: R) => void; reject: (e: Error) => void }>();
	const ours = new Set<number>(); // request_ids of our pending commands
	const finished = new Map<number, (r: R) => void>(); // request_id -> waiter
	const early = new Map<number, R>(); // finished before anyone waited for it
	const listeners = new Set<(ev: R) => void>(); // command events, for confirmation waits
	const waits = new Set<(r: R) => void>(); // every wait in progress, ended when the connection closes
	let seen = new Map<number, Seen>();
	let queued: Notice[] = [];
	let noticeTimer: NodeJS.Timeout | undefined;
	let lastNotice: number | undefined; // when the last notice message went out
	let controlTab = 0; // Home's tab, from the control hello (0: none)
	let bridgeTab = 0; // Home's tab, from its desk bridge
	const own = () => new Set([controlTab, bridgeTab].filter((t) => t > 0));
	const skipped = () => new Set([...own(), ...watching.keys()]);
	const rechecks = new Set<() => void>(); // confirmation waits: look at the state again
	const watching = new Map<number, number>(); // tab -> tool calls waiting on it
	let described = ""; // desk_run's current description

	function request(msg: R): Promise<R> {
		if (!sock || !ready || sock.destroyed) return Promise.reject(new Error("Not connected to pi-desk (it reconnects on its own; try again shortly)."));
		const id = `h${++seq}`;
		const s = sock;
		return new Promise((resolve, reject) => {
			replies.set(id, { resolve, reject });
			s.write(line({ id, ...msg }));
		});
	}
	const command = (cmd: R) => request({ type: "command", command: cmd });
	async function getState(): Promise<any> {
		const r = (await command({ type: "get_state" })).result;
		if (!r?.ok) throw new Error(`pi-desk: ${r?.error ?? "no state"}`);
		return r.data;
	}

	/** Resolves with a result object: `setup`'s, or an error one on timeout, abort or a closed connection. */
	function wait(ms: number, signal: AbortSignal | undefined, onTimeout: string, setup: (done: (r: R) => void) => (() => void) | void): Promise<R> {
		if (signal?.aborted) return Promise.resolve({ ok: false, error: "cancelled" });
		return new Promise((resolve) => {
			let cleanup: (() => void) | void;
			const done = (r: R) => {
				if (!waits.delete(done)) return;
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				cleanup?.();
				resolve(r);
			};
			const abort = () => done({ ok: false, error: "cancelled" });
			const timer = setTimeout(() => done({ ok: false, error: onTimeout }), ms);
			waits.add(done);
			signal?.addEventListener("abort", abort, { once: true });
			cleanup = setup(done);
			if (!waits.has(done)) cleanup?.();
		});
	}

	/** A command's result; for a long-running one, the result of its `finished` event. */
	async function run(cmd: R, ms: number, signal?: AbortSignal): Promise<{ result: R; waited: boolean }> {
		const r = await command(cmd);
		const res: R = r.result ?? { ok: false, error: "no result" };
		const rid = r.request_id;
		if (!res.pending || typeof rid !== "number") return { result: res, waited: false };
		const result = await wait(ms, signal, `still running in pi-desk after ${ms / 1000}s`, (done) => {
			if (early.has(rid)) return done(early.get(rid)!);
			finished.set(rid, done);
		});
		finished.delete(rid);
		early.delete(rid);
		ours.delete(rid);
		return { result, waited: true };
	}

	/**
	 * After `needs_confirmation` by the user: the user's confirmed run of the parked command, or the
	 * confirmation gone from the state (checked at the start, on the user's and pi-desk's own
	 * events, and after a `dropped` event stream).
	 */
	function confirmation(cmd: R, ms: number, signal?: AbortSignal): Promise<R> {
		const timeout = `the user has not answered in pi-desk after ${ms / 1000}s; the confirmation stays pending there. Do not resend; check desk_state later`;
		return wait(ms, signal, timeout, (done) => {
			let parked: R = cmd; // pi-desk's own copy once seen: the fields to match
			const check = () =>
				void getState()
					.then((st) => {
						const p = parkedFor(st, cmd);
						if (p) parked = p;
						else done({ ok: false, outcome: "the confirmation is no longer pending in pi-desk and no confirmed run was seen (most likely cancelled); check desk_state, do not resend" });
					})
					.catch(() => {});
			const listen = (ev: R) => {
				if (confirmedBy(ev, parked)) return done({ ok: ev.result?.ok === true, outcome: "the user confirmed it in pi-desk", result: ev.result });
				if (ev.caller === "ui" || ev.caller === "internal") check();
			};
			listeners.add(listen);
			rechecks.add(check);
			check();
			return () => {
				listeners.delete(listen);
				rechecks.delete(check);
			};
		});
	}

	function onEvent(m: R) {
		if (m.event === "finished") {
			if (!ours.has(m.request_id)) return;
			const f = finished.get(m.request_id);
			if (f) f(m.result ?? {});
			else early.set(m.request_id, m.result ?? {});
			return;
		}
		if (m.event === "dropped") {
			// Fell behind: subscribe again, re-read statuses, and re-check confirmations whose outcome event may be lost.
			// `finished` events go to the requester whether subscribed or not, so long-running waits keep waiting.
			return void setup().then(() => rechecks.forEach((check) => check()));
		}
		if (m.event !== "command") return;
		for (const l of [...listeners]) l(m);
		const n = noticeFor(m, seen);
		if (n && !skipped().has(n.tab)) {
			queued.push(n);
			scheduleNotices();
		}
	}

	function scheduleNotices() {
		if (queued.length && ctx && !closed && ctx.isIdle()) noticeTimer ??= setTimeout(flushNotices, noticeDelay(Date.now(), lastNotice));
	}
	async function flushNotices() {
		noticeTimer = undefined;
		if (!ctx || closed || !queued.length || !ctx.isIdle()) return; // agent_settled tries again
		const batch = queued;
		queued = [];
		let state: any;
		try {
			state = await getState();
		} catch {}
		if (!ctx || closed) return;
		if (!ctx.isIdle()) return void (queued = [...batch, ...queued]);
		const msg = noticeText(batch, state, skipped());
		if (!msg) return;
		lastNotice = Date.now();
		try {
			pi.sendMessage({ customType: "kit-desk", content: msg, display: true, details: undefined }, { triggerTurn: true, deliverAs: "followUp" });
		} catch {}
	}

	async function setup() {
		try {
			await request({ type: "subscribe" });
			seen = seenFrom(await getState());
			const listed = (await command({ type: "list_commands" })).result;
			setCommands((listed?.ok && parseCommands(listed.data)) || COMMANDS);
		} catch {}
	}

	function connect() {
		retry = undefined;
		if (closed) return;
		const s = net.createConnection(process.env.PI_DESK_SOCKET!);
		sock = s;
		const helloId = `h${++seq}`;
		let buf = "";
		const helloTimer = setTimeout(() => s.destroy(), HELLO_TIMEOUT_MS);
		s.setEncoding("utf8");
		s.on("connect", () => s.write(line({ id: helloId, type: "hello", token: envToken(ENV) })));
		s.on("data", (chunk: string) => {
			buf += chunk;
			let nl: number;
			while ((nl = buf.indexOf("\n")) >= 0) {
				const m = parse(buf.slice(0, nl));
				buf = buf.slice(nl + 1);
				if (!m) continue;
				// pi-desk revoked the env token on this hello: keep the reconnect token even if this runtime closed meanwhile.
				const helloOk = !ready && m.id === helloId && m.result?.ok === true;
				if (helloOk) keepToken(ENV, m.result.data?.reconnect_token);
				if (sock !== s || closed) continue;
				try {
					if (!ready) {
						if (m.id !== helloId) continue;
						clearTimeout(helloTimer);
						if (!helloOk) return void s.destroy(); // wrong token or version: retried with backoff
						controlTab = Number(m.result.data?.tab_id) || 0;
						ready = true;
						attempt = 0;
						void setup();
					} else if (m.type === "result") {
						if (m.result?.pending && typeof m.request_id === "number") ours.add(m.request_id);
						replies.get(m.id)?.resolve(m);
						replies.delete(m.id);
					} else if (m.type === "event") onEvent(m);
				} catch {}
			}
		});
		s.on("error", () => {}); // "close" follows
		s.on("close", () => {
			clearTimeout(helloTimer);
			if (sock !== s) return;
			sock = undefined;
			ready = false;
			for (const r of replies.values()) r.reject(new Error("The pi-desk connection closed before the reply; check desk_state."));
			replies.clear();
			for (const done of [...waits]) done({ ok: false, error: "the pi-desk connection closed before the result; check desk_state" });
			finished.clear();
			early.clear();
			ours.clear();
			if (!closed) retry = setTimeout(connect, backoff(attempt++));
		});
	}

	/** The pi tab to prompt or wait for: `tab_id`, or the pi tab of open session `session`. */
	async function piTab(p: { tab_id?: number; session?: number }): Promise<number> {
		if (typeof p.tab_id === "number") return p.tab_id;
		if (typeof p.session !== "number") throw new Error("Give tab_id or session.");
		const tab = piTabOf(await getState(), p.session);
		if (tab === undefined) throw new Error(`Open session ${p.session} has no pi tab (desk_state lists them).`);
		return tab;
	}
	/** piTab, refusing Home's own tab. */
	async function otherPiTab(p: { tab_id?: number; session?: number }): Promise<number> {
		const tab = await piTab(p);
		const why = refusal({ tab_id: tab }, undefined, own());
		if (why) throw new Error(why);
		return tab;
	}
	async function tabStatus(tab: number): Promise<string> {
		try {
			const w = findTab(await getState(), tab);
			return w ? `${tabLine(w.tab)} (session ${w.session.id})` : `tab ${tab} is no longer open`;
		} catch (e) {
			return (e as Error).message;
		}
	}
	/** Run `fn` with notices about `tab` muted: the caller is already waiting on it. */
	async function watch<T>(tab: number, fn: () => Promise<T>): Promise<T> {
		watching.set(tab, (watching.get(tab) ?? 0) + 1);
		try {
			return await fn();
		} finally {
			const n = (watching.get(tab) ?? 1) - 1;
			if (n > 0) watching.set(tab, n);
			else watching.delete(tab);
			queued = queued.filter((q) => q.tab !== tab);
		}
	}
	async function waitIdle(tab: number, sec: number, signal?: AbortSignal): Promise<string> {
		const { result } = await run({ type: "pi_wait_idle", tab_id: tab, timeout_ms: sec * 1000 }, sec * 1000 + 5000, signal);
		return `${result.ok ? `Tab ${tab} is idle.` : `Tab ${tab} is not idle: ${result.error ?? "unknown"}.`}\n${await tabStatus(tab)}`;
	}

	const target = {
		tab_id: Type.Optional(Type.Number({ description: "The pi tab's id (desk_state)" })),
		session: Type.Optional(Type.Number({ description: "Or an open session id: its pi tab" })),
	};
	const timeout_s = Type.Optional(Type.Number({ description: `Seconds to wait (default ${WAIT_S}, max ${MAX_WAIT_S})` }));

	function registerRun(desc: string) {
		described = desc;
		pi.registerTool({
			name: "desk_run",
			label: "pi-desk command",
			description: desc,
			promptSnippet: "Run any pi-desk command (projects, sessions, tabs, layout); waits for confirmations and long commands",
			promptGuidelines: [
				"Use desk_run for anything the user could do in pi-desk's window; read ids from desk_state first.",
				"When desk_run says a command needs the user's confirmation, tell the user and let them confirm in pi-desk; never resend it to get around that.",
			],
			parameters: Type.Object({
				command: Type.Object({ type: Type.String({ description: "The command type, e.g. new_chat" }) }, { additionalProperties: true, description: "{type, ...fields}" }),
				timeout_s,
			}),
			async execute(_id, p, signal, onUpdate) {
				const cmd = p.command as R;
				if (typeof cmd?.type !== "string" || !cmd.type) throw new Error("command.type is required.");
				const why = refusal(cmd, cmd.type === "send_text" ? await getState() : undefined, own());
				if (why) throw new Error(why);
				const ms = seconds(p.timeout_s) * 1000;
				const { result, waited } = await run(cmd, ms, signal);
				const nc = result.needs_confirmation;
				if (result.error !== "needs_confirmation" || !nc) return text(`${waited ? "Finished: " : ""}${JSON.stringify(result)}`);
				if (nc.by === "caller")
					return text(`${JSON.stringify(result)}\nThe user lets this caller confirm this kind of command itself. Resend the same command with "confirm": "<token>" only if the user asked for exactly this; otherwise send cancel_confirmation with the token.`);
				onUpdate?.({ content: [{ type: "text", text: `Waiting for the user to confirm in pi-desk: ${nc.summary ?? cmd.type}` }], details: undefined });
				const out = await confirmation(cmd, ms, signal);
				return text(`Needed the user's confirmation in pi-desk (${nc.summary ?? cmd.type}): ${out.outcome ?? out.error}.${out.result ? ` Result: ${JSON.stringify(out.result)}` : ""}`);
			},
		});
	}
	function setCommands(list: Cmd[]) {
		const desc = runDescription(list);
		if (desc !== described && ctx && !closed) registerRun(desc);
	}

	function registerTools() {
		pi.registerTool({
			name: "desk_state",
			label: "pi-desk state",
			description:
				"Read pi-desk's state: projects, open sessions with their tabs (pi tabs with agent status, waiting/question, blockers and panels; shell tabs), the selected project's saved pi sessions, and confirmations waiting for the user. A compact summary by default; `full: true` returns the raw JSON snapshot. Filter by `project` (id, or a piece of its name or path) and `session` (open session id).",
			promptSnippet: "Read pi-desk's projects, sessions, tabs and their status",
			promptGuidelines: ["Before acting on a pi-desk project, session or tab, read its id from desk_state; ids never change while pi-desk runs."],
			parameters: Type.Object({
				full: Type.Optional(Type.Boolean({ description: "Raw JSON snapshot instead of the summary" })),
				project: Type.Optional(Type.Union([Type.Number(), Type.String()], { description: "Project id, or a piece of its name or path" })),
				session: Type.Optional(Type.Number({ description: "Open session id" })),
			}),
			async execute(_id, p) {
				const st = filterState(await getState(), { project: p.project, session: p.session });
				return text(stateText(st, !!p.full));
			},
		});

		registerRun(runDescription(COMMANDS));

		pi.registerTool({
			name: "desk_prompt",
			label: "Prompt a pi tab",
			description: `Send a prompt to another pi session in pi-desk (its pi tab, by tab_id or open session id), as a user message there. With wait: true, also wait until that pi is idle (nothing running or queued) and return its status; otherwise return at once. Refused while that pi has a dialog open (it is waiting for the user). You cannot prompt your own tab.`,
			promptSnippet: "Send a prompt to another pi session in pi-desk, optionally waiting until it is idle",
			parameters: Type.Object({ ...target, text: Type.String({ description: "The prompt" }), wait: Type.Optional(Type.Boolean({ description: "Wait until it is idle" })), timeout_s }),
			async execute(_id, p, signal) {
				const tab = await otherPiTab(p);
				const go = async () => {
					const { result } = await run({ type: "pi_prompt", tab_id: tab, text: p.text }, 60_000, signal);
					if (!result.ok) throw new Error(`pi-desk did not deliver the prompt to tab ${tab}: ${result.error ?? "unknown"}`);
					return p.wait ? `Prompt delivered. ${await waitIdle(tab, seconds(p.timeout_s), signal)}` : `Prompt delivered to tab ${tab}. ${await tabStatus(tab)}`;
				};
				return text(p.wait ? await watch(tab, go) : await go());
			},
		});

		pi.registerTool({
			name: "desk_wait",
			label: "Wait for a pi tab",
			description: "Wait until another pi session in pi-desk is idle (no run, nothing queued, no background shells or workers), then return its status, or say it is still busy at the timeout.",
			promptSnippet: "Wait until another pi session in pi-desk is idle",
			parameters: Type.Object({ ...target, timeout_s }),
			async execute(_id, p, signal) {
				const tab = await otherPiTab(p);
				return text(await watch(tab, () => waitIdle(tab, seconds(p.timeout_s), signal)));
			},
		});
	}

	pi.on("session_start", (_e, c) => {
		if (c.mode !== "tui" || !process.env.PI_DESK_SOCKET || !envToken(ENV, true)) return;
		ctx = c;
		registerTools();
		connect();
	});
	pi.on("agent_settled", () => scheduleNotices());
	pi.events.on("kit:desk:tab", (id) => void (bridgeTab = Number(id) || 0));
	pi.on("session_shutdown", () => {
		if (closed || !ctx) return;
		closed = true;
		clearTimeout(retry);
		clearTimeout(noticeTimer);
		sock?.end();
		ctx = undefined;
	});
}
