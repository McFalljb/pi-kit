// Unit tests for pure logic: node --test test/unit.test.ts (Node 22.18+ strips the types).
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { commandVerdict, isShellLog, redact, secretDir } from "../extensions/guardrails/core.ts";
import { clip, compilePattern, lastLines, MAX_LINE, splitLines } from "../extensions/shell/lines.ts";

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

test("commandVerdict: secrets block, dangerous asks, read-only blocks mutation", () => {
	assert.match(commandVerdict("cat .env", false).block!, /secret/);
	assert.match(commandVerdict("sleep 1; printenv", false).block!, /secret/);
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

test("secret files: bare auth.json and credentials (P2-4)", () => {
	for (const c of ["cat auth.json", "cat ./auth.json", "cp credentials /tmp/x", "less ~/.config/gcloud/credentials", "cat 'credentials'"]) {
		assert.match(commandVerdict(c, false).block ?? "", /secret/, c);
	}
	for (const c of ["cat credentials.example", "cat oauth.json", "go test ./credentials_test.go", "cat mycredentials", "cat docs/credentials.md", "ls credentials-helper"]) {
		assert.equal(commandVerdict(c, false).block, undefined, c);
	}
});

test("secretDir rejects credential and agent directories as cwd (P2-4)", () => {
	const home = "/home/u";
	assert.equal(secretDir("/home/u/.ssh", home, "/home/u/.pi/agent"), "/home/u/.ssh");
	assert.equal(secretDir("/home/u/.aws/sso", home, "/home/u/.pi/agent"), "/home/u/.aws");
	assert.equal(secretDir("/home/u/.pi/agent/sessions", home, "/home/u/.pi/agent"), "/home/u/.pi/agent");
	assert.equal(secretDir("/opt/agent", home, "/opt/agent"), "/opt/agent");
	assert.equal(secretDir("/home/u/.sshx", home, "/home/u/.pi/agent"), undefined);
	assert.equal(secretDir("/home/u/src", home, "/home/u/.pi/agent"), undefined);
});

test("shell log reads get assignment redaction (P3-4)", () => {
	const dir = path.join(os.tmpdir(), "pi-shell-abc123");
	assert.equal(isShellLog(path.join(dir, "sh1.log"), "/x"), true);
	assert.equal(isShellLog("sh1.log", dir), true);
	assert.equal(isShellLog(path.join(dir, "notes.txt"), "/x"), false);
	assert.equal(isShellLog("/repo/sh1.log", "/x"), false);
});
