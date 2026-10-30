// Unit tests for pure logic: node --test test/unit.test.ts (Node 22.18+ strips the types).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { commandVerdict, isShellLog, redact } from "../extensions/guardrails/core.ts";
import { hideCompleted, sidebarLines, summary, todosFromBranch, todoView, trackTodos } from "../extensions/sidebar/rows.ts";
import { addRules, isGpt } from "../extensions/model-rules/match.ts";
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
	for (const c of ["ssh nuc uptime", "sudo apt-get update", "ssh nuc 'sudo journalctl -u k3s'"]) assert.deepEqual(commandVerdict(c, false), { confirm: [] }, c);
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

test("sidebarLines: subagents, shells, todos; untrusted text made safe", () => {
	const now = 100_000;
	const lines = sidebarLines(
		{
			runs: [
				{ label: "kit.worker", state: "running", startedAt: now - 80_000, activity: { currentTool: "bash" } },
				{ label: "kit.reviewer", state: "complete", startedAt: 0, endedAt: 5_000 },
				{ label: "x", state: "failed" },
			],
			todos: [
				{ subject: "Write tests", status: "in_progress", activeForm: "Writing tests" },
				{ subject: "Ship\n\x1b[31mit\x1b[0m", status: "pending" },
				{ subject: "Plan", status: "completed" },
				{ subject: "gone", status: "deleted" },
			],
			shells: [{ id: "sh1", status: "12s", label: "echo password=supersecretvalue123" }, { id: "", status: "+2 more · /shells", label: "" }],
		},
		now,
	);
	assert.deepEqual(lines, [
		{ text: "Subagents · 1 running", head: true },
		{ text: "● kit.worker 1m20s · bash", tone: "accent" },
		{ text: "✓ kit.reviewer 5s", tone: "success" },
		{ text: "✗ x failed", tone: "warning" },
		{ text: "" },
		{ text: "Shells", head: true },
		{ text: "sh1 12s", tone: "accent" },
		{ text: "  echo password=[REDACTED]", tone: "muted" },
		{ text: "+2 more · /shells", tone: "muted" },
		{ text: "" },
		{ text: "Todos 1/3", head: true },
		{ text: "▸ Writing tests", tone: "accent" },
		{ text: "○ Ship it" },
		{ text: "✓ Plan", tone: "dim" },
	]);
	assert.deepEqual(sidebarLines({ runs: [], todos: [], shells: [] }, now), [{ text: "No subagents, todos or shells", tone: "muted" }]);
});

test("sidebarLines: a bad record breaks only its own section", () => {
	const lines = sidebarLines({ runs: [null as never], todos: [{ subject: "a", status: "pending" }], shells: [] }, 0);
	assert.equal(lines[0].tone, "error");
	assert.match(lines[0].text, /^subagents: /);
	assert.deepEqual(lines.slice(2), [{ text: "Todos 0/1", head: true }, { text: "○ a" }]);
});

test("summary counts what the sidebar would show", () => {
	const d = { runs: [{ state: "running" }, { state: "complete" }], todos: [{ subject: "a", status: "completed" }, { subject: "b", status: "pending" }], shells: [{ id: "sh1", status: "", label: "" }, { id: "", status: "+1", label: "" }] };
	assert.equal(summary(d), "1 subagent · todos 1/2 · 1 shell · /sidebar");
	assert.equal(summary({ runs: [], todos: [], shells: [] }), undefined);
});

test("todosFromBranch: state entries win over todo tool results", () => {
	const result = (tasks: unknown) => ({ type: "message", message: { role: "toolResult", toolName: "todo", details: { tasks, nextId: 2 } } });
	const state = (tasks: unknown) => ({ type: "custom", customType: "rpiv-todo-state", data: { tasks, nextId: 2 } });
	const a = [{ id: 1, subject: "a", status: "pending" }];
	const b = [{ id: 1, subject: "b", status: "pending" }];
	assert.deepEqual(todosFromBranch([result(a)]), { tasks: a, nextId: 2 });
	assert.deepEqual(todosFromBranch([state(b), result(a)]), { tasks: b, nextId: 2 });
	assert.deepEqual(todosFromBranch([null, { type: "message", message: { role: "toolResult", toolName: "bash" } }, result("bad")]), { tasks: [] });
});

test("sidebarLines and summary: a paused run is listed as paused, not counted as running", () => {
	const d = { runs: [{ label: "kit.worker", state: "paused", startedAt: 0, activity: { currentTool: "bash" } }], todos: [], shells: [] };
	assert.deepEqual(sidebarLines(d, 10_000), [
		{ text: "Subagents", head: true },
		{ text: "‖ kit.worker 10s paused", tone: "warning" },
	]);
	assert.equal(summary(d), undefined);
});

test("completed todos stay for the run that completed them, then hide; the header keeps the totals", () => {
	const todo = (id: number, status: string) => ({ id, subject: `t${id}`, status });
	const rows = (todos: ReturnType<typeof todo>[], v: ReturnType<typeof todoView>) => sidebarLines({ runs: [], todos, shells: [], hiddenTodos: v.hidden }, 0).map((l) => l.text);
	const v = todoView();
	let todos = [todo(1, "completed"), todo(2, "in_progress"), todo(3, "pending")];
	trackTodos(v, todos, 4);
	assert.deepEqual(rows(todos, v), ["Todos 1/3", "✓ t1", "▸ t2", "○ t3"]);
	hideCompleted(v); // next agent run
	assert.deepEqual(rows(todos, v), ["Todos 1/3", "▸ t2", "○ t3"]);
	todos = [todo(1, "completed"), todo(2, "completed"), todo(3, "completed")];
	trackTodos(v, todos, 4);
	assert.deepEqual(rows(todos, v), ["Todos 3/3", "✓ t2", "✓ t3"]);
	hideCompleted(v);
	assert.deepEqual(rows(todos, v), ["Todos 3/3"]);
	assert.equal(summary({ runs: [], todos, shells: [] }), "todos 3/3 · /sidebar");
	// Reopened: shown again. Cleared and recreated (nextId went down): ids start over, nothing hidden.
	trackTodos(v, [todo(1, "pending"), todo(2, "completed"), todo(3, "completed")], 4);
	assert.deepEqual(rows([todo(1, "pending"), todo(2, "completed"), todo(3, "completed")], v), ["Todos 2/3", "○ t1"]);
	todos = [todo(1, "completed")];
	trackTodos(v, todos, 2);
	hideCompleted(v);
	trackTodos(v, [todo(1, "completed"), todo(2, "pending")], 3);
	assert.deepEqual(rows([todo(1, "completed"), todo(2, "pending")], v), ["Todos 1/2", "○ t2"]);
	trackTodos(v, [], 1); // clear
	todos = [todo(1, "completed")];
	trackTodos(v, todos, 2);
	assert.deepEqual(rows(todos, v), ["Todos 1/1", "✓ t1"]);
});

test("model rules: GPT models get them, others don't", () => {
	for (const id of ["gpt-6.1-sol", "openai/gpt-6.1-sol", "GPT-5", "openai.gpt-6.1-sol", "us.openai.gpt-6.1-sol", "global.openai.gpt-6.1-sol"]) assert.ok(isGpt(id), id);
	for (const id of ["claude-opus-5-5", "chatgpt-x", "mock-1", undefined]) assert.ok(!isGpt(id), id);
	const opts = () => ({ sections: {} as Record<string, string> }) as Parameters<typeof addRules>[0];
	const gpt = opts();
	addRules(gpt, "gpt-6.1-sol", "- rule\n");
	assert.deepEqual(gpt.sections, { gpt_rules: "- rule" });
	const claude = opts();
	addRules(claude, "claude-opus-5-5", "- rule\n");
	assert.deepEqual(claude.sections, {});
});

test("mock model keeps playing its steps when a completion notice arrives mid-turn", async () => {
	const port = 18700 + Math.floor(Math.random() * 200);
	const mock = spawn(process.execPath, [path.join(import.meta.dirname, "mock-llm.mjs"), String(port), "/dev/null"]);
	try {
		await new Promise((r) => setTimeout(r, 300));
		const reply = async (messages: object[]) => (await (await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: "POST", body: JSON.stringify({ model: "m", messages }) })).text()).split("\n")[0];
		const turn = [
			{ role: "user", content: 'Steps:\n@@ {"name":"bg_wait","arguments":{}}\n@@ {"name":"bash","arguments":{"command":"echo next"}}' },
			{ role: "assistant", content: "" },
			{ role: "tool", content: "Waited 1.0s; done." },
		];
		const notice = { role: "user", content: "<pi_subagents_notice>\nBackground task completed: **kit.worker**\n</pi_subagents_notice>" };
		assert.match(await reply([...turn, notice]), /echo next/);
		assert.match(await reply([...turn, { role: "assistant", content: "" }, { role: "tool", content: "next" }, { role: "assistant", content: "FINAL" }, notice]), /GOT REPORT: Background task completed/);
	} finally {
		mock.kill();
	}
});
