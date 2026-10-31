// pi-desk's commands as the Home agent sees them (unit-tested in test/unit.test.ts). The desk_run
// tool's description is generated from this list. pi-desk does not list its commands yet: the
// extension asks with `list_commands` (a proposed control command, same shape as Cmd) and falls
// back to COMMANDS, which mirrors pi-desk docs/PROTOCOL.md §3 for the `control` caller.

import { refusal } from "./state.ts";

export interface Cmd {
	type: string;
	args?: string; // fields, `?` = optional, e.g. "tab_id, confirm?"
	does: string;
	confirm_class?: string; // asks for confirmation (class from PROTOCOL.md §3)
	long_running?: boolean; // returns `pending`, then a `finished` event
	offerable?: boolean; // pi-desk lets a desk_offer button carry it (absent: see OFFERABLE)
}

/**
 * Commands a desk_offer button may carry when pi-desk's list has no `offerable` flags: navigation
 * and choices the user makes (close_tab, close_session, pi_reload and quit always ask on click).
 * Mirrors pi-desk's server-side allowlist.
 */
export const OFFERABLE = new Set([
	"focus_session", "focus_tab", "select_project", "open_session", "new_chat", "new_shell_tab", "open_file",
	"set_panel", "set_panel_collapsed", "set_theme", "set_appearance", "set_layout", "rescan",
	"close_tab", "close_session", "pi_reload", "quit",
]);

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
			...(typeof c.offerable === "boolean" ? { offerable: c.offerable } : {}),
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

/**
 * The command pi-desk parked for our confirmation (its canonical fields), from the snapshot: the
 * control caller's pending entry whose fields all equal ours (fields the model added are ignored).
 */
export function parkedFor(state: any, ours: Record<string, unknown>): Record<string, unknown> | undefined {
	const list = Array.isArray(state?.pending_confirmations) ? state.pending_confirmations : [];
	return list.find((c: any) => c?.caller === "control" && c.command && sameCommand(ours, c.command))?.command;
}

/** Whether a `command` event is the user's confirmed run of the parked command (not another try that needs confirmation). */
export function confirmedBy(ev: any, parked: Record<string, unknown>): boolean {
	return ev?.caller === "ui" && sameCommand(ev.command, parked) && ev.result?.error !== "needs_confirmation";
}

export const MAX_BUTTONS = 4;
export const MAX_LABEL = 40;
export const MAX_REPORT_LINES = 5;

/**
 * Why desk_offer must not show these buttons, or undefined: 1–MAX_BUTTONS buttons, each with a
 * label of at most MAX_LABEL characters and an offerable command from `cmds` (pi-desk's
 * `offerable` flags if its list has any, else OFFERABLE) that carries no confirm token (the user's
 * click must go through pi-desk's confirmation) and passes desk_run's `refusal` (`state` for
 * send_text; own tabs).
 */
export function offerRefusal(buttons: unknown, cmds: Cmd[], own: Set<number>, state?: unknown): string | undefined {
	if (!Array.isArray(buttons) || buttons.length < 1 || buttons.length > MAX_BUTTONS) return `Offer 1 to ${MAX_BUTTONS} buttons.`;
	const types = new Set(cmds.map((c) => c.type));
	const flagged = cmds.some((c) => c.offerable !== undefined);
	const offerable = new Set(cmds.filter((c) => (flagged ? c.offerable === true : OFFERABLE.has(c.type))).map((c) => c.type));
	for (const [i, b] of buttons.entries()) {
		const label = typeof b?.label === "string" ? b.label.trim() : "";
		const cmd = b?.command;
		const at = `Button ${i + 1}`;
		if (!label) return `${at} has no label.`;
		if (label.length > MAX_LABEL) return `${at}'s label is longer than ${MAX_LABEL} characters.`;
		if (typeof cmd?.type !== "string" || !types.has(cmd.type)) return `${at}'s command type ${JSON.stringify(cmd?.type)} is not a pi-desk command (desk_run lists them).`;
		if (!offerable.has(cmd.type)) return `${at}'s command ${cmd.type} cannot be offered as a button: buttons are for navigation and the user's choices.`;
		if ("confirm" in cmd) return `${at}'s command carries a confirm token: the user's click must go through pi-desk's confirmation.`;
		const why = refusal(cmd, state, own);
		if (why) return `${at}: ${why}`;
	}
}

/** Why desk_report must not show this card, or undefined: a title and at most MAX_REPORT_LINES lines. */
export function reportRefusal(p: { title?: unknown; lines?: unknown }): string | undefined {
	if (typeof p.title !== "string" || !p.title.trim()) return "The report needs a title.";
	if (!Array.isArray(p.lines) || p.lines.some((l) => typeof l !== "string")) return "lines must be a list of strings.";
	if (p.lines.length > MAX_REPORT_LINES) return `At most ${MAX_REPORT_LINES} lines; put the rest in details.`;
}
