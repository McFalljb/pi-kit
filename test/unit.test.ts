// Unit tests for pure logic: node --test test/unit.test.ts (Node 22.18+ strips the types).
import assert from "node:assert/strict";
import { test } from "node:test";
import { commandVerdict, redact } from "../extensions/guardrails/core.ts";
import { batchText, clip, compilePattern, lastLines, MAX_BATCH, MAX_LINE, splitLines } from "../extensions/shell/lines.ts";

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

test("batchText caps lines per notice", () => {
	const lines = Array.from({ length: MAX_BATCH + 3 }, (_, i) => `l${i}`);
	const t = batchText(lines);
	assert.equal(t.split("\n").length, MAX_BATCH + 1);
	assert.match(t, /3 more matching lines/);
	assert.equal(batchText(["one"]), "one");
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
