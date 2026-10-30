// Pure helpers for the sidebar (unit-tested in test/unit.test.ts): plain-text rows, no styling.

import { clip, duration } from "../shell/lines.ts";

export type Tone = "accent" | "muted" | "dim" | "warning" | "success" | "error";
export interface Line {
	text: string;
	tone?: Tone;
	head?: boolean; // a section title
}

/** A run from pi-subagents' status reply (`data.asyncSnapshot.runs`); a parallel or chain run has its steps as children. */
export interface Run {
	id?: string; // a run: its async id; a step: "step:<index>", or its workflow key (then also its label)
	kind?: string; // "subagent", "workflow", ...
	label?: string;
	agent?: string; // steps
	children?: Run[];
	state?: string;
	startedAt?: number;
	endedAt?: number;
	activity?: { currentTool?: string };
}
/** An rpiv-todo task. */
export interface Todo {
	id?: number;
	subject: string;
	status: string;
	activeForm?: string;
}
/** A row from the kit shell extension's panelRows(); id "" is its "+N more" row. */
export interface ShellRow {
	id: string;
	status: string;
	label: string;
	warn?: boolean;
}
export interface Data {
	runs: Run[];
	todos: Todo[];
	shells: ShellRow[];
	hiddenTodos?: ReadonlySet<number>; // completed todo ids no longer listed (TodoView.hidden)
	tasks?: ReadonlyMap<string, string[]>; // run id -> task line per step, from the parent's own subagent calls
}

/** Untrusted text as one line: escapes stripped, secrets redacted, whitespace collapsed. */
const one = (s: unknown) => clip(String(s ?? "")).replace(/\s+/g, " ").trim();
const RUNNING = new Set(["queued", "running"]); // a paused run is listed, but not counted as running
const RUN_ICON: Record<string, [string, Tone]> = { queued: ["…", "muted"], running: ["●", "accent"], paused: ["‖", "warning"], complete: ["✓", "success"] };
const MAX_STEPS = 6; // steps listed per run, then "+N more"

/** Steps listed under a run: only when there are several (a single step is the run itself). */
const steps = (r: Run) => (Array.isArray(r.children) && r.children.length > 1 ? r.children : []);
/** Running agents, counted like pi-subagents' own "N active agents": each running step, else the run. */
const runningLeaves = (r: Run): number => (steps(r).length ? steps(r).reduce((n, c) => n + runningLeaves(c), 0) : RUNNING.has(r?.state ?? "") ? 1 : 0);
const runningCount = (d: Data) => d.runs.reduce((n, r) => n + runningLeaves(r), 0);

function runRow(r: Run, name: unknown, task: unknown, indent: string, now: number): Line[] {
	const state = r.state ?? "";
	const [icon, tone] = RUN_ICON[state] ?? ["✗", "warning"];
	const took = typeof r.startedAt === "number" ? ` ${duration(Math.max(0, (r.endedAt ?? now) - r.startedAt))}` : "";
	const extra = RUNNING.has(state) ? (r.activity?.currentTool ? ` · ${one(r.activity.currentTool)}` : "") : state === "complete" ? "" : ` ${one(state) || "?"}`;
	const out: Line[] = [{ text: `${indent}${icon} ${one(name) || "subagent"}${took}${extra}`, tone }];
	if (one(task)) out.push({ text: `${indent}  ${one(task)}`, tone: "muted" });
	return out;
}

function runLines(d: Data, now: number): Line[] {
	if (!d.runs.length) return [];
	const active = runningCount(d);
	const out: Line[] = [{ text: active ? `Subagents · ${active} running` : "Subagents", head: true }];
	for (const r of d.runs) {
		const texts = (r.id && d.tasks?.get(r.id)) || [];
		const kids = steps(r);
		if (!kids.length) out.push(...runRow(r, r.label, texts[0], "", now));
		else out.push(...runRow(r, `${one(r.kind) || "run"} · ${kids.length} agents`, "", "", now));
		kids.slice(0, MAX_STEPS).forEach((c, i) => {
			const index = Number(/^step:(\d+)$/.exec(String(c?.id))?.[1] ?? i);
			const key = c.agent && c.label !== c.agent ? c.label : ""; // a workflow step's key
			out.push(...runRow(c, c.agent ?? c.label, texts[index] || key, "  ", now));
		});
		if (kids.length > MAX_STEPS) out.push({ text: `  +${kids.length - MAX_STEPS} more`, tone: "muted" });
	}
	return out;
}

function todoLines(todos: Todo[], hidden: ReadonlySet<number>): Line[] {
	const live = todos.filter((t) => t.status !== "deleted");
	if (!live.length) return [];
	const out: Line[] = [{ text: `Todos ${live.filter((t) => t.status === "completed").length}/${live.length}`, head: true }];
	for (const t of live) {
		if (t.status === "completed" && hidden.has(t.id!)) continue;
		if (t.status === "in_progress") out.push({ text: `▸ ${one(t.activeForm) || one(t.subject)}`, tone: "accent" });
		else if (t.status === "completed") out.push({ text: `✓ ${one(t.subject)}`, tone: "dim" });
		else out.push({ text: `○ ${one(t.subject)}` });
	}
	return out;
}

function shellLines(rows: ShellRow[]): Line[] {
	if (!rows.length) return [];
	const out: Line[] = [{ text: "Shells", head: true }];
	for (const r of rows) {
		if (!r.id) out.push({ text: one(r.status), tone: "muted" });
		else out.push({ text: `${one(r.id)} ${one(r.status)}`, tone: r.warn ? "warning" : "accent" }, { text: `  ${one(r.label)}`, tone: "muted" });
	}
	return out;
}

/** One section's rows, or one error row: a bad record never breaks the rest of the sidebar. */
function section(name: string, build: () => Line[]): Line[] {
	try {
		return build();
	} catch (e) {
		return [{ text: `${name}: ${one((e as Error)?.message ?? e)}`, tone: "error" }];
	}
}

/** The sidebar's rows: subagents, shells, todos, a blank row between sections. */
export function sidebarLines(d: Data, now: number): Line[] {
	const parts = [section("subagents", () => runLines(d, now)), section("shells", () => shellLines(d.shells)), section("todos", () => todoLines(d.todos, d.hiddenTodos ?? new Set()))].filter((p) => p.length);
	if (!parts.length) return [{ text: "No subagents, todos or shells", tone: "muted" }];
	return parts.flatMap((p, i) => (i ? [{ text: "" }, ...p] : p));
}

/** Footer text for when the sidebar is not on screen, e.g. "2 subagents · todos 1/4 · 1 shell · /sidebar". */
export function summary(d: Data): string | undefined {
	try {
		const runs = runningCount(d);
		const todos = d.todos.filter((t) => t.status !== "deleted");
		const shells = d.shells.filter((r) => r.id).length;
		const parts = [runs ? `${runs} subagent${runs === 1 ? "" : "s"}` : "", todos.length ? `todos ${todos.filter((t) => t.status === "completed").length}/${todos.length}` : "", shells ? `${shells} shell${shells === 1 ? "" : "s"}` : ""].filter(Boolean);
		return parts.length ? `${parts.join(" · ")} · /sidebar` : undefined;
	} catch {
		return undefined;
	}
}

export interface TodoState {
	tasks: Todo[];
	nextId?: number;
}

/** The current rpiv-todo state on a session branch: its state entries win over `todo` tool results. */
export function todosFromBranch(entries: Iterable<unknown>): TodoState {
	let fromEntries: TodoState | undefined;
	let fromResults: TodoState | undefined;
	for (const entry of entries) {
		const e = entry as { type?: string; customType?: string; data?: TodoState; message?: { role?: string; toolName?: string; details?: TodoState } };
		if (e?.type === "custom" && e.customType === "rpiv-todo-state" && Array.isArray(e.data?.tasks)) fromEntries = e.data;
		else if (e?.type === "message" && e.message?.role === "toolResult" && e.message.toolName === "todo" && Array.isArray(e.message.details?.tasks)) fromResults = e.message.details;
	}
	const s = fromEntries ?? fromResults;
	return s ? { tasks: s.tasks, ...(typeof s.nextId === "number" ? { nextId: s.nextId } : {}) } : { tasks: [] };
}

/**
 * Like rpiv-todo's own panel, a completed todo stays listed for the rest of the agent run that
 * completed it (`pending`) and is hidden from the next run on (`hidden`). Display only.
 */
export interface TodoView {
	pending: Set<number>;
	hidden: Set<number>;
	nextId?: number;
}
export const todoView = (): TodoView => ({ pending: new Set(), hidden: new Set() });

/** Record a new todo list. A lower nextId means it was cleared and its ids start over. */
export function trackTodos(v: TodoView, todos: Todo[], nextId?: number): void {
	if (nextId !== undefined && v.nextId !== undefined && nextId < v.nextId) {
		v.pending.clear();
		v.hidden.clear();
	}
	if (nextId !== undefined) v.nextId = nextId;
	const done = new Set(todos.filter((t) => t?.status === "completed" && typeof t.id === "number").map((t) => t.id!));
	for (const set of [v.pending, v.hidden]) for (const id of set) if (!done.has(id)) set.delete(id);
	for (const id of done) if (!v.hidden.has(id)) v.pending.add(id);
}

/** On agent_start: the todos completed in earlier runs stop being listed. */
export function hideCompleted(v: TodoView): void {
	for (const id of v.pending) v.hidden.add(id);
	v.pending.clear();
}

/**
 * [run id, first task line] from the parent's own `subagent` tool call and its result, for the row
 * pi-subagents' public status leaves without task text. Undefined for management calls and results
 * without a run id.
 */
export function subagentTask(input: unknown, details: unknown): [string, string[]] | undefined {
	type Item = { task?: unknown; parallel?: { task?: unknown }[] };
	const i = input as { action?: unknown; task?: unknown; tasks?: Item[]; chain?: Item[] } | undefined;
	const d = details as { asyncId?: unknown; runId?: unknown } | undefined;
	const id = d?.asyncId ?? d?.runId;
	if (!i || i.action !== undefined || typeof id !== "string" || !id) return undefined;
	const first = (t: unknown) => (typeof t === "string" ? t.trim().split("\n")[0].trim() : "");
	const items = Array.isArray(i.tasks) ? i.tasks : Array.isArray(i.chain) ? i.chain : undefined;
	const lines = items ? items.map((s) => first(s?.task ?? (Array.isArray(s?.parallel) ? s.parallel[0]?.task : undefined))) : [first(i.task)];
	return lines.some(Boolean) ? [id, lines] : undefined;
}
