// Runs pi in its interactive TUI (in a pseudo-terminal, via python3) for the sidebar smoke check (test/smoke.sh 26).
//
//   node test/tui.mjs plain <screen> [commands...]  pi for a few seconds, then each command typed in turn;
//                                                   prints "SNAP <label> columns=N at=X editor=yes|no" after each
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";

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
const startPi = (screen) => spawn("python3", ["-c", PTY, screen, "pi"], { stdio: ["pipe", "ignore", "inherit"] });
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
	const proc = startPi(args[0]);
	await sleep(8000);
	await snap("start", args[0]);
	await typeAll(proc, args[0], args.slice(1));
	await stop(proc);
	process.exit(0);
}

console.error(`unknown mode ${mode}: node test/tui.mjs plain <screen> [commands...]`);
process.exit(2);
