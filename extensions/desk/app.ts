// pi-desk app tabs for the Home agent (unit-tested in test/unit.test.ts): the commands and output
// of app_call, app_screenshot, app_input and app_events. pi-desk is only the pipe: an app tab's
// methods are the app's own (pi-desk docs/ENGINE-BRIDGE.md, PROTOCOL.md `app_call`), so these are
// general tools and agents learn an app's features from its `tab.describe`, never from us.

import { DATA_NOTE } from "./state.ts";

type R = Record<string, any>;
const MAX_TIMEOUT_S = 600;
const REPLY_MAX = 50_000; // characters of an app's reply shown to the model
export const APP_IMAGE_MAX = 4 * 1024 * 1024; // a bigger screenshot is described, not attached

const isObject = (v: unknown): v is R => !!v && typeof v === "object" && !Array.isArray(v);
const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… [cut: ${s.length - n} more characters]` : s);

/** pi-desk's app_call command; throws on a bad tab, method or params (pi-desk checks the rest). */
export function appCallCommand(tab: number, method: string, params?: R, timeout_s?: number): R {
	if (typeof tab !== "number") throw new Error("tab (the app tab's id, from desk_state) is required.");
	if (typeof method !== "string" || !method.trim()) throw new Error('method is required: the app\'s own method name; call "tab.describe" first to list them.');
	if (params !== undefined && !isObject(params)) throw new Error("params must be a JSON object.");
	return {
		type: "app_call",
		tab_id: tab,
		method,
		...(params !== undefined && { params }),
		...(timeout_s !== undefined && { timeout_ms: Math.min(MAX_TIMEOUT_S, Math.max(1, Number(timeout_s) || 10)) * 1000 }),
	};
}

const HINTS: Record<string, string> = {
	not_supported: 'The app has no such method: call "tab.describe" to see what it offers.',
	reserved: "pi-desk keeps it for itself: close the tab with desk_run close_tab; pi-desk tells the app when it is shown.",
	bad_args: "pi-desk refused the envelope (method name or params); fix the call.",
	timeout: "The app did not answer in time; it may be busy (app_screenshot shows its last frame) or hung (desk_state shows its app_status).",
	tab_gone: "The app exited or its tab closed: desk_state shows it; desk_run app_restart starts it again.",
};

/** app_call's output: the app's reply as fenced data, or its error with the code and a hint. */
export function appReplyText(tab: number, method: string, result: R): string {
	const data = cap(JSON.stringify(result?.data ?? {}), REPLY_MAX);
	const fenced = ["<<<app reply", data, "app reply>>>"];
	if (result?.ok) return [DATA_NOTE, `The app in tab ${tab} answered ${method}:`, ...fenced].join("\n");
	const code = typeof result?.data?.code === "string" ? result.data.code : "";
	const head = `The app in tab ${tab} answered ${method} with an error${code ? ` (${code})` : ""}: ${result?.error ?? "unknown"}`;
	return [head, ...(HINTS[code] ? [HINTS[code]] : []), DATA_NOTE, ...fenced].join("\n");
}

/** app_screenshot's text: size, frame and file. */
export function shotText(tab: number, d: R): string {
	const where = d.rect && (d.rect.x || d.rect.y) ? ` (from ${d.rect.x},${d.rect.y})` : "";
	const hidden = d.visible === false ? " The tab is not on screen: the last frame it showed." : "";
	return `Tab ${tab}'s frame (seq ${d.seq}, tick ${d.tick}): ${d.w}×${d.h} px at scale ${d.scale}${where}, PNG ${d.bytes} bytes at ${d.path}${hidden}`;
}

/** app_input's events, checked: TAB-PROTOCOL input objects, each with `event`, none setting pi-desk's envelope. */
export function appInputEvents(events: unknown): R[] {
	if (!Array.isArray(events) || !events.length) throw new Error('events must be a non-empty list of input objects, e.g. {"event":"key","action":"down","key":"w"}.');
	for (const e of events) {
		if (!isObject(e) || typeof e.event !== "string") throw new Error('each event must be an object with "event" (key, char, mouse, move, scroll, focus).');
		for (const k of ["type", "v", "id", "source"]) if (k in e) throw new Error(`an event cannot set "${k}" (pi-desk's envelope).`);
	}
	return events as R[];
}

/** app_events' output: the app's events, oldest first, fenced, and the cursor to read on. */
export function appEventsText(tab: number, topic: string, data: R): string {
	const list = Array.isArray(data?.events) ? data.events : [];
	if (!list.length) return `Tab ${tab} has no ${topic} events after since ${data?.next ?? 0}.`;
	const lines = list.map((e: R) => cap(`${e.seq} ${JSON.stringify(e.event)}`, 2000));
	return [DATA_NOTE, `Tab ${tab}'s ${topic} events (${list.length}; next: pass since ${data.next}):`, "<<<app events", ...lines, "app events>>>"].join("\n");
}
