// Unit tests for pure logic: node --test test/unit.test.ts (Node 22.18+ strips the types).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { commandVerdict, isShellLog, redact } from "../extensions/guardrails/core.ts";
import { backoff, blockers, busyReasons, deskToken, envToken, promptRefusal, inDesk, keepReconnectToken, keepToken, line, parse, reply, runOutcome, status } from "../extensions/desk-bridge/protocol.ts";
import { COMMANDS, parseCommands, runDescription, sameCommand } from "../extensions/desk/commands.ts";
import { filterState, noticeFor, noticeText, piTabOf, seenFrom, summarize } from "../extensions/desk/state.ts";
import { deskPanels, hideCompleted, sidebarLines, subagentTask, summary, todosFromBranch, todoView, trackTodos } from "../extensions/sidebar/rows.ts";
import { addRules, isGpt } from "../extensions/model-rules/match.ts";
import { drift } from "../extensions/versions/drift.ts";
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

test("subagent rows show the task captured from the parent's own subagent call", () => {
	const runs = [
		{ id: "r1", label: "kit.worker", state: "running", startedAt: 0, activity: { currentTool: "bash" } },
		{ id: "r2", label: "kit.reviewer", state: "complete", startedAt: 0, endedAt: 5_000 },
	];
	const tasks = new Map([["r1", ["Goal: fix the \x1b[31msidebar\x1b[0m rows token=supersecretvalue123"]]]);
	assert.deepEqual(sidebarLines({ runs, todos: [], shells: [], tasks }, 80_000).slice(1, 4), [
		{ text: "● kit.worker 1m20s · bash", tone: "accent" },
		{ text: "  Goal: fix the sidebar rows token=[REDACTED]", tone: "muted" },
		{ text: "✓ kit.reviewer 5s", tone: "success" },
	]);
});

test("subagentTask: run id and first line of each task of an execution call; management calls ignored", () => {
	assert.deepEqual(subagentTask({ agent: "kit.worker", task: "\n  Goal: x\nmore", async: true }, { asyncId: "abc-1", runId: "abc-1" }), ["abc-1", ["Goal: x"]]);
	assert.deepEqual(subagentTask({ task: "overall", tasks: [{ agent: "a", task: "Review A" }, { agent: "b", task: "B\nx" }] }, { runId: "r2" }), ["r2", ["Review A", "B"]]);
	assert.deepEqual(subagentTask({ chain: [{ agent: "a", task: "Step one" }, { parallel: [{ agent: "b", task: "Fan out" }] }] }, { asyncId: "r3" }), ["r3", ["Step one", "Fan out"]]);
	assert.equal(subagentTask({ action: "status", id: "abc-1" }, { asyncId: "abc-1" }), undefined);
	assert.equal(subagentTask({ agent: "kit.worker", task: "x" }, {}), undefined); // foreground: no run id
	assert.equal(subagentTask({ agent: "kit.worker" }, { asyncId: "r4" }), undefined);
	assert.equal(subagentTask(undefined, undefined), undefined);
});

test("a multi-step run lists its steps with their tasks, capped; the count is running leaves, like pi-subagents' footer", () => {
	const step = (i: number, state: string) => ({ id: `step:${i}`, label: "kit.worker", agent: "kit.worker", state, startedAt: 0, ...(state === "complete" ? { endedAt: 30_000 } : {}) });
	const run = { id: "p1", kind: "parallel", label: "kit.worker, kit.worker, +6 more", state: "running", startedAt: 0, children: [step(0, "running"), step(1, "complete"), ...Array.from({ length: 6 }, (_, i) => step(i + 2, "running"))] };
	const tasks = new Map([["p1", ["Review A", "Review B", "Review C"]]]);
	const lines = sidebarLines({ runs: [run], todos: [], shells: [], tasks }, 80_000);
	assert.deepEqual(lines.slice(0, 7), [
		{ text: "Subagents · 7 running", head: true },
		{ text: "● parallel · 8 agents 1m20s", tone: "accent" },
		{ text: "  ● kit.worker 1m20s", tone: "accent" },
		{ text: "    Review A", tone: "muted" },
		{ text: "  ✓ kit.worker 30s", tone: "success" },
		{ text: "    Review B", tone: "muted" },
		{ text: "  ● kit.worker 1m20s", tone: "accent" },
	]);
	assert.deepEqual(lines.at(-1), { text: "  +2 more", tone: "muted" });
	assert.equal(lines.length, 12); // header, run, 3 steps with tasks, 3 without, "+2 more"
	assert.equal(summary({ runs: [run], todos: [], shells: [] }), "7 subagents · /sidebar");
	// A workflow's steps are keyed: the key stands in for the task. A single-step run is one row.
	const wf = { id: "w1", kind: "workflow", label: "x", state: "running", startedAt: 0, children: [{ id: "review-a", label: "review-a", agent: "kit.worker", state: "running", startedAt: 0 }, { id: "review-b", label: "review-b", agent: "kit.worker", state: "complete", startedAt: 0, endedAt: 3_000 }] };
	const single = { id: "s1", kind: "subagent", label: "kit.worker", state: "running", startedAt: 0, children: [step(0, "running")] };
	assert.deepEqual(sidebarLines({ runs: [wf, single], todos: [], shells: [] }, 14_000), [
		{ text: "Subagents · 2 running", head: true },
		{ text: "● workflow · 2 agents 14s", tone: "accent" },
		{ text: "  ● kit.worker 14s", tone: "accent" },
		{ text: "    review-a", tone: "muted" },
		{ text: "  ✓ kit.worker 3s", tone: "success" },
		{ text: "    review-b", tone: "muted" },
		{ text: "● kit.worker 14s", tone: "accent" },
	]);
});

test("version drift: older or unpinned warns, newer and equal are silent", () => {
	const pins = { "@earendil-works/pi-coding-agent": "1.4.0", "pi-subagents": "0.84.0", "pi-ask-user": "0.17.0", "@ff-labs/pi-fff": "0.11.0", "@juicesharp/rpiv-todo": "2.15.0" };
	assert.deepEqual(drift(pins, "1.4.0", ["npm:pi-subagents@0.84.0", { source: "npm:pi-ask-user" }, "../pi-kit"]), []);
	assert.deepEqual(drift(pins, "1.10.0", ["npm:pi-subagents@0.85.0", "npm:@ff-labs/pi-fff@1.0.0"]), []);
	assert.deepEqual(drift(pins, "1.3.9", ["npm:pi-subagents@0.9.0", "npm:pi-ask-user", "npm:@juicesharp/rpiv-todo@^2.15.0", "npm:@ff-labs/pi-fff@0.11.0"]), [
		"pi 1.3.9 (kit tested with 1.4.0)",
		"npm:pi-subagents@0.9.0 (kit tested with npm:pi-subagents@0.84.0)",
		"npm:pi-ask-user (kit tested with npm:pi-ask-user@0.17.0)",
		"npm:@juicesharp/rpiv-todo@^2.15.0 (kit tested with npm:@juicesharp/rpiv-todo@2.15.0)",
	]);
});

test("desk bridge: messages carry v and type; replies echo the id; bad lines are dropped", () => {
	assert.equal(line({ id: "b1", type: "pi.status", agent: "idle" }), '{"v":1,"id":"b1","type":"pi.status","agent":"idle"}\n');
	assert.deepEqual(JSON.parse(reply("7", { ok: false, error: "timeout" })), { v: 1, id: "7", type: "result", result: { ok: false, error: "timeout" } });
	assert.deepEqual(parse('{"v":1,"id":"3","type":"pi.prompt","text":"hi"}'), { v: 1, id: "3", type: "pi.prompt", text: "hi" });
	for (const bad of ["", "nope", "[1]", "null", '{"v":2,"type":"pi.prompt"}']) assert.equal(parse(bad), undefined, bad);
	assert.deepEqual([0, 1, 2, 6, 20].map(backoff), [500, 1000, 2000, 30_000, 30_000]);
});

test("desk bridge: status from idle, run outcome, dialogs and blockers", () => {
	const base = { idle: true, error: false, dialogs: 0, question: false, shells: [], runs: [] };
	assert.deepEqual(status(base), { agent: "idle", waiting: false, question: false, blockers: [] });
	assert.equal(status({ ...base, idle: false }).agent, "working");
	assert.equal(status({ ...base, error: true }).agent, "error");
	assert.equal(status({ ...base, idle: false, error: true }).agent, "working", "a retry after an error is still working");
	assert.equal(status({ ...base, dialogs: 1, idle: false }).waiting, true, "a dialog waits even mid-run");
	assert.equal(status({ ...base, dialogs: 2 }).waiting, true, "overlapping dialogs: still waiting while one is open");
	assert.deepEqual(busyReasons(status(base), false), []);
	assert.deepEqual(busyReasons(status({ ...base, idle: false, dialogs: 1, shells: [{ id: "sh1", status: "1s", label: "make" }] }), true), ["agent working", "a dialog is open", "messages queued", "shell sh1: make"]);
	assert.deepEqual(busyReasons(status({ ...base, question: true, error: true }), false), [], "a question or an error is idle");
	assert.deepEqual([status({ ...base, question: true }).question, status({ ...base, question: true }).waiting], [true, false], "a final question is `question`, not `waiting` (only dialogs wait)");
	assert.equal(status({ ...base, question: true, idle: false }).question, false, "a question mid-run is not reported");
	const ask = (text: string, stopReason = "stop") => [{ role: "user", content: "x" }, { role: "assistant", stopReason, content: [{ type: "text", text }] }];
	assert.deepEqual(runOutcome(ask("Which branch should I use?  ")), { error: false, question: true });
	assert.deepEqual(runOutcome(ask("Done.")), { error: false, question: false });
	assert.deepEqual(runOutcome(ask("", "error")), { error: true, question: false });
	assert.deepEqual(runOutcome(ask("Why?", "aborted")), { error: false, question: false });
	assert.deepEqual(runOutcome(undefined), { error: false, question: false });
});

test("desk bridge: blockers list shells, timers and running subagents, redacted", () => {
	const shells = [
		{ id: "sh1", status: "3s", label: "TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789AB npm run dev" },
		{ id: "wk1", status: "wakes in 1m", label: "check\nthe deploy" },
		{ id: "", status: "+2 more · /shells", label: "" },
	];
	const runs = [{ id: "a1", label: "kit.worker", state: "running" }, { id: "a2", label: "kit.reviewer", state: "complete" }, { id: "a3", kind: "workflow", state: "paused" }];
	const b = blockers(shells, runs);
	assert.deepEqual(b.slice(1), ["timer wk1: check the deploy", "+2 more · /shells", "subagent kit.worker"]);
	assert.match(b[0], /^shell sh1: TOKEN=\[REDACTED\] npm run dev$/);
	assert.ok(!b.join(" ").includes("ghp_"));
	assert.deepEqual(blockers(null as never, [null as never]), []);
});

test("desk bridge: the token leaves process.env but stays readable, then the reconnect token replaces it; inDesk needs socket and token", () => {
	const saved = { s: process.env.PI_DESK_SOCKET, t: process.env.PI_DESK_TOKEN };
	try {
		delete process.env.PI_DESK_SOCKET;
		process.env.PI_DESK_TOKEN = "tok-1";
		assert.equal(inDesk(), false);
		process.env.PI_DESK_SOCKET = "/tmp/x.sock";
		assert.equal(inDesk(), true);
		assert.equal(deskToken(true), "tok-1");
		assert.equal(process.env.PI_DESK_TOKEN, undefined);
		assert.equal(deskToken(), "tok-1");
		assert.equal(inDesk(), true);
		keepReconnectToken("tok-2");
		process.env.PI_DESK_TOKEN = "tok-1"; // still in the initial environment of a reloaded runtime
		assert.equal(deskToken(true), "tok-2", "the reconnect token wins over the revoked env token");
	} finally {
		(globalThis as any)[Symbol.for("pi-kit.desk-bridge.token")] = undefined;
		for (const [k, v] of [["PI_DESK_SOCKET", saved.s], ["PI_DESK_TOKEN", saved.t]] as const) v === undefined ? delete process.env[k] : (process.env[k] = v);
	}
});

test("deskPanels: one panel per sidebar section, empty rows when it has nothing", () => {
	const d = { runs: [{ id: "a1", label: "kit.worker", state: "running", startedAt: 0 }], todos: [], shells: [{ id: "sh1", status: "5s", label: "npm test" }] };
	const p = deskPanels(d, 65_000);
	assert.deepEqual(p.map((x) => [x.panel, x.title, x.rows.length > 0]), [["subagents", "Subagents", true], ["shells", "Shells", true], ["todos", "Todos", false]]);
	assert.deepEqual(p[1].rows, [{ text: "Shells", head: true }, { text: "sh1 5s", tone: "accent" }, { text: "  npm test", tone: "muted" }]);
	assert.deepEqual(p[0].rows[0], { text: "Subagents · 1 running", head: true });
});

test("desk bridge: pi.prompt is refused while a dialog is open or a manual /compact runs", () => {
	assert.equal(promptRefusal({ dialogs: 0, compacting: false }), undefined);
	assert.equal(promptRefusal({ dialogs: 1, compacting: false }), "pi is waiting on the user (a dialog is open)");
	assert.equal(promptRefusal({ dialogs: 0, compacting: true }), "pi is compacting the session; retry when it is idle");
});

test("desk: the control token is kept apart from the pi tab's token", () => {
	const saved = { c: process.env.PI_DESK_CONTROL_TOKEN, t: process.env.PI_DESK_TOKEN };
	try {
		process.env.PI_DESK_CONTROL_TOKEN = "ctl-1";
		process.env.PI_DESK_TOKEN = "tab-1";
		assert.equal(envToken("PI_DESK_CONTROL_TOKEN", true), "ctl-1");
		assert.equal(process.env.PI_DESK_CONTROL_TOKEN, undefined);
		keepToken("PI_DESK_CONTROL_TOKEN", "ctl-2");
		assert.equal(envToken("PI_DESK_CONTROL_TOKEN"), "ctl-2");
		assert.equal(deskToken(), "tab-1", "the bridge's token is untouched");
	} finally {
		(globalThis as any)[Symbol.for("pi-kit.desk.token.PI_DESK_CONTROL_TOKEN")] = undefined;
		for (const [k, v] of [["PI_DESK_CONTROL_TOKEN", saved.c], ["PI_DESK_TOKEN", saved.t]] as const) v === undefined ? delete process.env[k] : (process.env[k] = v);
	}
});

test("desk: desk_run's description is generated from the command list; list_commands results are checked", () => {
	const d = runDescription(COMMANDS);
	assert.match(d, /^- close_tab \{tab_id\}: close a shell tab .* \[confirms: tab_close\]$/m);
	assert.match(d, /^- pi_reload \{tab_id\}: .* \[confirms: session_restart, long-running\]$/m);
	assert.match(d, /^- rescan: .* \[long-running\]$/m);
	for (const userOnly of ["set_confirm_policy", "set_close_confirm", "panel.set", "pi.status"]) assert.ok(!d.includes(`- ${userOnly}`), userOnly);
	assert.deepEqual(parseCommands({ commands: [{ type: "x", args: "a, b?", does: "does x", confirm_class: "delete", long_running: true, extra: 1 }, { type: "y" }] }), [
		{ type: "x", args: "a, b?", does: "does x", confirm_class: "delete", long_running: true },
		{ type: "y", does: "" },
	]);
	for (const bad of [undefined, {}, { commands: [] }, { commands: [{ does: "no type" }] }, { commands: "x" }]) assert.equal(parseCommands(bad), undefined);
});

test("desk: sameCommand matches the same type and target, ignoring confirm and extra fields", () => {
	const ours = { type: "close_tab", tab_id: 5 };
	assert.ok(sameCommand({ type: "close_tab", tab_id: 5, confirm: "<redacted>" }, ours));
	assert.ok(!sameCommand({ type: "close_tab", tab_id: 6 }, ours));
	assert.ok(!sameCommand({ type: "focus_tab", tab_id: 5 }, ours));
	assert.ok(!sameCommand(undefined, ours));
});

const deskState = {
	version: 9,
	projects: [{ id: 1, cwd: "/w/app", label: "~/w/app", name: "App" }, { id: 2, cwd: "/w/kit", label: "~/w/kit", name: "" }],
	selected_project: 1,
	sessions: Array.from({ length: 7 }, (_, i) => ({ id: `s${i}`, when: "2026-10-30 10:00", title: `chat ${i}` })),
	open_sessions: [
		{ id: 3, pi_session_id: "aaaa", project_id: 1, active_tab: 2, tabs: [
			{ id: 2, kind: "pi", title: "pi", status: "running", agent: "working", waiting: false, question: false, blockers: ["shell sh1: npm test"], panels: [{ panel: "todos", title: "Todos", rows: [{ text: "Todos 1/2", head: true }] }] },
			{ id: 4, kind: "shell", title: "shell 1", status: "running" },
		] },
		{ id: 5, pi_session_id: "bbbb", project_id: 2, active_tab: 6, tabs: [{ id: 6, kind: "pi", title: "pi", status: "running", agent: "idle", waiting: true, question: false, blockers: [] }] },
	],
	current_session: 3,
	pending_confirmations: [{ summary: "Close shell 1?", caller: "control", class: "tab_close", command: { type: "close_tab", tab_id: 4 } }],
};

test("desk: state summary is compact and readable; filters narrow it", () => {
	assert.equal(
		summarize(deskState),
		[
			"pi-desk state v9",
			"Projects:",
			"- project 1 App (/w/app) [selected]",
			"  - session 3 [current] pi_session_id aaaa",
			'    - tab 2 pi "pi" · working · busy: shell sh1: npm test · panels: Todos 1/2 [active]',
			'    - tab 4 shell "shell 1"',
			"- project 2 ~/w/kit (/w/kit)",
			"  - session 5 pi_session_id bbbb",
			'    - tab 6 pi "pi" · waiting for the user [active]',
			"Saved pi sessions of project 1 (7, newest first; open_session resumes one):",
			"- s0 2026-10-30 10:00 chat 0",
			"- s1 2026-10-30 10:00 chat 1",
			"- s2 2026-10-30 10:00 chat 2",
			"- s3 2026-10-30 10:00 chat 3",
			"- s4 2026-10-30 10:00 chat 4",
			"- … 2 more (full: true lists them)",
			"Waiting for the user's confirmation in pi-desk:",
			"- Close shell 1? (control, tab_close)",
		].join("\n"),
	);
	const kit = filterState(deskState, { project: "kit" });
	assert.deepEqual([kit.projects.map((p: any) => p.id), kit.open_sessions.map((s: any) => s.id), kit.sessions], [[2], [5], []]);
	assert.deepEqual(filterState(deskState, { project: 1, session: 3 }).open_sessions.map((s: any) => s.id), [3]);
	assert.deepEqual(filterState(deskState, { session: 5 }).projects.length, 2, "a session filter keeps every project");
	assert.equal(piTabOf(deskState, 5), 6);
	assert.equal(piTabOf(deskState, 99), undefined);
	assert.equal(summarize(null), "pi-desk sent no state.");
});

test("desk: notices only for waiting, error, question and finished runs; coalesced per tab and labelled", () => {
	const seen = seenFrom(deskState);
	const ev = (tab_id: number, agent: string, waiting = false, question = false) => ({ event: "command", caller: "panel", command: { type: "pi.status", tab_id, agent, waiting, question, blockers: [] }, result: { ok: true } });
	assert.deepEqual(noticeFor(ev(2, "working"), seen), undefined, "still working");
	assert.deepEqual(noticeFor(ev(2, "idle"), seen), { tab: 2, kind: "finished" });
	assert.deepEqual(noticeFor(ev(2, "idle"), seen), undefined, "idle again is not news");
	assert.deepEqual(noticeFor(ev(6, "idle", true), seen), undefined, "tab 6 was already waiting");
	assert.deepEqual(noticeFor(ev(6, "idle"), seen), undefined);
	assert.deepEqual(noticeFor(ev(6, "idle", true), seen), { tab: 6, kind: "waiting" });
	assert.deepEqual(noticeFor(ev(9, "idle"), seen), undefined, "an unknown tab going idle: no run seen");
	assert.deepEqual(noticeFor(ev(9, "error"), seen), { tab: 9, kind: "error" });
	assert.deepEqual(noticeFor(ev(2, "idle", false, true), seen), { tab: 2, kind: "question" });
	assert.equal(noticeFor({ event: "command", command: { type: "close_tab", tab_id: 4 } }, seen), undefined);
	assert.equal(noticeFor({ event: "finished", request_id: 1 }, seen), undefined);
	const text = noticeText([{ tab: 2, kind: "finished" }, { tab: 6, kind: "waiting" }, { tab: 2, kind: "question" }, { tab: 9, kind: "error" }], deskState);
	assert.deepEqual(text.split("\n").slice(1), ["- ~/w/kit (session 5, tab 6): waiting for you (a dialog is open)", "- App (session 3, tab 2): asked a question", "- tab 9: stopped with an error"]);
	assert.match(text, /^pi-desk: /);
	assert.equal(noticeText([], deskState), "");
	const many = noticeText(Array.from({ length: 12 }, (_, i) => ({ tab: 100 + i, kind: "finished" as const })), deskState).split("\n");
	assert.equal(many.length, 9);
	assert.equal(many[8], "- … 5 more (desk_state shows all)");
});
