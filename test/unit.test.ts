// Unit tests for pure logic: node --test test/unit.test.ts (Node 22.18+ strips the types).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { commandVerdict, isShellLog, redact } from "../extensions/guardrails/core.ts";
import { clip, compilePattern, evictable, footerText, groupAlive, groupGone, groupSize, KEY_REDACTED, keyFilter, lastLines, lineMatcher, MATCH_CAP, MAX_LINE, panelRows, short, splitLines } from "../extensions/shell/lines.ts";

test("splitLines carries the unterminated tail", () => {
	assert.deepEqual(splitLines("", "a\nb\r\nc"), { lines: ["a", "b"], rest: "c" });
	assert.deepEqual(splitLines("c", "d\n"), { lines: ["cd"], rest: "" });
	assert.deepEqual(splitLines("", ""), { lines: [], rest: "" });
});

test("clip strips escapes and redraws and caps length", () => {
	assert.equal(clip("\x1b[31mred\x1b[0m"), "red");
	assert.equal(clip("10%\r50%\r100%"), "100%");
	const long = clip("x".repeat(MAX_LINE + 5));
	assert.ok(long.startsWith("x".repeat(MAX_LINE)) && long.endsWith("[5 more chars]"));
});

test("lastLines skips blank lines", () => {
	assert.deepEqual(lastLines("a\n\nb\nc\n\n", 2), ["b", "c"]);
});

test("compilePattern", () => {
	assert.equal(compilePattern(undefined), undefined);
	assert.equal(compilePattern(""), undefined);
	assert.ok(compilePattern("^ERR")!.test("ERR x"));
	assert.throws(() => compilePattern("("), /Invalid pattern/);
});

test("commandVerdict: dangerous asks, read-only blocks mutation", () => {
	assert.deepEqual(commandVerdict("git stash drop", false).confirm, ["drops or pops a stash"]);
	assert.deepEqual(commandVerdict("npm run dev", false), { confirm: [] });
	assert.match(commandVerdict("touch x", true).block!, /Read-only/);
	assert.equal(commandVerdict("touch x", false).block, undefined);
});

test("redact", () => {
	assert.equal(redact("t ghp_abcdefghijklmnopqrstuvwxyz0123456789AB", false), "t [REDACTED]");
	assert.equal(redact("password=supersecretvalue123", true), "password=[REDACTED]");
	assert.equal(redact("password=supersecretvalue123", false), "password=supersecretvalue123");
});

// A fake PEM block (random filler, not a key).
const FAKE_KEY = ["-----BEGIN RSA PRIVATE KEY-----", "MIIEfakefakefakeAAAAQQQQ1111", "ZZZZfakebodyline2zzzzzzzzzzz", "-----END RSA PRIVATE KEY-----"];
const GH = "ghp_abcdefghijklmnopqrstuvwxyz0123456789AB";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.c2lnbmF0dXJlLXBhcnQtMTIzNDU2";

test("clip redacts before it cuts (P1-1)", () => {
	const gh = clip(`${"x".repeat(MAX_LINE - 10)} ${GH}`);
	assert.ok(!gh.includes("ghp_") && !gh.includes("abcdefgh"), gh);
	// The JWT's signature starts past the cut.
	const jwt = clip(`${"y".repeat(MAX_LINE - JWT.indexOf(".", 25) - 5)} ${JWT}`);
	assert.ok(!jwt.includes("eyJ"), jwt);
	// A token straddling MATCH_CAP leaves no fragment either.
	// A token straddling MATCH_CAP leaves no fragment, even when redaction shrinks what is before it.
	const [b, e] = ["-----BEGIN X PRIVATE KEY-----", "-----END X PRIVATE KEY-----"];
	const far = clip(`${b}${"a".repeat(MATCH_CAP - 20 - b.length - e.length - 1)}${e} ${GH}`);
	assert.ok(!far.includes("ghp_"), far);
});

test("keyFilter and lastLines drop private key blocks (P1-1)", () => {
	const st = { inKey: false };
	assert.deepEqual(["before", ...FAKE_KEY, "after"].map((l) => keyFilter(st, l)), ["before", KEY_REDACTED, undefined, undefined, undefined, "after"]);
	assert.deepEqual(lastLines(["start", ...FAKE_KEY, "done"].join("\n"), 10), ["start", KEY_REDACTED, "done"]);
	// The tail window starts inside the block: its first line is partial and its BEGIN is out of view.
	assert.deepEqual(lastLines(["kefakebody", ...FAKE_KEY.slice(1), "done"].join("\n"), 10, false), [KEY_REDACTED, "done"]);
	// A partial first line of the window is dropped (it may be the end of a cut token).
	assert.deepEqual(lastLines("WXYZ0123456789AB\nnext", 10, false), ["next"]);
	// Unterminated block: nothing after BEGIN is shown.
	assert.deepEqual(lastLines(FAKE_KEY.slice(0, 3).join("\n"), 10), [KEY_REDACTED]);
});

test("compilePattern rejects nested quantifiers (P2-2)", () => {
	assert.throws(() => compilePattern(String.raw`(\w+\s?)+$`), /repeats a group that itself repeats/);
	assert.throws(() => compilePattern("(a+)*b"), /repeats a group/);
	assert.ok(compilePattern(String.raw`(ERR|WARN) \d+`));
	assert.ok(compilePattern(String.raw`^\[(\d+)\] .*failed`));
});

test("lineMatcher bounds a slow pattern (P2-2)", () => {
	const ok = lineMatcher(/^ERR/);
	assert.deepEqual(ok.test(["ERR 1", "ok"]), [true, false]);
	ok.close();
	const slow = lineMatcher(/.*.*x/, 300);
	const t0 = Date.now();
	assert.equal(slow.test(["a".repeat(4096)]), undefined);
	assert.ok(Date.now() - t0 < 2000);
});

test("leftover process groups (P1-2, P2-1)", async () => {
	const child = spawn("bash", ["-c", "sleep 30 &"], { detached: true, stdio: "ignore" });
	await new Promise((r) => child.once("exit", r));
	const pid = child.pid!;
	assert.equal(groupAlive(pid), true);
	assert.equal(groupSize(pid), 1);
	const t: { pid: number; ended?: number; gone?: boolean } = { pid, ended: Date.now() };
	assert.equal(groupGone(t), false);
	process.kill(-pid, "SIGKILL");
	await new Promise((r) => setTimeout(r, 200));
	assert.equal(groupAlive(pid), false);
	assert.equal(groupGone(t), true);
	// Latched: a reused group id never makes a gone task signalable again.
	assert.equal(groupGone(t, () => true), true);
	// A running task is never "gone".
	assert.equal(groupGone({ pid }, () => false), false);
});

test("evictable keeps tasks whose group may be alive (P1-2)", () => {
	const ts = [{ id: 1, ended: 1, gone: true }, { id: 2, ended: 2 }, { id: 3, ended: 3, gone: true }, { id: 4 }, { id: 5, ended: 5, gone: true }];
	assert.deepEqual(evictable(ts, 1).map((t) => t.id), [1, 3]);
	assert.deepEqual(evictable(ts, 3), []);
	// Oldest by end time, not by start: a long task that just ended is kept.
	assert.deepEqual(evictable([{ id: 1, ended: 9, gone: true }, { id: 2, ended: 3, gone: true }], 1).map((t) => t.id), [2]);
});

test("secret files and credential commands are not blocked (agents use judgement)", () => {
	for (const c of ["rg credentials", "cat ~/.aws/credentials", "aws sso login --profile dev", "tsh login --proxy=tele.example", "sops -d secrets.sops.yaml", "TOKEN=$(gcloud auth print-access-token) curl -H x", "cat .env", "printenv", "cat ~/.ssh/id_ed25519"]) {
		assert.equal(commandVerdict(c, false).block, undefined, c);
	}
});

test("shell log reads get assignment redaction (P3-4)", () => {
	const dir = path.join(os.tmpdir(), "pi-shell-abc123");
	assert.equal(isShellLog(path.join(dir, "sh1.log"), "/x"), true);
	assert.equal(isShellLog("sh1.log", dir), true);
	assert.equal(isShellLog(path.join(dir, "notes.txt"), "/x"), false);
	assert.equal(isShellLog("/repo/sh1.log", "/x"), false);
});

test("short: one redacted line, cut to n", () => {
	assert.equal(short("npm run\n  dev"), "npm run dev");
	assert.equal(short("x".repeat(60), 10), `${"x".repeat(9)}…`);
	const s = short(`curl -H "Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789AB" https://example.com/${"p".repeat(80)}`);
	assert.ok(!s.includes("ghp_abc") && s.length <= 48, s);
});

test("panelRows: shells, monitors, leftovers, timers, cap", () => {
	const now = 100_000;
	const rows = panelRows(
		[
			{ id: "sh1", command: "sleep 30", started: now - 12_000, watch: { re: /READY/, matches: 1 } },
			{ id: "sh2", command: "tail -f log", started: now - 75_000, watch: { matches: 3 } },
			{ id: "sh3", command: "make", started: 0, ended: now },
			{ id: "sh4", command: "serve &", started: 0, ended: now, leftover: true },
		],
		[{ id: "wk5", prompt: "check\nthe deploy", due: now + 90_000 }],
		now,
	);
	assert.deepEqual(rows, [
		{ id: "sh1", status: "12s · watching /READY/ · 1 match", label: "sleep 30" },
		{ id: "sh2", status: "1m15s · watching all lines · 3 lines", label: "tail -f log" },
		{ id: "sh4", status: "exited, processes left in its group", label: "serve &", warn: true },
		{ id: "wk5", status: "wakes in 1m30s", label: "check the deploy" },
	]);
	const many = panelRows([], Array.from({ length: 8 }, (_, i) => ({ id: `wk${i}`, prompt: "p", due: now })), now);
	assert.equal(many.length, 6);
	assert.deepEqual(many[5], { id: "", status: "+3 more · /shells", label: "" });
	assert.equal(panelRows([], Array.from({ length: 8 }, (_, i) => ({ id: `wk${i}`, prompt: "p", due: now })), now, Infinity).length, 8);
	assert.deepEqual(panelRows([], [], now), []);
});

test("footerText counts each kind", () => {
	assert.equal(footerText({ shells: 2, monitors: 1, timers: 1, leftovers: 0 }), "2 shells · 1 monitor · 1 timer · /shells");
	assert.equal(footerText({ shells: 0, monitors: 0, timers: 0, leftovers: 1 }), "1 leftover · /shells");
	assert.equal(footerText({ shells: 0, monitors: 0, timers: 0, leftovers: 0 }), undefined);
});
