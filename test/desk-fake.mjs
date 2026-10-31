// A fake pi-desk for the smoke test: starts pi in its interactive TUI (in a pseudo-terminal, via
// python3) and plays pi-desk's side of the protocol (pi-desk docs/PROTOCOL.md §2, §4, §5).
// Prints "OK <step>" or "FAIL <step>" per step; every message goes to <log>, the screen to <screen>.
//
//   node test/desk-fake.mjs desk <log> <screen>   pi with PI_DESK_SOCKET/PI_DESK_TOKEN: the scenario
//   node test/desk-fake.mjs plain <screen>        pi without them, for a few seconds (sidebar check)
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

// pty.fork with a 140x40 window, the child's output appended to argv[1]; SIGTERM is passed on.
const PTY = `
import os, pty, sys, fcntl, termios, struct, signal
pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 140, 0, 0))
    os.execvp(sys.argv[2], sys.argv[2:])
signal.signal(signal.SIGTERM, lambda *_: os.kill(pid, signal.SIGTERM))
out = open(sys.argv[1], "ab")
while True:
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
const startPi = (screen, env) => spawn("python3", ["-c", PTY, screen, "pi"], { env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "inherit"] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stop = async (proc) => {
	proc.kill("SIGTERM");
	await Promise.race([new Promise((r) => proc.once("exit", r)), sleep(10_000)]);
};

const [mode, ...args] = process.argv.slice(2);
if (mode === "plain") {
	const proc = startPi(args[0], {});
	await sleep(8000);
	await stop(proc);
	process.exit(0);
}

const [logFile, screen] = args;
const TOKEN = "tok-desk-smoke"; // single use: the first hello with it revokes it and issues RECONNECT
const RECONNECT = "tok-desk-reconnect";
const valid = new Set([TOKEN]);
const dir = fs.mkdtempSync("/tmp/desk-"); // short: Unix socket paths are limited to ~104 bytes
const sockPath = path.join(dir, "desk.sock");
const log = (s) => fs.appendFileSync(logFile, `${s}\n`);
const conns = []; // {sock, n}
const got = []; // {n (connection), m (message)}
const pending = new Map(); // our request id -> resolve
let nextId = 0;
let failed = false;

const server = net.createServer((sock) => {
	const c = { sock, n: conns.length };
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
			log(`${c.n} < ${text.replace(TOKEN, "<token>").replace(RECONNECT, "<reconnect>")}`);
			const m = JSON.parse(text);
			got.push({ n: c.n, m });
			if (m.type === "result") pending.get(m.id)?.(m.result);
			else if (m.type === "hello") {
				const ok = valid.has(m.token) && m.v === 1;
				if (ok) valid.delete(TOKEN), valid.add(RECONNECT);
				sock.write(`${JSON.stringify({ id: m.id, v: 1, type: "result", result: ok ? { ok, data: { v: 1, app: "pi-desk", caller: "panel", tab_id: 1, reconnect_token: RECONNECT } } : { ok, error: "unknown token" } })}\n`);
				if (!ok) sock.end();
			} else if (m.id !== undefined) sock.write(`${JSON.stringify({ id: m.id, v: 1, type: "result", result: { ok: true } })}\n`);
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
	const c = conns[conns.length - 1];
	const line = JSON.stringify({ id, v: 1, type, ...fields });
	log(`${c.n} > ${line}`);
	c.sock.write(`${line}\n`);
	return Promise.race([new Promise((r) => pending.set(id, r)), sleep(ms).then(() => ({ ok: false, error: "fake: no result" }))]);
}
const step = (name, args) => `@@ ${JSON.stringify({ name, arguments: args })}`;
const isStatus = (m, agent) => m.type === "pi.status" && m.agent === agent;

const proc = startPi(screen, { PI_DESK_SOCKET: sockPath, PI_DESK_TOKEN: TOKEN });
try {
	await until("handshake with the token", (m) => m.type === "hello" && m.token === TOKEN, 30_000);
	const s = await until("pi.session reported", (m) => m.type === "pi.session" && /^[0-9a-f-]{8,}$/.test(m.pi_session_id) && m.session_file.endsWith(".jsonl") && m.cwd === process.cwd(), 10_000);
	const sessionId = s >= 0 ? got[s].m.pi_session_id : "";
	await until("status idle after start", (m) => isStatus(m, "idle") && !m.waiting && m.blockers.length === 0, 10_000);

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
	result("scenario", false, e?.stack ?? String(e));
}
await stop(proc);
server.close();
fs.rmSync(dir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
