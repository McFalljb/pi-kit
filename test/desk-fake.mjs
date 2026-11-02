// A fake pi-desk for the smoke test: starts pi in its interactive TUI (in a pseudo-terminal, via
// python3) and plays pi-desk's side of the protocol (pi-desk docs/PROTOCOL.md §2, §4, §5).
// Prints "OK <step>" or "FAIL <step>" per step; every message goes to <log>, the screen to <screen>.
//
//   node test/desk-fake.mjs desk <log> <screen>   pi with PI_DESK_SOCKET/PI_DESK_TOKEN: the scenario (with
//                                                 pi.attach / pi.attached and pi.prompt images);
//                                                 the hello result advertises the panels capability
//   node test/desk-fake.mjs nopanels <log> <screen>  the same pi, panels not advertised: a short run
//   node test/desk-fake.mjs earlyreload <log> <screen>  /reload typed in pi before its first hello
//                                                 is answered: the old runtime must keep the token
//   node test/desk-fake.mjs control <log> <screen>  pi as pi-desk's Home: also PI_DESK_CONTROL_TOKEN;
//                                                 plays a control server (state, list_commands, a
//                                                 confirmation, pi_prompt/pi_wait_idle, status and
//                                                 close events, notifications_list after a reconnect)
//                                                 and prompts Home through its bridge to call the desk tools
//   node test/desk-fake.mjs plain <screen>        pi without them, for a few seconds (sidebar check)
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";

// pty.fork with a 140x40 window, the child's output appended to argv[1], our stdin typed into it;
// SIGTERM is passed on.
const PTY = `
import os, pty, sys, fcntl, termios, struct, signal, select
pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 140, 0, 0))
    os.execvp(sys.argv[2], sys.argv[2:])
signal.signal(signal.SIGTERM, lambda *_: os.kill(pid, signal.SIGTERM))
out = open(sys.argv[1], "ab")
fds = [fd, 0]
while True:
    ready = select.select(fds, [], [])[0]
    if 0 in ready:
        typed = os.read(0, 4096)
        if typed:
            os.write(fd, typed)
        else:
            fds.remove(0)
        continue
    try:
        data = os.read(fd, 65536)
    except OSError:
        break
    if not data:
        break
    out.write(data)
    out.flush()
os.waitpid(pid, 0)
`;
const startPi = (screen, env, piArgs = []) => spawn("python3", ["-c", PTY, screen, "pi", ...piArgs], { env: { ...process.env, ...env }, stdio: ["pipe", "ignore", "inherit"] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stop = async (proc) => {
	proc.kill("SIGTERM");
	await Promise.race([new Promise((r) => proc.once("exit", r)), sleep(10_000)]);
};

const [mode, ...args] = process.argv.slice(2);
/**
 * What the terminal shows now (pi's output replayed into a headless xterm): how many sidebar
 * columns, the column of the first one's border (normal: 140 - 34 = 106), whether the editor's
 * border is on screen. Prints "SNAP <label> columns=N at=X editor=yes|no".
 */
async function snap(label, screen) {
	const { Terminal } = createRequire(import.meta.url)("./ci/node_modules/@xterm/headless");
	const t = new Terminal({ cols: 140, rows: 40, allowProposedApi: true });
	await new Promise((r) => t.write(fs.readFileSync(screen), r));
	const b = t.buffer.active;
	const lines = Array.from({ length: t.rows }, (_, i) => b.getLine(b.viewportY + i)?.translateToString(true) ?? "");
	const columns = Math.max(...lines.map((l) => l.split("No subagents").length - 1));
	const at = lines.map((l) => l.indexOf("│ No subagents")).find((i) => i >= 0) ?? -1;
	console.log(`SNAP ${label} columns=${columns} at=${at} editor=${lines.some((l) => /─{40}/.test(l)) ? "yes" : "no"}`);
}
/** Type each command into pi, wait, and snap the screen. */
async function typeAll(proc, screen, commands) {
	for (const c of commands) {
		proc.stdin.write(`${c}\r`);
		await sleep(5000);
		await snap(c, screen);
	}
}

if (mode === "plain") {
	const proc = startPi(args[0], {});
	await sleep(8000);
	await snap("start", args[0]);
	await typeAll(proc, args[0], args.slice(1));
	await stop(proc);
	process.exit(0);
}

const [logFile, screen] = args;
const capabilities = mode === "desk" ? ["panels"] : [];
const TOKEN = "tok-desk-smoke"; // single use: the first hello with it revokes it and issues RECONNECT
const RECONNECT = "tok-desk-reconnect";
const CTL = "tok-control-smoke"; // the Home's control token: single use too, swapped for CTL_RE
const CTL_RE = "tok-control-reconnect";
const valid = new Set(mode === "control" ? [TOKEN, CTL] : [TOKEN]);
const dir = fs.mkdtempSync("/tmp/desk-"); // short: Unix socket paths are limited to ~104 bytes
const sockPath = path.join(dir, "desk.sock");
const log = (s) => fs.appendFileSync(logFile, `${s}\n`);
const conns = []; // {sock, n}
const got = []; // {n (connection), m (message)}
const pending = new Map(); // our request id -> resolve
let nextId = 0;
let failed = false;
let holdHellos = mode === "earlyreload"; // keep hellos unanswered until released
const held = []; // [connection, hello]

function answerHello(c, m) {
	const ok = valid.has(m.token) && m.v === 1;
	if (ok && (m.token === CTL || m.token === CTL_RE)) {
		c.caller = "control";
		c.hello = ++controlHellos;
		const reconnect = m.token === CTL ? CTL_RE : undefined;
		if (reconnect) valid.delete(CTL), valid.add(CTL_RE);
		c.sock.write(`${JSON.stringify({ id: m.id, v: 1, type: "result", result: { ok, data: { v: 1, app: "pi-desk", caller: "control", tab_id: 1, capabilities: ["commands", "state", "events"], ...(reconnect && { reconnect_token: reconnect }) } } })}\n`);
		return;
	}
	if (ok) valid.delete(TOKEN), valid.add(RECONNECT), (c.caller = "panel");
	c.sock.write(`${JSON.stringify({ id: m.id, v: 1, type: "result", result: ok ? { ok, data: { v: 1, app: "pi-desk", caller: "panel", tab_id: 1, reconnect_token: RECONNECT, capabilities } } : { ok, error: "unknown token" } })}\n`);
	if (!ok || c.ended) c.sock.end();
}

// The control side (pi-desk docs/PROTOCOL.md §3) for the Home's desk extension: three projects with
// a pi tab each (tab 2 also has shell tab 5); close_tab needs the user's confirmation, which the
// "user" gives 1.5 s later (after a try of their own that needs confirmation); for tab 6 pi-desk
// drops the confirmation and the event stream instead, and tab 9's is gone before Home looks.
// Status events for other tabs come with no watch set (close_tab on tab 5), then during the first
// pi_wait_idle on tab 2 (tabs 1 = Home's own, 2, 7 and 8) and the second (tab 8 again, and the user
// closes session 11 with tab 7). notifications_list is listed from the second control connection on.
let reqN = 100;
const parked = [];
const closed = new Set(); // open session ids the "user" closed
let controlHellos = 0;
const agents = new Map([[2, "working"]]); // pi tab -> agent status, as the status events set it (default idle)
const piTab = (id) => ({ id, kind: "pi", title: "pi", status: "running", agent: agents.get(id) ?? "idle", waiting: false, question: false, blockers: [], panels: [] });
const deskState = () => ({
	version: 1,
	projects: [1, 2, 3].map((id) => ({ id, cwd: `/w/p${id}`, label: `~/w/p${id}`, name: ["Alpha", "Beta", "Gamma"][id - 1] })),
	selected_project: 1,
	sessions: [],
	open_sessions: [
		{ id: 10, pi_session_id: "s10", project_id: 1, active_tab: 2, tabs: [piTab(2), { id: 5, kind: "shell", title: "shell 1", status: "running" }, { id: 13, kind: "app", title: "fake", status: "running", app_status: "stalled" }] },
		{ id: 11, pi_session_id: "s11", project_id: 2, active_tab: 7, tabs: [piTab(7)] },
		{ id: 12, pi_session_id: "s12", project_id: 3, active_tab: 8, tabs: [piTab(8)] },
	].filter((s) => !closed.has(s.id)),
	current_session: 10,
	pending_confirmations: parked,
});
function send(c, msg) {
	const text = JSON.stringify({ v: 1, ...msg });
	log(`${c.n} > ${text}`);
	c.sock.write(`${text}\n`);
}
const event = (fields) => conns.filter((c) => c.caller === "control" && c.subscribed && !c.sock.destroyed).forEach((c) => send(c, { type: "event", ...fields }));
const statusEvent = (tab_id, agent, waiting = false) =>
	agents.set(tab_id, agent) &&
	event({ event: "command", request_id: ++reqN, caller: "panel", caller_tab_id: tab_id, version: 1, changed: true, command: { type: "pi.status", tab_id, agent, waiting, question: false, blockers: [] }, result: { ok: true } });
function control(c, m) {
	const answer = (result, extra = {}) => send(c, { id: m.id, type: "result", result, ...extra });
	if (m.type === "subscribe") return (c.subscribed = true), answer({ ok: true });
	if (m.type !== "command") return answer({ ok: false, error: `unknown type ${m.type}` });
	const cmd = m.command;
	const rid = ++reqN;
	const finish = (result, ms) => setTimeout(() => send(c, { type: "event", event: "finished", request_id: rid, result }), ms);
	if (cmd.type === "get_state") return answer({ ok: true, data: deskState() });
	if (cmd.type === "list_commands") {
		const commands = [{ type: "get_state", does: "the state" }, { type: "close_tab", args: "tab_id", does: "close a shell tab", confirm_class: "tab_close" }, { type: "fake_cmd", args: "x", does: "listed by the fake pi-desk" }];
		if (c.hello > 1) commands.push({ type: "notifications_list", does: "the bell's notifications" });
		return answer({ ok: true, data: { commands } });
	}
	if (cmd.type === "notifications_list" && c.hello > 1)
		return answer({ ok: true, data: { notifications: [{ id: 1, time: "2026-11-01T10:00:00Z", kind: "finished", title: "Gamma finished its run", project: "Gamma", session_id: 12, tab_id: 8, read: false }] } });
	if (cmd.type === "close_tab" && !cmd.confirm) {
		const entry = { summary: "Close shell 1?", caller: "control", class: "tab_close", command: { type: "close_tab", tab_id: cmd.tab_id } };
		if (cmd.tab_id !== 9) parked.push(entry);
		answer({ ok: false, error: "needs_confirmation", needs_confirmation: { summary: "Close shell 1?", by: "user" } }, { request_id: rid });
		const userEvent = (result) => event({ event: "command", request_id: ++reqN, caller: "ui", version: 2, changed: true, command: { type: "close_tab", tab_id: cmd.tab_id, confirm: "<redacted>" }, result });
		if (cmd.tab_id === 6)
			return setTimeout(() => {
				parked.splice(parked.indexOf(entry), 1);
				send(c, { type: "event", event: "dropped", error: "fake: queue full" });
			}, 300);
		if (cmd.tab_id === 9) return;
		if (cmd.tab_id === 5) statusEvent(8, "working"), statusEvent(8, "idle"), statusEvent(7, "error"), statusEvent(8, "working"); // no watch yet: no notice
		setTimeout(() => userEvent({ ok: false, error: "needs_confirmation", needs_confirmation: { summary: "Close shell 1?", by: "caller" } }), 300);
		return setTimeout(() => {
			parked.splice(parked.indexOf(entry), 1);
			userEvent({ ok: true });
		}, 1500);
	}
	// app tab 13 (pi-desk passes app_call through: the fake app knows tab.describe and game.get)
	if (cmd.type === "app_call") {
		answer({ ok: true, pending: true }, { request_id: rid });
		const replies = {
			"tab.describe": { ok: true, data: { name: "fake", methods: [{ name: "game.get", params: { path: "square" } }] } },
			"game.get": { ok: true, data: { value: { x: 100, y: 60 } } },
		};
		return finish(replies[cmd.method] ?? { ok: false, error: "not supported by the fake app", data: { code: "not_supported", method: cmd.method } }, 100);
	}
	if (cmd.type === "app_screenshot") {
		answer({ ok: true, pending: true }, { request_id: rid });
		const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
		const file = path.join(dir, "apps", "shots", "13-1.png"); // where pi-desk writes them: <data dir>/apps/shots/
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, png);
		return finish({ ok: true, data: { path: file, w: 2, h: 2, bytes: png.length, seq: 5, tick: 7, scale: 2, rect: { x: 0, y: 0, w: 2, h: 2 }, visible: true } }, 100);
	}
	if (cmd.type === "app_input") return answer({ ok: true, data: { sent: cmd.events.length } }, { request_id: rid });
	if (cmd.type === "app_events") return answer({ ok: true, data: { events: [{ seq: 3, event: { v: 1, type: "event", event: "tab.log", text: "tick 61" } }], next: 3 } }, { request_id: rid });
	if (cmd.type === "pi_prompt") {
		answer({ ok: true, pending: true }, { request_id: rid });
		return send(c, { type: "event", event: "finished", request_id: rid, result: { ok: true } }); // at once: before the tool waits for it
	}
	if (cmd.type === "pi_wait_idle") {
		answer({ ok: true, pending: true }, { request_id: rid });
		c.waits = (c.waits ?? 0) + 1;
		if (cmd.tab_id === 2 && c.waits === 1) {
			statusEvent(1, "working"), statusEvent(1, "idle"); // Home's own tab: never a notice
			statusEvent(2, "working"), statusEvent(2, "idle"); // watched, but Home is waiting on it: the wait's result says so, the watch ends
			statusEvent(7, "idle", true); // waiting: tab 7's watch is for exited only
			statusEvent(8, "working"), statusEvent(8, "idle"); // finished: tab 8's watch fires
		}
		if (cmd.tab_id === 2 && c.waits === 2) {
			statusEvent(8, "working"), statusEvent(8, "idle"); // tab 8's watch already fired
			closed.add(11); // the user closes session 11: tab 7's watch fires
			event({ event: "command", request_id: ++reqN, caller: "ui", version: 3, changed: true, command: { type: "close_session", session: 11 }, result: { ok: true } });
		}
		return finish({ ok: true }, 500);
	}
	answer({ ok: false, error: `unknown command ${cmd.type}` }, { request_id: rid });
}

// Half-open: a client that ends its side can still get the answer to a held hello.
const server = net.createServer({ allowHalfOpen: true }, (sock) => {
	const c = { sock, n: conns.length };
	sock.on("end", () => {
		c.ended = true;
		if (!held.some(([h]) => h === c)) sock.end();
	});
	conns.push(c);
	let buf = "";
	sock.setEncoding("utf8");
	sock.on("error", () => {});
	sock.on("data", (chunk) => {
		buf += chunk;
		let nl;
		while ((nl = buf.indexOf("\n")) >= 0) {
			const text = buf.slice(0, nl);
			buf = buf.slice(nl + 1);
			log(`${c.n} < ${text.replace(TOKEN, "<token>").replace(RECONNECT, "<reconnect>").replace(CTL, "<control token>").replace(CTL_RE, "<control reconnect>")}`);
			const m = JSON.parse(text);
			got.push({ n: c.n, m });
			if (m.type === "result") pending.get(m.id)?.(m.result);
			else if (m.type === "hello") {
				if (holdHellos) held.push([c, m]);
				else answerHello(c, m);
			} else if (c.caller === "control") control(c, m);
			else if (m.id !== undefined) sock.write(`${JSON.stringify({ id: m.id, v: 1, type: "result", result: { ok: true } })}\n`);
		}
	});
});
await new Promise((r) => server.listen(sockPath, r));

const result = (name, ok, detail = "") => {
	console.log(`${ok ? "OK" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
	if (!ok) failed = true;
	return ok;
};
/** Wait for a message matching `pred` at index `from` or later; its index, or -1 on timeout. */
async function until(name, pred, ms, from = 0) {
	const end = Date.now() + ms;
	for (;;) {
		const i = got.findIndex((g, j) => j >= from && pred(g.m, g.n));
		if (i >= 0 || Date.now() > end) return result(name, i >= 0) ? i : -1;
		await sleep(50);
	}
}
/** Send a request to pi on the newest connection; resolves with its result (or {timeout}). */
function request(type, fields = {}, ms = 30_000) {
	const id = `d${++nextId}`;
	const c = conns.findLast((x) => x.caller !== "control"); // the bridge's
	const line = JSON.stringify({ id, v: 1, type, ...fields });
	log(`${c.n} > ${line}`);
	c.sock.write(`${line}\n`);
	return Promise.race([new Promise((r) => pending.set(id, r)), sleep(ms).then(() => ({ ok: false, error: "fake: no result" }))]);
}
const step = (name, args) => `@@ ${JSON.stringify({ name, arguments: args })}`;
const isStatus = (m, agent) => m.type === "pi.status" && m.agent === agent;

const proc = startPi(screen, { PI_DESK_SOCKET: sockPath, PI_DESK_TOKEN: TOKEN, PI_DESK_SHOTS_DIR: path.join(dir, "apps", "shots"), ...(mode === "control" && { PI_DESK_CONTROL_TOKEN: CTL }) },
	// the pending-comments steps send images: a model that takes them (smoke.sh's models.json)
	mode === "desk" ? ["--model", "mock/mock-img"] : []);
try {
	if (mode === "reloads") {
		await until("handshake", (m) => m.type === "hello", 30_000);
		await sleep(5000);
		await snap("start", screen);
		await typeAll(proc, screen, args.slice(2));
		throw "done";
	}
	if (mode === "earlyreload") {
		await until("first hello (held)", (m, n) => m.type === "hello" && n === 0, 30_000);
		proc.stdin.write("/reload\r");
		await until("the reloaded runtime says hello before the first is answered", (m, n) => m.type === "hello" && n > 0, 4000);
		holdHellos = false;
		for (const [c, m] of held.splice(0)) answerHello(c, m); // the first revokes the env token, the second is refused
		await until("the new runtime reconnects with the reconnect token the old runtime got", (m) => m.type === "hello" && m.token === RECONNECT, 10_000);
		await until("and reports its session", (m, n) => m.type === "pi.session" && n > 1, 5000);
		throw "done";
	}
	if (mode === "control") {
		await until("control hello with the control token", (m) => m.type === "hello" && m.token === CTL, 30_000);
		await until("subscribes to events", (m) => m.type === "subscribe", 5000);
		await until("asks for list_commands", (m) => m.type === "command" && m.command?.type === "list_commands", 5000);
		await until("Home's bridge says hello too", (m) => m.type === "hello" && m.token === TOKEN, 30_000);
		await until("Home idle", (m) => isStatus(m, "idle"), 10_000);
		const steps = [
			step("desk_state", {}),
			step("desk_run", { command: { type: "close_tab", tab_id: 5, reason: "cleanup" }, timeout_s: 20 }),
			step("desk_run", { command: { type: "close_tab", tab_id: 6 }, timeout_s: 5 }),
			step("desk_run", { command: { type: "close_tab", tab_id: 9 }, timeout_s: 5 }),
			step("desk_run", { command: { type: "send_text", tab_id: 2, text: "x" } }),
			step("desk_run", { command: { type: "focus_tab", tab_id: 1 } }),
			step("desk_prompt", { tab_id: 1, text: "me" }),
			step("desk_events", {}),
			step("desk_watch", { session: 12 }),
			step("desk_watch", { tab_id: 7, on: ["finished"] }),
			step("desk_watch", { tab_id: 7, on: ["exited"] }),
			step("desk_watch", { tab_id: 2, on: ["needs_user"] }),
			step("desk_watch", { tab_id: 2, cancel: true }),
			step("desk_watch", { tab_id: 2 }),
			step("desk_watch", { tab_id: 1 }),
			step("desk_watch", {}),
			step("desk_prompt", { tab_id: 2, text: "go", wait: true, timeout_s: 5 }),
			step("desk_wait", { session: 10, timeout_s: 5 }),
			step("desk_watch", {}),
			step("desk_run", { command: { type: "nope" } }),
			step("app_call", { tab: 13, method: "tab.describe" }),
			step("app_call", { tab: 13, method: "game.get", params: { path: "square" }, timeout_s: 5 }),
			step("app_call", { tab: 13, method: "game.nope" }),
			step("app_call", { tab: 1, method: "tab.describe" }),
			step("app_screenshot", { tab: 13, rect: { x: 0, y: 0, w: 1, h: 1 } }),
			step("app_input", { tab: 13, events: [{ event: "key", action: "down", key: "w", mods: [] }] }),
			step("app_events", { tab: 13, topic: "log" }),
			step("bash", { command: "echo desk-control token=[$PI_DESK_CONTROL_TOKEN]" }),
		];
		let mark = got.length;
		const r = await request("pi.prompt", { text: `Steps:\n${steps.join("\n")}` });
		result("prompt for Home accepted", r.ok === true, JSON.stringify(r));
		const cmdAt = (type, pred = () => true) => (m) => m.type === "command" && m.command?.type === type && pred(m.command);
		await until("desk_state reads the state", cmdAt("get_state"), 20_000, mark);
		await until("desk_run sends close_tab without a confirm token", cmdAt("close_tab", (c) => c.tab_id === 5 && !c.confirm), 20_000, mark);
		await until("desk_prompt sends pi_prompt to tab 2", cmdAt("pi_prompt", (c) => c.tab_id === 2 && c.text === "go"), 20_000, mark);
		const w1 = await until("and waits with pi_wait_idle", cmdAt("pi_wait_idle", (c) => c.tab_id === 2 && c.timeout_ms === 5000), 10_000, mark);
		const w = await until("desk_wait by session waits on its pi tab", cmdAt("pi_wait_idle", (c) => c.tab_id === 2), 20_000, Math.max(w1 + 1, mark));
		result("close_tab is never resent with a token", !got.some((g) => g.m.command?.type === "close_tab" && g.m.command.confirm));
		// Home's run ends with the fired watches' messages answered (followed up in the same run, or a run of their own).
		await until("Home idle after the steps", (m) => isStatus(m, "idle"), 30_000, Math.max(w, mark));
		await sleep(3000);
		const lastStatus = () => got.findLast((g) => g.m.type === "pi.status")?.m;
		await until("Home settled", (m) => m === lastStatus() && isStatus(m, "idle"), 15_000, mark);
		result("nothing aimed at Home's own tab or send_text into a pi tab reaches pi-desk", !got.some((g) => g.m.command?.tab_id === 1 || g.m.command?.type === "send_text"));
		const sent = (type, pred) => got.some((g) => g.m.type === "command" && g.m.command?.type === type && pred(g.m.command));
		result("app_call sends the app's method as given", sent("app_call", (c) => c.tab_id === 13 && c.method === "tab.describe" && !("params" in c)));
		result("app_call passes params and the timeout", sent("app_call", (c) => c.method === "game.get" && JSON.stringify(c.params) === '{"path":"square"}' && c.timeout_ms === 5000));
		result("app_screenshot sends the crop", sent("app_screenshot", (c) => c.tab_id === 13 && JSON.stringify(c.rect) === '{"x":0,"y":0,"w":1,"h":1}'));
		result("app_input sends the events as given", sent("app_input", (c) => c.tab_id === 13 && JSON.stringify(c.events) === '[{"event":"key","action":"down","key":"w","mods":[]}]'));
		result("app_events asks for the topic", sent("app_events", (c) => c.tab_id === 13 && c.topic === "log"));
		mark = got.length;
		conns.findLast((x) => x.caller === "control").sock.destroy();
		await until("control reconnects with the reconnect token", (m) => m.type === "hello" && m.token === CTL_RE, 10_000, mark);
		await until("and subscribes again", (m) => m.type === "subscribe", 5000, mark);
		await until("and asks for list_commands again", (m) => m.type === "command" && m.command?.type === "list_commands", 5000, mark);
		result("the env control token was used once", got.filter((g) => g.m.type === "hello" && g.m.token === CTL).length === 1);
		mark = got.length;
		const r2 = await request("pi.prompt", { text: `Steps:\n${step("desk_events", { limit: 5 })}` });
		result("second prompt for Home accepted", r2.ok === true, JSON.stringify(r2));
		await until("desk_events reads notifications_list once pi-desk lists it", cmdAt("notifications_list"), 20_000, mark);
		await until("Home idle after desk_events", (m) => isStatus(m, "idle"), 20_000, mark);
		throw "done";
	}
	await until("handshake with the token", (m) => m.type === "hello" && m.token === TOKEN, 30_000);
	const s = await until("pi.session reported", (m) => m.type === "pi.session" && /^[0-9a-f-]{8,}$/.test(m.pi_session_id) && m.session_file.endsWith(".jsonl") && m.cwd === process.cwd(), 10_000);
	const sessionId = s >= 0 ? got[s].m.pi_session_id : "";
	await until("status idle after start", (m) => isStatus(m, "idle") && !m.waiting && m.blockers.length === 0, 10_000);
	if (mode === "nopanels") {
		await request("pi.prompt", { text: `Steps:\n${step("bash_bg", { command: "sleep 2; echo bg-done" })}` });
		await until("background shell reported as a blocker", (m) => m.type === "pi.status" && m.blockers.some((b) => b.startsWith("shell sh1:")), 20_000);
		const r = await request("pi.wait_idle", { timeout_ms: 30_000 }, 40_000);
		result("wait_idle answers", r.ok === true, JSON.stringify(r));
		result("no panels sent when pi-desk does not advertise them", !got.some((g) => g.m.type?.startsWith("panel.")));
		throw "done";
	}

	let mark = got.length;
	let r = await request("pi.prompt", { text: `Steps:\n${step("bash", { command: "sleep 1; echo desk-ran token=[$PI_DESK_TOKEN]" })}` });
	result("pi.prompt accepted", r.ok === true, JSON.stringify(r));
	const w = await until("status working during the run", (m) => isStatus(m, "working"), 20_000, mark);
	await until("status idle after the run settles", (m) => isStatus(m, "idle"), 30_000, Math.max(w, mark));

	mark = got.length;
	await request("pi.prompt", { text: `Steps:\n${step("bash_bg", { command: "sleep 5; echo bg-done" })}` });
	await until("background shell reported as a blocker", (m) => m.type === "pi.status" && m.blockers.some((b) => b.startsWith("shell sh1:")), 20_000, mark);
	await until("shells panel published", (m) => m.type === "panel.set" && m.panel === "shells" && m.rows.some((row) => row.text.startsWith("sh1")), 10_000, mark);
	r = await request("pi.wait_idle", { timeout_ms: 300 });
	result("wait_idle times out while the shell runs", r.ok === false && r.error === "timeout", JSON.stringify(r));
	r = await request("pi.reload");
	result("reload refused while the shell runs", r.ok === false && /not idle: .*shell sh1/.test(r.error), JSON.stringify(r));
	const t0 = Date.now();
	r = await request("pi.wait_idle", { timeout_ms: 60_000 }, 70_000);
	const seen = got.slice(mark).map((g) => g.m);
	const shellGone = seen.findLastIndex((m) => m.type === "pi.status" && m.blockers.length > 0);
	const noticeRun = seen.findIndex((m, i) => i > shellGone && isStatus(m, "working"));
	result("wait_idle answers once the shell and its notice run are done", r.ok === true && shellGone >= 0 && noticeRun > shellGone, `${JSON.stringify(r)} after ${Date.now() - t0}ms`);
	await until("shells panel removed", (m) => m.type === "panel.remove" && m.panel === "shells", 5000, mark);
	r = await request("pi.wait_idle", { timeout_ms: 1000 });
	result("wait_idle answers at once when idle", r.ok === true, JSON.stringify(r));
	mark = got.length;
	await request("pi.prompt", { text: `Steps:\n${step("bash", { command: "echo which one?" })}` });
	await until("a final answer ending in ? is a question, not waiting", (m) => isStatus(m, "idle") && m.question === true && m.waiting === false, 20_000, mark);
	mark = got.length;
	await request("pi.prompt", { text: `Steps:\n${step("bash", { command: "echo done." })}` });
	await until("the next run clears the question", (m) => isStatus(m, "idle") && m.question === false, 20_000, mark);
	// pi-desk's pending comments (pi.attach) go with the next message typed in pi, then pi.attached
	const IMG = { mime: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" };
	const typed = async (text) => {
		const from = got.length;
		proc.stdin.write(`${text}\r`);
		const w = await until(`"${text}" ran`, (m) => isStatus(m, "working"), 20_000, from);
		await until(`idle after "${text}"`, (m) => isStatus(m, "idle"), 20_000, Math.max(w, from));
		return from;
	};
	r = await request("pi.attach", { attachment_id: 41, text: "<pi-desk-comments>ATTACH-41</pi-desk-comments>", images: [IMG] });
	result("pi.attach accepted", r.ok === true, JSON.stringify(r));
	r = await request("pi.attach", { attachment_id: 42, text: "x", images: [{ mime: "text/html", data: "AAAA" }] });
	result("pi.attach with a bad image refused", r.ok === false && /mime/.test(r.error), JSON.stringify(r));
	mark = await typed("typed-one please");
	await until("pi.attached for the attachment the typed message took", (m) => m.type === "pi.attached" && m.attachment_id === 41, 5000, mark);
	await typed("typed-two please");
	await request("pi.attach", { attachment_id: 43, text: "ATTACH-43" });
	r = await request("pi.attach_clear");
	result("pi.attach_clear accepted", r.ok === true, JSON.stringify(r));
	await typed("typed-three please");
	result("one pi.attached in all, none for the cleared attachment", got.filter((g) => g.m.type === "pi.attached").map((g) => g.m.attachment_id).join() === "41");
	mark = got.length;
	r = await request("pi.prompt", { text: "SEND-NOW comments", images: [IMG] });
	result("pi.prompt with images accepted", r.ok === true, JSON.stringify(r));
	const sw = await until("Send now ran", (m) => isStatus(m, "working"), 20_000, mark);
	await until("idle after Send now", (m) => isStatus(m, "idle"), 20_000, Math.max(sw, mark));
	r = await request("pi.prompt", { text: "x", images: [{ mime: "image/png", data: "%%%" }] });
	result("pi.prompt with a bad image refused", r.ok === false && /base64/.test(r.error), JSON.stringify(r));
	r = await request("pi.nonsense");
	result("unknown type refused", r.ok === false && /unknown/.test(r.error), JSON.stringify(r));

	mark = got.length;
	const before = conns.length;
	conns[conns.length - 1].sock.destroy();
	await until("reconnects with the reconnect token after pi-desk drops the connection", (m, n) => m.type === "hello" && n === before && m.token === RECONNECT, 10_000, mark);
	await until("session reported again on the new connection", (m, n) => m.type === "pi.session" && n === before && m.pi_session_id === sessionId, 5000, mark);
	await until("status reported again on the new connection", (m, n) => m.type === "pi.status" && n === before, 5000, mark);

	mark = got.length;
	const n0 = conns.length;
	r = await request("pi.reload");
	result("reload answered ok after the reload", r.ok === true, JSON.stringify(r));
	await until("the reloaded runtime connects and reports the same session", (m, n) => m.type === "pi.session" && n >= n0 && m.pi_session_id === sessionId, 15_000, mark);
} catch (e) {
	if (e !== "done") result("scenario", false, e?.stack ?? String(e));
}
await stop(proc);
server.close();
fs.rmSync(dir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
