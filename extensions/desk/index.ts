/**
 * pi-desk control for the Home agent: tools to read pi-desk's state and recent notifications, run
 * any pi-desk command, prompt and wait for other pi tabs, and watch one on the user's request. Per
 * pi-desk's docs/PROTOCOL.md (§2 handshake, §3 commands, confirmation, events). Inert unless PI_DESK_SOCKET
 * and PI_DESK_CONTROL_TOKEN are set and pi runs in the interactive TUI.
 *
 * - Connects as caller `control` with PI_DESK_CONTROL_TOKEN, reconnects with backoff. A single-use
 *   env token is swapped for the hello result's `reconnect_token` (kept in memory, see envToken);
 *   the variable is removed from process.env so shell commands and children do not inherit it.
 * - After each handshake: subscribes to events, reads the pi tabs' statuses, and asks for
 *   `list_commands` (proposed; COMMANDS in commands.ts when pi-desk does not answer it) to
 *   generate desk_run's description and to see whether desk_events' `notifications_list` exists.
 * - desk_run waits for long-running commands (`finished`) and, when a command needs the user's
 *   confirmation, for the user's confirmed resend or the confirmation's disappearance.
 * - No automatic notices: other sessions' status changes never reach the agent on their own (the
 *   user sees them in pi-desk's notification bell). desk_watch arms a one-shot watch on a tab the
 *   user asked about (at most MAX_WATCHES): its first matching change (from pi.status events, or a
 *   fresh state after a reconnect, a dropped stream or another command event, for exits) sends one
 *   message that starts a turn, and ends the watch. desk_events reads pi-desk's notifications on
 *   demand.
 * - Home's own tabs (the control hello's `tab_id`, and the bridge's tab via `kit:desk:tab`) are
 *   never targeted: desk_run, desk_prompt, desk_wait and desk_watch refuse them; desk_run also refuses
 *   send_text into a pi tab or a tab waiting for the user (see refusal in state.ts).
 *
 * Never throws into pi: socket and protocol errors end the connection, which is retried.
 */

import net from "node:net";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { backoff, envToken, keepToken, line, parse } from "../desk-bridge/protocol.ts";
import { type Cmd, COMMANDS, confirmedBy, parkedFor, parseCommands, runDescription } from "./commands.ts";
import { eventsText, exited, filterState, findTab, fires, type Notice, noticeFor, type On, piTabOf, refusal, type Seen, seenFrom, seenOf, stateText, tabLabel, tabLine, WATCH_ON, watchHits, watchText } from "./state.ts";

const ENV = "PI_DESK_CONTROL_TOKEN";
const HELLO_TIMEOUT_MS = 5000;
const WAIT_S = 600; // default wait for long-running commands, confirmations and idle tabs
const MAX_WAIT_S = 3600;
const MAX_WATCHES = 5;
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
	const watches = new Map<number, { on: On[]; label: string }>(); // desk_watch: tab -> what it waits for, its label
	let checking: Promise<void> | undefined; // a watch check against a fresh state in flight
	let checkAgain = false;
	let hasNotifications = false; // pi-desk listed notifications_list
	let controlTab = 0; // Home's tab, from the control hello (0: none)
	let bridgeTab = 0; // Home's tab, from its desk bridge
	const own = () => new Set([controlTab, bridgeTab].filter((t) => t > 0));
	const rechecks = new Set<() => void>(); // confirmation waits: look at the state again
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
		const w = n && watches.get(n.tab);
		if (n && w && fires(w.on, n.kind)) return fire([n]);
		// A tab may have exited or closed: pi-desk's own events, a bridge gone, any other command.
		const type = String(m.command?.type ?? "");
		if (watches.size && (m.caller === "internal" || (type !== "pi.status" && !type.startsWith("panel.")))) void checkWatches();
	}

	/** End the fired watches and tell the agent, one message each; starts a turn (after the current run, if any). */
	function fire(hits: Notice[]) {
		for (const h of hits) {
			const w = watches.get(h.tab);
			if (!w || !ctx || closed) continue;
			watches.delete(h.tab);
			try {
				pi.sendMessage({ customType: "kit-desk", content: watchText(h, w.label), display: true, details: undefined }, { triggerTurn: true, deliverAs: "followUp" });
			} catch {}
		}
	}

	/** Compare the watched tabs with a fresh state (one check at a time; a request meanwhile runs one more). */
	function checkWatches(): Promise<void> {
		if (checking) {
			checkAgain = true;
			return checking;
		}
		checking = (async () => {
			do {
				checkAgain = false;
				try {
					fire(watchHits(await getState(), seen, watches));
				} catch {}
			} while (checkAgain && watches.size);
		})().finally(() => (checking = undefined));
		return checking;
	}

	async function setup() {
		try {
			await request({ type: "subscribe" });
			const st = await getState();
			const hits = watchHits(st, seen, watches); // changes missed while disconnected
			seen = seenFrom(st);
			fire(hits);
			const listed = (await command({ type: "list_commands" })).result;
			const list: Cmd[] = (listed?.ok && parseCommands(listed.data)) || COMMANDS;
			hasNotifications = list.some((c) => c.type === "notifications_list");
			setCommands(list);
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
				return text(await go());
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
				return text(await waitIdle(tab, seconds(p.timeout_s), signal));
			},
		});

		pi.registerTool({
			name: "desk_watch",
			label: "Watch a pi-desk tab",
			description: `Only when the user asks to be told about another session: watch its tab (tab_id, or open session id) and get one message, which starts a turn, at the first matching change: "finished" (its run ended: idle, a question or an error), "needs_user" (a dialog is waiting or it asked a question), "exited" (the tab closed or its process ended). Default: all three; an error or an exit always fires. The watch ends when it fires. A new watch on the same tab replaces it; at most ${MAX_WATCHES} at once. cancel: true ends the watch on that tab (or all, without a target). With no target and no cancel, lists the watches. Watches end when this pi reloads or exits.`,
			promptSnippet: "Get told once when another pi-desk session finishes, needs the user or exits (only when the user asks)",
			promptGuidelines: [
				"Other sessions' status changes are not sent to you; the user sees them in pi-desk's notification bell. Use desk_watch only when the user asks to be told about a session, and desk_state or desk_events when they ask what happened.",
			],
			parameters: Type.Object({
				...target,
				on: Type.Optional(Type.Array(Type.Union(WATCH_ON.map((o) => Type.Literal(o))), { description: "What to wait for (default: all)" })),
				cancel: Type.Optional(Type.Boolean({ description: "End the watch on this tab (all watches without a target)" })),
			}),
			async execute(_id, p) {
				const targeted = typeof p.tab_id === "number" || typeof p.session === "number";
				if (!targeted) {
					if (p.cancel) {
						const n = watches.size;
						watches.clear();
						return text(n ? `Ended ${n} watch${n === 1 ? "" : "es"}.` : "No watches were set.");
					}
					if (!watches.size) return text("No watches are set.");
					return text(["Watches:", ...[...watches].map(([tab, w]) => `- tab ${tab}: ${w.on.join(", ")}`)].join("\n"));
				}
				const tab = await otherPiTab(p);
				if (p.cancel) return text(watches.delete(tab) ? `Stopped watching tab ${tab}.` : `Tab ${tab} was not watched.`);
				if (!watches.has(tab) && watches.size >= MAX_WATCHES) throw new Error(`At most ${MAX_WATCHES} watches at once; cancel one first (desk_watch with no target lists them).`);
				const st = await getState();
				if (exited(st, tab)) throw new Error(`Tab ${tab} is not open or not running (desk_state lists the tabs).`);
				const t = findTab(st, tab)!.tab;
				if (t.kind === "pi") seen.set(tab, seenOf(t)); // compare with its status from now on
				const on: On[] = p.on?.length ? [...new Set(p.on as On[])] : [...WATCH_ON];
				watches.set(tab, { on, label: tabLabel(st, tab) });
				return text(`Watching tab ${tab} (${on.join(", ")}): you get one message when it happens. Now: ${tabLine(t)} (session ${findTab(st, tab)!.session.id}).`);
			},
		});

		pi.registerTool({
			name: "desk_events",
			label: "pi-desk notifications",
			description: "Read pi-desk's recent notifications (the ones its bell shows: sessions finishing, waiting for the user, errors, exits), latest last. Use when the user asks what happened while they were away; desk_state shows the current status.",
			promptSnippet: "Read pi-desk's recent notifications (what happened in other sessions)",
			parameters: Type.Object({ limit: Type.Optional(Type.Number({ description: "How many of the latest to show (default 20)" })) }),
			async execute(_id, p) {
				if (!hasNotifications) return text("This pi-desk does not offer notifications_list, so recent events are unavailable; desk_state shows the current status of every session.");
				const r = (await command({ type: "notifications_list" })).result;
				if (!r?.ok) throw new Error(`pi-desk: ${r?.error ?? "no notifications"}`);
				return text(eventsText(r.data, p.limit));
			},
		});
	}

	pi.on("session_start", (_e, c) => {
		if (c.mode !== "tui" || !process.env.PI_DESK_SOCKET || !envToken(ENV, true)) return;
		ctx = c;
		registerTools();
		connect();
	});
	pi.events.on("kit:desk:tab", (id) => void (bridgeTab = Number(id) || 0));
	pi.on("session_shutdown", () => {
		if (closed || !ctx) return;
		closed = true;
		clearTimeout(retry);
		sock?.end();
		ctx = undefined;
	});
}
