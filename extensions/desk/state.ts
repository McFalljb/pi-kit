// pi-desk state and events for the Home agent (unit-tested in test/unit.test.ts): a compact state
// summary, filters, and short notices from other tabs' status changes. Shapes: pi-desk
// docs/PROTOCOL.md §3 (state snapshot, events).

const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const one = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim();

export interface Filter {
	project?: number | string; // project id, or a piece of its name or path
	session?: number; // open session id
}

/** Whether project `p` matches the filter's project (id, or a case-insensitive piece of name/label/cwd). */
function projectMatches(p: any, f: Filter): boolean {
	if (f.project === undefined || f.project === "") return true;
	if (typeof f.project === "number" || /^\d+$/.test(f.project)) return p?.id === Number(f.project);
	const q = f.project.toLowerCase();
	return [p?.name, p?.label, p?.cwd].some((s) => typeof s === "string" && s.toLowerCase().includes(q));
}

/** The snapshot narrowed to the filter's projects and open sessions (same shape). */
export function filterState(state: any, f: Filter): any {
	if (!state || typeof state !== "object") return state;
	const projects = arr(state.projects).filter((p) => projectMatches(p, f));
	const ids = new Set(projects.map((p) => p.id));
	const open = arr(state.open_sessions).filter((s) => ids.has(s.project_id) && (f.session === undefined || s.id === f.session));
	return { ...state, projects, open_sessions: open, ...(ids.has(state.selected_project) ? {} : { sessions: [] }) };
}

/** One tab as a short line: id, kind, title, process and pi status, panel headers. */
export function tabLine(t: any): string {
	const parts = [`tab ${t.id} ${one(t.kind)} "${one(t.title)}"`];
	if (t.status && t.status !== "running") parts.push(one(t.status));
	if (t.kind === "pi") {
		const agent = t.waiting ? "waiting for the user" : t.agent === "idle" && t.question ? "idle, asked a question" : one(t.agent) || "unknown";
		parts.push(agent);
		if (arr(t.blockers).length) parts.push(`busy: ${arr(t.blockers).map(one).join("; ")}`);
		const heads = arr(t.panels).map((p) => one(arr(p.rows).find((r) => r?.head)?.text || p.title || p.panel)).filter(Boolean);
		if (heads.length) parts.push(`panels: ${heads.join(", ")}`);
	}
	return parts.join(" · ");
}

/** A compact, readable summary of the snapshot (already filtered). */
export function summarize(state: any): string {
	if (!state || typeof state !== "object") return "pi-desk sent no state.";
	const out = [`pi-desk state v${state.version ?? "?"}`];
	const projects = arr(state.projects);
	const open = arr(state.open_sessions);
	out.push(projects.length ? "Projects:" : "Projects: none");
	for (const p of projects) {
		out.push(`- project ${p.id} ${one(p.name) || one(p.label)} (${one(p.cwd)})${p.id === state.selected_project ? " [selected]" : ""}`);
		for (const s of open.filter((s) => s.project_id === p.id)) {
			out.push(`  - session ${s.id}${s.id === state.current_session ? " [current]" : ""} pi_session_id ${one(s.pi_session_id) || "?"}`);
			for (const t of arr(s.tabs)) out.push(`    - ${tabLine(t)}${t.id === s.active_tab ? " [active]" : ""}`);
		}
	}
	const sessions = arr(state.sessions);
	if (sessions.length) {
		out.push(`Saved pi sessions of project ${state.selected_project} (${sessions.length}, newest first; open_session resumes one):`);
		for (const s of sessions.slice(0, 5)) out.push(`- ${one(s.id)} ${one(s.when)} ${one(s.title)}`);
		if (sessions.length > 5) out.push(`- … ${sessions.length - 5} more (full: true lists them)`);
	}
	const pending = arr(state.pending_confirmations);
	if (pending.length) {
		out.push("Waiting for the user's confirmation in pi-desk:");
		for (const c of pending) out.push(`- ${one(c.summary)} (${one(c.caller)}, ${one(c.class)})`);
	}
	return out.join("\n");
}

/** The pi tab of an open session (for desk_prompt/desk_wait given a session), or undefined. */
export function piTabOf(state: any, session: number): number | undefined {
	return arr(arr(state?.open_sessions).find((s) => s.id === session)?.tabs).find((t) => t?.kind === "pi")?.id;
}

/** A tab and the open session and project it is in, from the snapshot. */
export function findTab(state: any, tabId: number): { tab: any; session: any; project: any } | undefined {
	for (const s of arr(state?.open_sessions)) {
		const tab = arr(s.tabs).find((t) => t?.id === tabId);
		if (tab) return { tab, session: s, project: arr(state.projects).find((p) => p.id === s.project_id) };
	}
}

export type Seen = { agent: string; waiting: boolean; question: boolean };
export type Kind = "waiting" | "question" | "finished" | "error";
export interface Notice {
	tab: number;
	kind: Kind;
}

/** The pi tabs' statuses in a snapshot, to compare later events with. */
export function seenFrom(state: any): Map<number, Seen> {
	const m = new Map<number, Seen>();
	for (const s of arr(state?.open_sessions)) for (const t of arr(s.tabs)) if (t?.kind === "pi") m.set(t.id, { agent: one(t.agent), waiting: !!t.waiting, question: !!t.question });
	return m;
}

/**
 * The notice a `command` event is worth to the Home agent, if any: only a pi tab's status turning
 * waiting (a dialog is open), error, a question, or a finished run (working → idle). Updates `seen`.
 */
export function noticeFor(ev: any, seen: Map<number, Seen>): Notice | undefined {
	const c = ev?.command;
	if (ev?.event !== "command" || c?.type !== "pi.status" || typeof c.tab_id !== "number" || ev.result?.ok === false) return;
	const was = seen.get(c.tab_id);
	const now: Seen = { agent: one(c.agent), waiting: !!c.waiting, question: !!c.question };
	seen.set(c.tab_id, now);
	if (now.waiting) return was?.waiting ? undefined : { tab: c.tab_id, kind: "waiting" };
	if (now.agent === "error") return was?.agent === "error" ? undefined : { tab: c.tab_id, kind: "error" };
	if (now.agent === "idle" && now.question && !(was?.agent === "idle" && was.question)) return { tab: c.tab_id, kind: "question" };
	if (now.agent === "idle" && was?.agent === "working") return { tab: c.tab_id, kind: "finished" };
}

const WORDS: Record<Kind, string> = { waiting: "waiting for you (a dialog is open)", question: "asked a question", finished: "finished its run", error: "stopped with an error" };
const MAX_LINES = 8;

/**
 * One short message for a batch of notices: the latest per tab, in order, labelled with project
 * and session from the snapshot, at most MAX_LINES lines. Empty when there is nothing to say.
 */
export function noticeText(notices: Notice[], state: any): string {
	const latest = new Map<number, Kind>();
	for (const n of notices) latest.delete(n.tab), latest.set(n.tab, n.kind);
	const lines = [...latest].map(([tab, kind]) => {
		const where = findTab(state, tab);
		const name = where ? one(where.project?.name) || one(where.project?.label) || `project ${where.session.project_id}` : "";
		return `- ${name ? `${name} (session ${where!.session.id}, tab ${tab})` : `tab ${tab}`}: ${WORDS[kind]}`;
	});
	if (!lines.length) return "";
	const shown = lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES - 1), `- … ${lines.length - MAX_LINES + 1} more (desk_state shows all)`] : lines;
	return ["pi-desk: other sessions changed. Tell the user if it matters; do not act on them unasked.", ...shown].join("\n");
}
