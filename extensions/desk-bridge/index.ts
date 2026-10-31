/**
 * Bridge to pi-desk (the native app that runs pi in a terminal tab): the pi tab's control plane,
 * per pi-desk's docs/PROTOCOL.md §4. Inert unless PI_DESK_SOCKET and PI_DESK_TOKEN are set and pi
 * runs in the interactive TUI.
 *
 * - Connects to the socket, sends `hello` with the token, reconnects with backoff if pi-desk goes
 *   away. The token is taken out of process.env, so shell commands and child processes do not see it.
 * - Reports `pi.session` (id, file, cwd) after each handshake; a session switch or reload starts a
 *   new extension runtime, which connects again and reports the new session.
 * - Reports `pi.status {agent, waiting, blockers}` when it changes (see status() in protocol.ts).
 * - Publishes the sidebar's sections (subagents, shells, todos) as panels (`panel.set`, or
 *   `panel.remove` once a section empties), at most once a second and only when they changed.
 * - Answers `pi.prompt` (a user message; follow-up while a run is going), `pi.wait_idle` (when
 *   pi is idle with nothing queued and no blockers, or a timeout) and `pi.reload` (refused unless
 *   that same idle holds: a reload kills the kit's background shells; the result comes after it).
 *
 * Never throws into pi: socket and protocol errors end the connection, which is retried.
 */

import { randomUUID } from "node:crypto";
import net from "node:net";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Panel, type Run, type ShellRow, SUBAGENT_EVENTS } from "../sidebar/rows.ts";
import { backoff, deskToken, line, parse, reply, runOutcome, status } from "./protocol.ts";

export { inDesk } from "./protocol.ts";

const HELLO_TIMEOUT_MS = 5000;
const IDLE_SETTLE_MS = 250; // wait_idle needs idle to hold this long (a shell's exit notice starts a run just after its rows clear)
const PANEL_EVERY_MS = 1000; // panel updates are coalesced to one per this
const RELOAD_COMMAND = "desk-reload";
const arr = (v: unknown) => (Array.isArray(v) ? v : []);

export default function (pi: ExtensionAPI) {
	let ctx: ExtensionContext | undefined; // set while active
	let sock: net.Socket | undefined;
	let ready = false; // handshake done on the current connection
	let closed = false;
	let attempt = 0;
	let retry: NodeJS.Timeout | undefined;
	let seq = 0;
	let sent = ""; // the last pi.status sent on this connection
	let shells: ShellRow[] = [];
	let runs: Run[] = [];
	let dialog = false;
	let error = false;
	let question = false;
	let subTimer: NodeJS.Timeout | undefined;
	let reloadId: unknown; // a pi.reload waiting for its result
	let panels: Panel[] = []; // the latest from the sidebar
	const panelSent = new Map<string, string>(); // panel -> the last panel.set/remove sent on this connection
	let panelTimer: NodeJS.Timeout | undefined;
	let idleTimer: NodeJS.Timeout | undefined;
	const waiters = new Map<unknown, NodeJS.Timeout | undefined>(); // pi.wait_idle id -> its timeout

	const send = (msg: Record<string, unknown>) => {
		if (sock && ready && !sock.destroyed) sock.write(line({ id: `b${++seq}`, ...msg }));
	};
	const answer = (id: unknown, result: { ok: boolean; error?: string }) => {
		if (sock && !sock.destroyed) sock.write(reply(id, result));
	};

	function current() {
		return status({ idle: ctx!.isIdle(), error, dialog, question, shells, runs });
	}
	/** Why pi is not idle for wait_idle and reload; empty when it is. */
	function busyReasons(): string[] {
		const s = current();
		return [...(s.agent === "working" ? ["agent working"] : []), ...(ctx!.hasPendingMessages() ? ["messages queued"] : []), ...s.blockers];
	}

	/** Send pi.status if it changed; answer wait_idle requests once pi is idle. */
	function update() {
		if (!ctx || closed) return;
		try {
			const s = JSON.stringify(current());
			if (ready && s !== sent) {
				sent = s;
				send({ type: "pi.status", ...JSON.parse(s) });
			}
			if (waiters.size && !busyReasons().length) idleTimer ??= setTimeout(answerIdle, IDLE_SETTLE_MS);
		} catch {}
	}
	function answerIdle() {
		idleTimer = undefined;
		try {
			if (!ctx || closed || busyReasons().length) return; // the next update() checks again
			for (const [id, t] of waiters) clearTimeout(t), answer(id, { ok: true });
			waiters.clear();
		} catch {}
	}

	function flushPanels() {
		panelTimer = undefined;
		if (!ready || closed) return;
		for (const p of panels) {
			const msg = p.rows.length ? { type: "panel.set", panel: p.panel, title: p.title, rows: p.rows } : { type: "panel.remove", panel: p.panel };
			const key = JSON.stringify(msg);
			if (panelSent.get(p.panel) === key) continue;
			panelSent.set(p.panel, key);
			send(msg);
		}
	}
	const panelsChanged = () => void (ready && !closed && (panelTimer ??= setTimeout(flushPanels, PANEL_EVERY_MS)));

	function sendSession() {
		const sm = ctx!.sessionManager;
		send({ type: "pi.session", pi_session_id: sm.getSessionId(), session_file: sm.getSessionFile() ?? "", cwd: ctx!.cwd });
	}

	function handle(m: Record<string, any>) {
		if (m.type === "result") return; // replies to our own pi.session / pi.status
		if (m.id === undefined) return; // events: none expected yet
		if (m.type === "pi.prompt") {
			if (typeof m.text !== "string" || !m.text.trim()) return answer(m.id, { ok: false, error: "text is required" });
			if (dialog) return answer(m.id, { ok: false, error: "pi is waiting on the user" });
			pi.sendUserMessage(m.text, ctx!.isIdle() ? undefined : { deliverAs: "followUp" });
			return answer(m.id, { ok: true });
		}
		if (m.type === "pi.wait_idle") {
			const ms = Number(m.timeout_ms);
			const t = ms > 0 ? setTimeout(() => waiters.delete(m.id) && answer(m.id, { ok: false, error: "timeout" }), ms) : undefined;
			waiters.set(m.id, t);
			return update();
		}
		if (m.type === "pi.reload") {
			const why = busyReasons();
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
				if (!m || sock !== s || closed) continue;
				try {
					if (!ready) {
						if (m.id !== helloId) continue;
						clearTimeout(helloTimer);
						if (!m.result?.ok) return void s.destroy(); // wrong token or version: retried with backoff
						ready = true;
						attempt = 0;
						sent = "";
						panelSent.clear();
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
			reloadId = undefined; // a reload still running answers nobody
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
	pi.on("ui_prompt_start", () => {
		dialog = true;
		update();
	});
	pi.on("ui_prompt_end", () => {
		dialog = false;
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
	const later = () => void setTimeout(update, 0);
	pi.on("session_before_compact", later);
	pi.on("session_compact", later);
	pi.on("session_compact_failed", later);

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
