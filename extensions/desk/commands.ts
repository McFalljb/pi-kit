// pi-desk's commands as the Home agent sees them (unit-tested in test/unit.test.ts). The desk_run
// tool's description is generated from this list. pi-desk does not list its commands yet: the
// extension asks with `list_commands` (a proposed control command, same shape as Cmd) and falls
// back to COMMANDS, which mirrors pi-desk docs/PROTOCOL.md §3 for the `control` caller.

export interface Cmd {
	type: string;
	args?: string; // fields, `?` = optional, e.g. "tab_id, confirm?"
	does: string;
	confirm_class?: string; // asks for confirmation (class from PROTOCOL.md §3)
	long_running?: boolean; // returns `pending`, then a `finished` event
}

/** PROTOCOL.md §3, the commands a `control` caller may send (not the user-only, bridge-only or test-only ones). */
export const COMMANDS: Cmd[] = [
	{ type: "get_state", does: "the state snapshot (use desk_state)" },
	{ type: "add_project", args: "cwd", does: "add (or find) a project and select it; created_id = project id" },
	{ type: "select_project", args: "project_id", does: "select a project and list its sessions" },
	{ type: "rename_project", args: "project_id, name", does: 'rename a project ("" = path label)' },
	{ type: "open_session", args: "project_id, pi_session_id", does: "resume a pi session (focuses it if open); created_id = open session id" },
	{ type: "new_chat", args: "project_id", does: "start a new pi session; created_id = open session id" },
	{ type: "focus_session", args: "session", does: "show an open session" },
	{ type: "new_shell_tab", args: "session", does: "open a shell tab in an open session; created_id = tab id" },
	{ type: "close_tab", args: "tab_id", does: "close a shell tab (a pi tab cannot be closed)", confirm_class: "tab_close" },
	{ type: "focus_tab", args: "tab_id", does: "focus a tab and make its session current" },
	{ type: "copy_selection", args: "tab_id", does: "copy a tab's terminal selection" },
	{ type: "send_text", args: "tab_id, text", does: "paste text into a terminal (raw keystrokes into a pi tab; use desk_prompt for pi)" },
	{ type: "set_focus", args: "widget", does: 'focus a widget ("" = terminal; rename_project)' },
	{ type: "set_layout", args: "left_width?, right_width?, right_open?", does: "column widths (160-800 px) and the right column" },
	{ type: "set_panel", args: "panel, open", does: "open or close a panel in the right column" },
	{ type: "set_panel_collapsed", args: "panel, collapsed", does: "fold a panel's section" },
	{ type: "cancel_confirmation", args: "token", does: "drop a pending confirmation" },
	{ type: "rescan", does: "rescan projects and sessions", long_running: true },
	{ type: "quit", does: "quit pi-desk", confirm_class: "app_quit" },
	{ type: "pi_prompt", args: "tab_id, text", does: "send a prompt to a pi tab (use desk_prompt)", long_running: true },
	{ type: "pi_wait_idle", args: "tab_id, timeout_ms?", does: "wait until a pi tab is idle (use desk_wait)", long_running: true },
	{ type: "pi_reload", args: "tab_id", does: "reload a pi tab once it is idle", confirm_class: "session_restart", long_running: true },
	{ type: "set_theme", args: "name", does: "graphite, warm or ghostty" },
	{ type: "set_reduce_motion", args: "on", does: "no fades or pulsing dots" },
];

/** A `list_commands` result's commands, or undefined if it is not a usable list. */
export function parseCommands(data: unknown): Cmd[] | undefined {
	const list = (data as { commands?: unknown })?.commands;
	if (!Array.isArray(list) || !list.length) return undefined;
	const out: Cmd[] = [];
	for (const c of list) {
		if (!c || typeof c.type !== "string" || !c.type) return undefined;
		out.push({
			type: c.type,
			...(typeof c.args === "string" && c.args ? { args: c.args } : {}),
			does: typeof c.does === "string" ? c.does : "",
			...(typeof c.confirm_class === "string" && c.confirm_class ? { confirm_class: c.confirm_class } : {}),
			...(c.long_running === true ? { long_running: true } : {}),
		});
	}
	return out;
}

/** desk_run's description: what it does, then one line per command. */
export function runDescription(cmds: Cmd[]): string {
	const lines = cmds.map((c) => {
		const notes = [c.confirm_class && `confirms: ${c.confirm_class}`, c.long_running && "long-running"].filter(Boolean);
		return `- ${c.type}${c.args ? ` {${c.args}}` : ""}: ${c.does}${notes.length ? ` [${notes.join(", ")}]` : ""}`;
	});
	return [
		"Run one pi-desk command: `command` is {type, ...fields}. Targets are ids from desk_state (project_id, session = open session id, tab_id), never positions.",
		"Returns pi-desk's result. Long-running commands are waited for. A command that needs confirmation is parked in pi-desk; this tool then waits for the user to confirm or cancel it there and returns the outcome: never resend it, and never ask the user to change a confirmation setting so you can skip it.",
		"Commands:",
		...lines,
	].join("\n");
}

/** Same command type and same fields as `ours` (a target), ignoring `confirm`: e.g. an event's command vs the one we sent. */
export function sameCommand(theirs: unknown, ours: Record<string, unknown>): boolean {
	if (!theirs || typeof theirs !== "object") return false;
	const t = theirs as Record<string, unknown>;
	return Object.keys(ours).every((k) => k === "confirm" || JSON.stringify(t[k]) === JSON.stringify(ours[k]));
}
