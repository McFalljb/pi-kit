// pi-desk app tabs for the Home agent (unit-tested in test/unit.test.ts): the commands and output
// of app_call, app_screenshot, app_input and app_events. pi-desk is only the pipe: an app tab's
// methods are the app's own (pi-desk docs/ENGINE-BRIDGE.md, PROTOCOL.md `app_call`), so these are
// general tools and agents learn an app's features from its `tab.describe`, never from us.

import fs from "node:fs";
import path from "node:path";
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

/**
 * app_call's output: the app's reply as fenced data, or its error with the code and a hint. Only
 * pi-desk's known codes are shown outside the fence; the app's error text stays inside it.
 */
export function appReplyText(tab: number, method: string, result: R): string {
	if (result?.ok) return [DATA_NOTE, `The app in tab ${tab} answered ${method}:`, "<<<app reply", cap(JSON.stringify(result?.data ?? {}), REPLY_MAX), "app reply>>>"].join("\n");
	const code = typeof result?.data?.code === "string" && /^[a-z0-9_]{1,40}$/.test(result.data.code) ? result.data.code : "";
	const head = `The app in tab ${tab} answered ${method} with an error${code ? ` (${code})` : ""}.`;
	const body = cap(JSON.stringify({ error: cap(String(result?.error ?? "unknown"), 1000), data: result?.data ?? {} }), REPLY_MAX);
	return [head, ...(HINTS[code] ? [HINTS[code]] : []), DATA_NOTE, "<<<app reply", body, "app reply>>>"].join("\n");
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * The PNG pi-desk wrote for app_screenshot, checked rather than trusted: after resolving symlinks
 * it must be `.../apps/shots/<tab>-<n>.png`, directly in `shotsDir` when there is one
 * (PI_DESK_SHOTS_DIR, which pi-desk sets for the pi sessions it starts; an older pi-desk does not,
 * and then only the shape is checked), a regular file of at most APP_IMAGE_MAX bytes (its own size, not the reply's)
 * starting with the PNG signature. Otherwise why not.
 */
export function shotFile(tab: number, file: unknown, shotsDir: string | undefined = process.env.PI_DESK_SHOTS_DIR || undefined): { png: Buffer; bytes: number } | { why: string } {
	const no = { why: "not a pi-desk screenshot of this tab" };
	if (typeof file !== "string" || !path.isAbsolute(file)) return no;
	let real: string;
	try {
		real = fs.realpathSync(file);
	} catch {
		return { why: "the file could not be read" };
	}
	const dir = path.dirname(real);
	if (!new RegExp(`^${tab}-\\d+\\.png$`).test(path.basename(real)) || !dir.endsWith(`${path.sep}apps${path.sep}shots`)) return no;
	if (shotsDir !== undefined) {
		let want: string;
		try {
			want = fs.realpathSync(shotsDir);
		} catch {
			return no;
		}
		if (dir !== want) return no;
	}
	let fd: number | undefined;
	try {
		fd = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
		const st = fs.fstatSync(fd);
		if (!st.isFile()) return no;
		if (st.size > APP_IMAGE_MAX) return { why: "over 4 MB; ask for a smaller rect" };
		const png = Buffer.alloc(st.size);
		fs.readSync(fd, png, 0, st.size, 0);
		if (png.length < 8 || !png.subarray(0, 8).equals(PNG_MAGIC)) return { why: "not a PNG" };
		return { png, bytes: st.size };
	} catch {
		return { why: "the file could not be read" };
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
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
