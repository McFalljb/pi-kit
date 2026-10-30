// Contract tests: the pins are complete, and the pinned packages still have the internals the kit relies
// on. Run after `npm ci --ignore-scripts --prefix test/ci`: node --test test/contracts.test.ts
// A failure names the kit file that depends on the changed internal; fix that file or the pin.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { addRules } from "../extensions/model-rules/match.ts";

const KIT = fileURLToPath(new URL("..", import.meta.url));
const NM = path.join(KIT, "test/ci/node_modules");
const read = (f: string) => readFileSync(path.join(KIT, f), "utf8");
const load = (p: string) => import(path.join(NM, p));
/** Every .ts/.js file of an installed package, concatenated (no nested node_modules). */
function source(pkg: string): string {
	const out: string[] = [];
	const walk = (d: string) => {
		for (const e of readdirSync(d, { withFileTypes: true })) {
			if (e.name === "node_modules") continue;
			const f = path.join(d, e.name);
			if (e.isDirectory()) walk(f);
			else if (/\.(ts|js|mjs)$/.test(e.name)) out.push(readFileSync(f, "utf8"));
		}
	};
	walk(path.join(NM, pkg));
	return out.join("\n");
}

test("every recommended package in packages.json is pinned in test/ci/package.json", () => {
	const ci = JSON.parse(read("test/ci/package.json")).dependencies;
	for (const p of JSON.parse(read("packages.json")).recommended) assert.match(ci[p.name] ?? "", /^\d+\.\d+\.\d+$/, `${p.name} needs an exact version in test/ci/package.json (install.sh, smoke.sh and extensions/versions read it there)`);
});

test("rpiv-todo: widget key, state entry and todo result shape (extensions/sidebar/index.ts, rows.ts)", () => {
	const src = source("@juicesharp/rpiv-todo");
	assert.match(src, /WIDGET_KEY = "rpiv-todos"/, 'rpiv-todo widget key is no longer "rpiv-todos": extensions/sidebar/index.ts hides it by that key');
	assert.match(src, /STATE_ENTRY_TYPE = "rpiv-todo-state"/, 'rpiv-todo state entry is no longer "rpiv-todo-state": extensions/sidebar/rows.ts todosFromBranch reads it');
	assert.match(src, /interface TaskDetails \{[^}]*tasks: Task\[\];[^}]*nextId: number;/, "rpiv-todo todo result details are no longer {tasks, nextId}: extensions/sidebar/index.ts and rows.ts read details.tasks");
});

test("pi-subagents: events, status RPC and snapshot run shape (extensions/sidebar/index.ts, rows.ts)", async () => {
	const rpc = await load("pi-subagents/src/extension/rpc.js");
	const types = await load("pi-subagents/src/shared/types.js");
	const known = new Set([...Object.values(types), ...Object.values(rpc)]);
	const used = JSON.parse(read("extensions/sidebar/index.ts").match(/SUBAGENT_EVENTS = (\[[^\]]*\])/)![1]);
	for (const e of used) assert.ok(known.has(e), `pi-subagents no longer defines event ${e}: extensions/sidebar/index.ts SUBAGENT_EVENTS listens for it`);
	assert.equal(rpc.SUBAGENT_RPC_REQUEST_EVENT, "subagents:rpc:v1:request", "pi-subagents RPC request event changed: extensions/sidebar/index.ts readSubagents emits it");
	assert.equal(rpc.SUBAGENT_RPC_REPLY_EVENT_PREFIX, "subagents:rpc:v1:reply:", "pi-subagents RPC reply event changed: extensions/sidebar/index.ts readSubagents listens for it");
	assert.ok(rpc.SUBAGENT_RPC_METHODS.includes("status"), "pi-subagents RPC has no status method: extensions/sidebar/index.ts readSubagents calls it");
	assert.match(source("pi-subagents/src/extension"), /asyncSnapshot: buildAsyncStatusSnapshotForState/, "pi-subagents status reply no longer has data.asyncSnapshot: extensions/sidebar/index.ts reads data.asyncSnapshot.runs");
	const { projectAsyncStatusSnapshot } = await load("pi-subagents/src/runs/shared/async-status-projection.js");
	const runs = projectAsyncStatusSnapshot([
		{ asyncId: "a1", asyncDir: "/x", status: "running", agents: ["kit.worker"], startedAt: 1000, currentTool: "bash" },
		{ asyncId: "a2", asyncDir: "/x", status: "complete", agents: ["kit.reviewer"], startedAt: 1000, updatedAt: 3000 },
	]).runs;
	assert.deepEqual(
		runs.map((r: any) => ({ label: r.label, state: r.state, startedAt: r.startedAt, endedAt: r.endedAt, tool: r.activity?.currentTool })),
		[
			{ label: "kit.worker", state: "running", startedAt: 1000, endedAt: undefined, tool: "bash" },
			{ label: "kit.reviewer", state: "complete", startedAt: 1000, endedAt: 3000, tool: undefined },
		],
		"pi-subagents snapshot run shape changed: extensions/sidebar/rows.ts Run reads label, state, startedAt, endedAt, activity.currentTool",
	);
});

test("pi-tui: layout exports and TUI's private layoutRoot (extensions/sidebar/index.ts)", async () => {
	const tui = await load("@earendil-works/pi-tui/dist/index.js");
	for (const name of ["HStack", "ScrollView", "isViewportTUI"]) assert.equal(typeof tui[name], "function", `pi-tui no longer exports ${name}: extensions/sidebar/index.ts uses it`);
	const viewport = Object.values(tui).find((v: any) => typeof v?.prototype?.setLayoutRoot === "function") as Function | undefined;
	assert.ok(viewport, "no pi-tui class has setLayoutRoot: extensions/sidebar/index.ts mount() uses it");
	assert.match(viewport.toString(), /^\s*layoutRoot;/m, "pi-tui's viewport TUI has no layoutRoot field: extensions/sidebar/index.ts layoutRoot() reads it");
	assert.match(viewport.toString(), /this\.layoutRoot = component/, "pi-tui setLayoutRoot no longer stores layoutRoot: extensions/sidebar/index.ts layoutRoot() reads it");
});

test("pi: getAgentDir, VERSION and system prompt sections (extensions/model-rules, extensions/versions)", async () => {
	const pi = await load("@earendil-works/pi-coding-agent/dist/index.js");
	assert.equal(typeof pi.getAgentDir, "function", "pi no longer exports getAgentDir: extensions/model-rules/index.ts and extensions/versions/index.ts use it");
	assert.equal(typeof pi.VERSION, "string", "pi no longer exports VERSION: extensions/versions/index.ts compares it with the pin");
	assert.match(source("@earendil-works/pi-coding-agent/dist/core/extensions"), /type: "before_agent_start",[\s\S]{0,200}systemPromptOptions: currentOptions/, "pi's before_agent_start event no longer carries systemPromptOptions: extensions/model-rules/index.ts edits it");
	const sp = await load("@earendil-works/pi-coding-agent/dist/core/system-prompt.js");
	const options = sp.normalizeBuildSystemPromptOptions({ cwd: "/x" });
	addRules(options, "gpt-6", "RULES");
	assert.match(sp.buildSystemPrompt(options), /<gpt_rules>\nRULES\n<\/gpt_rules>/, "pi no longer renders systemPromptOptions.sections: extensions/model-rules adds gpt_rules there");
});
