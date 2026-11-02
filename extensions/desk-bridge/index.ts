/**
 * Bridge to pi-desk (the native app that runs pi in a terminal tab): the pi tab's control plane,
 * per pi-desk's docs/PROTOCOL.md §4. Inert unless PI_DESK_SOCKET and PI_DESK_TOKEN are set and pi
 * runs in the interactive TUI.
 *
 * - Connects to the socket, sends `hello`, reconnects with backoff if pi-desk goes away. The env
 *   token is single-use: pi-desk revokes it on the first hello and returns a reconnect token, kept
 *   in memory (see deskToken) for every later hello, also after a reload or session switch.
 * - Reports `pi.session` (id, file, cwd) after each handshake; a session switch or reload starts a
 *   new extension runtime, which connects again and reports the new session.
 * - Reports `pi.status {agent, waiting, question, blockers}` when it changes (see status() in protocol.ts).
 * - Tells other extensions its tab id (`kit:desk:tab`, after each handshake).
 * - If the hello result's `capabilities` include `panels`, publishes the sidebar's sections
 *   (subagents, shells, todos) as panels (`panel.set`, or `panel.remove` once a section empties),
 *   at most once a second and only when they changed. `kit:desk:mode` tells the sidebar whether
 *   pi-desk draws panels (after each handshake; false while the bridge has never connected).
 * - Answers `pi.prompt` (a user message, with `images` if given; follow-up while a run is going),
 *   `pi.wait_idle` (when pi is idle with nothing queued and no blockers, or a timeout) and
 *   `pi.reload` (refused unless that same idle holds: a reload kills the kit's background shells;
 *   the result comes after it).
 * - Holds pi-desk's pending comments (`pi.attach` replaces them, `pi.attach_clear` drops them, and
 *   so does a dropped connection) and adds them to the next message the user types in pi (the
 *   `input` hook: text after the user's, images after theirs; not a `/` command), then tells
 *   pi-desk `pi.attached {attachment_id}` so it clears them: at once for a message queued while pi
 *   works, once it starts (`message_start`) for one sent while idle.
 *   pi-desk sends them again (or clears them) after every handshake, so a reload loses nothing.
 * - Sends pi-desk commands for other extensions over this connection (caller `panel`: the pi
 *   tab's own session's browser tabs; extensions/desk-browser; only its command types,
 *   browserRefusal): `kit:desk:command`
 *   {requestId, command, timeoutMs?} on pi.events, answered on `kit:desk:command:reply:<requestId>`
 *   with {result} (a long command's `finished` result) or {error}; `kit:desk:command:cancel`
 *   {requestId} stops waiting and sends pi-desk a `cancel` line for a long command's request id
 *   (once that id is known); its late `finished` is dropped. Not connected: an error at once.
 *
 * Never throws into pi: socket and protocol errors end the connection, which is retried.
 */

import { randomUUID } from "node:crypto";
import net from "node:net";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Panel, type Run, type ShellRow, SUBAGENT_EVENTS } from "../sidebar/rows.ts";
import { Attacher, backoff, browserRefusal, busyReasons, cancelLine, COMMAND_EVENT, CommandCalls, type CommandOutcome, deskToken, keepReconnectToken, line, parse, parseAttach, promptContent, promptRefusal, reply, runOutcome, status, wireImages } from "./protocol.ts";

export { inDesk } from "./protocol.ts";

const HELLO_TIMEOUT_MS = 5000;
const IDLE_SETTLE_MS = 250; // wait_idle needs idle to hold this long (a shell's exit notice starts a run just after its rows clear)
const PANEL_EVERY_MS = 1000; // panel updates are coalesced to one per this
const RELOAD_COMMAND = "desk-reload";
const COMMAND_TIMEOUT_MS = 60_000; // a kit:desk:command without timeoutMs
const arr = (v: unknown) => (Array.isArray(v) ? v : []);

export default function (pi: ExtensionAPI) {
	let ctx: ExtensionContext | undefined; // set while active
	let sock: net.Socket | undefined;
	let ready = false; // handshake done on the current connection
	let panelsOn = false; // the current connection's pi-desk draws panels
	let connected = false; // a handshake has succeeded in this runtime
	let closed = false;
	let attempt = 0;
	let retry: NodeJS.Timeout | undefined;
	let seq = 0;
	let sent = ""; // the last pi.status sent on this connection
	let shells: ShellRow[] = [];
	let runs: Run[] = [];
	let dialogs = 0; // open pi dialogs (they can overlap)
	let compacting = false; // a manual /compact is running
	let error = false;
	let question = false;
	let subTimer: NodeJS.Timeout | undefined;
	let reloadId: unknown; // a pi.reload waiting for its result
	let panels: Panel[] = []; // the latest from the sidebar
	const panelSent = new Map<string, string>(); // panel -> the last panel.set/remove sent on this connection
	let panelTimer: NodeJS.Timeout | undefined;
	let idleTimer: NodeJS.Timeout | undefined;
	const waiters = new Map<unknown, NodeJS.Timeout | undefined>(); // pi.wait_idle id -> its timeout
	const attach = new Attacher(); // pi-desk's pending comments (pi.attach), for the next typed message
	const acks: (string | number)[] = []; // pi.attached not sent yet (no connection when the message started)
	// kit:desk:command calls in flight on this connection; a cancelled one is stopped in pi-desk too
	const calls = new CommandCalls((rid) => {
		if (sock && ready && !sock.destroyed && !closed) sock.write(cancelLine(`b${++seq}`, rid));
	});
	const callIds = new Map<string, string>(); // requestId -> our line id

	const send = (msg: Record<string, unknown>) => {
		if (sock && ready && !sock.destroyed) sock.write(line({ id: `b${++seq}`, ...msg }));
	};
	const answer = (id: unknown, result: { ok: boolean; error?: string }) => {
		if (sock && !sock.destroyed) sock.write(reply(id, result));
	};

	function current() {
		return status({ idle: ctx!.isIdle(), error, dialogs, question, shells, runs });
	}
	const notIdle = () => busyReasons(current(), ctx!.hasPendingMessages());

	/** Send pi.status if it changed; answer wait_idle requests once pi is idle. */
	function update() {
		if (!ctx || closed) return;
		try {
			const s = JSON.stringify(current());
			if (ready && s !== sent) {
				sent = s;
				send({ type: "pi.status", ...JSON.parse(s) });
			}
			if (waiters.size && !notIdle().length) idleTimer ??= setTimeout(answerIdle, IDLE_SETTLE_MS);
		} catch {}
	}
	function answerIdle() {
		idleTimer = undefined;
		try {
			if (!ctx || closed || notIdle().length) return; // the next update() checks again
			for (const [id, t] of waiters) clearTimeout(t), answer(id, { ok: true });
			waiters.clear();
		} catch {}
	}

	function flushPanels() {
		panelTimer = undefined;
		if (!ready || closed || !panelsOn) return;
		for (const p of panels) {
			const msg = p.rows.length ? { type: "panel.set", panel: p.panel, title: p.title, rows: p.rows } : { type: "panel.remove", panel: p.panel };
			const key = JSON.stringify(msg);
			if (panelSent.get(p.panel) === key) continue;
			panelSent.set(p.panel, key);
			send(msg);
		}
	}
	const panelsChanged = () => void (ready && panelsOn && !closed && (panelTimer ??= setTimeout(flushPanels, PANEL_EVERY_MS)));

	function flushAcks() {
		while (acks.length && ready && sock && !sock.destroyed) send({ type: "pi.attached", attachment_id: acks.shift() });
	}

	function sendSession() {
		const sm = ctx!.sessionManager;
		send({ type: "pi.session", pi_session_id: sm.getSessionId(), session_file: sm.getSessionFile() ?? "", cwd: ctx!.cwd });
	}

	function handle(m: Record<string, any>) {
		if (m.type === "result") return void calls.onResult(m); // our commands' (the rest: pi.session, pi.status…)
		if (m.type === "event" && m.event === "finished") return void calls.onFinished(m);
		if (m.id === undefined) return; // other events: none expected
		if (m.type === "pi.prompt") {
			if (typeof m.text !== "string" || !m.text.trim()) return answer(m.id, { ok: false, error: "text is required" });
			const images = wireImages(m.images);
			if (typeof images === "string") return answer(m.id, { ok: false, error: images });
			const refused = promptRefusal({ dialogs, compacting });
			if (refused) return answer(m.id, { ok: false, error: refused });
			pi.sendUserMessage(promptContent(m.text, images ?? []), ctx!.isIdle() ? undefined : { deliverAs: "followUp" });
			return answer(m.id, { ok: true });
		}
		if (m.type === "pi.attach") {
			const a = parseAttach(m);
			if (typeof a === "string") return answer(m.id, { ok: false, error: a });
			attach.set(a);
			return answer(m.id, { ok: true });
		}
		if (m.type === "pi.attach_clear") {
			attach.clear();
			return answer(m.id, { ok: true });
		}
		if (m.type === "pi.wait_idle") {
			const ms = Number(m.timeout_ms);
			const t = ms > 0 ? setTimeout(() => waiters.delete(m.id) && answer(m.id, { ok: false, error: "timeout" }), ms) : undefined;
			waiters.set(m.id, t);
			return update();
		}
		if (m.type === "pi.reload") {
			const why = notIdle();
			if (why.length) return answer(m.id, { ok: false, error: `not idle: ${why.join("; ")}` });
			if (reloadId !== undefined) return answer(m.id, { ok: false, error: "a reload is already running" });
			reloadId = m.id;
			// Reload is a command-context operation: run it through our command.
			pi.sendUserMessage(`/${RELOAD_COMMAND}`, { expandPromptTemplates: true });
			return;
		}
		answer(m.id, { ok: false, error: `unknown type ${String(m.type)}` });
	}

	function connect() {
		retry = undefined;
		if (closed) return;
		const s = net.createConnection(process.env.PI_DESK_SOCKET!);
		sock = s;
		const helloId = `b${++seq}`;
		let buf = "";
		const helloTimer = setTimeout(() => s.destroy(), HELLO_TIMEOUT_MS);
		s.setEncoding("utf8");
		s.on("connect", () => s.write(line({ id: helloId, type: "hello", token: deskToken() })));
		s.on("data", (chunk: string) => {
			buf += chunk;
			let nl: number;
			while ((nl = buf.indexOf("\n")) >= 0) {
				const m = parse(buf.slice(0, nl));
				buf = buf.slice(nl + 1);
				if (!m) continue;
				// pi-desk revoked the env token on this hello: keep its reconnect token even if this
				// runtime closed meanwhile (reload, session switch), or the next runtime cannot connect.
				const helloOk = !ready && m.id === helloId && m.result?.ok === true;
				if (helloOk) keepReconnectToken(m.result.data?.reconnect_token);
				if (sock !== s || closed) continue;
				try {
					if (!ready) {
						if (m.id !== helloId) continue;
						clearTimeout(helloTimer);
						if (!helloOk) return void s.destroy(); // wrong token or version: retried with backoff
						panelsOn = Array.isArray(m.result.data?.capabilities) && m.result.data.capabilities.includes("panels");
						pi.events.emit("kit:desk:mode", panelsOn);
						pi.events.emit("kit:desk:tab", m.result.data?.tab_id); // Home's desk extension never targets its own tab
						ready = connected = true;
						attempt = 0;
						sent = "";
						panelSent.clear();
						flushAcks(); // before pi.session: pi-desk clears those comments before it sends the rest again
						sendSession();
						update();
						flushPanels();
					} else handle(m);
				} catch {}
			}
		});
		s.on("error", () => {}); // "close" follows
		s.on("close", () => {
			clearTimeout(helloTimer);
			if (sock !== s) return;
			sock = undefined;
			ready = false;
			for (const t of waiters.values()) clearTimeout(t); // their connection is gone
			waiters.clear();
			calls.failAll("the pi-desk connection closed before the result");
			reloadId = undefined; // a reload still running answers nobody
			// pi-desk may clear or change the comments while we are away and cannot say so: after the
			// handshake it sends them again, or pi.attach_clear
			attach.clear();
			if (!connected && !closed) pi.events.emit("kit:desk:mode", false); // no pi-desk: the sidebar draws as usual
			if (!closed) retry = setTimeout(connect, backoff(attempt++));
		});
	}

	function readSubagents() {
		subTimer = undefined;
		const requestId = randomUUID();
		const finish = (r?: any) => {
			off();
			clearTimeout(timeout);
			if (r?.success) runs = arr(r.data?.asyncSnapshot?.runs);
			update();
		};
		const off = pi.events.on(`subagents:rpc:v1:reply:${requestId}`, finish);
		const timeout = setTimeout(finish, 5000); // no pi-subagents, or it did not answer
		pi.events.emit("subagents:rpc:v1:request", { version: 1, requestId, method: "status" });
	}
	const subagentsChanged = () => void (ctx && !closed && (subTimer ??= setTimeout(readSubagents, 250)));
	for (const name of SUBAGENT_EVENTS) pi.events.on(name, subagentsChanged);
	pi.events.on("kit:desk:panels", (p) => {
		panels = arr(p);
		panelsChanged();
	});
	pi.events.on("kit:shell:rows", (rows) => {
		shells = arr(rows);
		update();
	});

	// Other extensions' pi-desk commands (desk-browser), over this connection.
	pi.events.on(COMMAND_EVENT, (req: any) => {
		const requestId = String(req?.requestId ?? "");
		const answer = (o: CommandOutcome) => pi.events.emit(`${COMMAND_EVENT}:reply:${requestId}`, o);
		if (!requestId) return answer({ error: "a requestId is required" });
		const why = browserRefusal(req?.command);
		if (why) return answer({ error: why });
		if (!sock || !ready || sock.destroyed || closed) return answer({ error: "Not connected to pi-desk (it reconnects on its own; try again shortly)." });
		const id = `b${++seq}`;
		const ms = Number(req.timeoutMs) > 0 ? Number(req.timeoutMs) : COMMAND_TIMEOUT_MS;
		const timer = setTimeout(() => calls.end(id, { error: `pi-desk did not answer within ${Math.round(ms / 1000)}s` }), ms);
		callIds.set(requestId, id);
		calls.start(id, (o) => {
			clearTimeout(timer);
			callIds.delete(requestId);
			answer(o);
		});
		sock.write(line({ id, type: "command", command: req.command }));
	});
	pi.events.on(`${COMMAND_EVENT}:cancel`, (req: any) => {
		const id = callIds.get(String(req?.requestId ?? ""));
		if (id) calls.cancel(id);
	});

	pi.registerCommand(RELOAD_COMMAND, {
		description: "Reload pi for pi-desk (pi-desk's pi.reload uses it)",
		handler: async (_args, c) => {
			const id = reloadId;
			let result = { ok: true } as { ok: boolean; error?: string };
			try {
				await c.reload();
			} catch (e) {
				result = { ok: false, error: `reload failed: ${(e as Error)?.message ?? e}` };
			}
			// This runtime is gone now; only its socket is left, kept open for this result.
			if (id !== undefined) answer(id, result);
			reloadId = undefined;
			if (closed) sock?.end();
		},
	});

	pi.on("session_start", (_e, c) => {
		if (c.mode !== "tui" || !process.env.PI_DESK_SOCKET || !deskToken(true)) return;
		ctx = c;
		connect();
		subagentsChanged();
	});
	// The user's next typed message takes pi-desk's pending comments; pi.attached tells pi-desk to
	// clear them (Attacher: at once if queued, else when the message starts).
	pi.on("input", (e) => {
		const out = attach.input(e);
		if (!out) return { action: "continue" };
		const { ack, ...transform } = out;
		if (ack !== undefined) acks.push(ack), flushAcks(); // queued: pi has it
		return { action: "transform", ...transform };
	});
	pi.on("message_start", (e) => {
		const ids = attach.started(e.message as { role?: string; content?: unknown });
		if (!ids.length) return;
		acks.push(...ids);
		flushAcks();
	});
	pi.on("ui_prompt_start", () => {
		dialogs++;
		update();
	});
	pi.on("ui_prompt_end", () => {
		dialogs = Math.max(0, dialogs - 1);
		update();
	});
	pi.on("agent_start", () => {
		error = question = false;
		update();
	});
	pi.on("agent_end", (e) => {
		({ error, question } = runOutcome(e.messages));
		update();
	});
	pi.on("agent_settled", () => update());
	// Compaction outside a run (/compact) also makes pi busy; isIdle() flips around these events.
	const compaction = (start: boolean) => (e: { reason: string }) => {
		if (e.reason === "manual") compacting = start; // automatic compaction runs inside a run: prompts queue
		setTimeout(update, 0);
	};
	pi.on("session_before_compact", compaction(true));
	pi.on("session_compact", compaction(false));
	pi.on("session_compact_failed", compaction(false));

	pi.on("session_shutdown", () => {
		if (closed || !ctx) return;
		closed = true;
		clearTimeout(retry);
		clearTimeout(subTimer);
		clearTimeout(panelTimer);
		clearTimeout(idleTimer);
		for (const t of waiters.values()) clearTimeout(t);
		waiters.clear();
		if (reloadId === undefined) sock?.end(); // else the reload command answers, then closes it
		ctx = undefined;
	});
}
