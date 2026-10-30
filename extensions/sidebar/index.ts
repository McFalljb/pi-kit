/**
 * A right-hand sidebar with background subagents (pi-subagents), todos (rpiv-todo) and the kit's
 * background shells, monitors and timers, so their widgets stop taking rows under the transcript.
 *
 * - Fullscreen tuiMode (pi's default): a column right of the transcript, `WIDTH` wide, shown when
 *   the terminal is at least `MIN_COLUMNS` wide. It is its own scroll view (mouse wheel, selection).
 * - Regular tuiMode, or a narrower terminal: a one-line footer summary, and `/sidebar` opens the
 *   same rows as an overlay on the right (it does not take keyboard focus).
 * - `/sidebar` shows or hides the column (wide fullscreen) or the overlay (otherwise).
 *
 * While loaded with a UI, the rpiv-todo widget and the kit shell widget are hidden for good.
 * Data: pi-subagents' event-bus status RPC, re-read when its job events fire; rpiv-todo's state on
 * the session branch and `todo` tool results; the shell extension's `kit:shell:rows` event.
 */

import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, HStack, isViewportTUI, ScrollView, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type Data, type Line, summary, sidebarLines, todosFromBranch } from "./rows.ts";

const WIDTH = 34; // columns, border included
const MIN_COLUMNS = 120; // narrower terminals get the footer summary instead of the column
const SUBAGENT_EVENTS = ["subagent:jobs-changed", "subagent:async-started", "subagent:child-status", "subagent:async-complete", "subagent:process-terminal", "subagents:rpc:v1:ready"];
const arr = (v: unknown) => (Array.isArray(v) ? v : []);

export default function (pi: ExtensionAPI) {
	const data: Data = { runs: [], todos: [], shells: [] };
	let ui: ExtensionContext["ui"] | undefined;
	let tui: TUI | undefined; // pi's TUI reference: it follows the renderer when tuiMode changes
	let column = true; // fullscreen: /sidebar toggles the column
	let closeOverlay: (() => void) | undefined; // regular mode: closes the open overlay
	let piRoot: Component | undefined; // pi's layout root, put back on dispose
	let root: HStack | undefined; // ours: pi's root plus the column
	let shown = ""; // what the last refresh laid out, so a render can notice a mode or width change
	let queued = false;
	let closed = false;
	let reading = false;
	let again = false;
	let subTimer: NodeJS.Timeout | undefined;
	let later: NodeJS.Timeout | undefined;
	let stopRead: (() => void) | undefined; // ends the status read in flight
	let hideTimer: NodeJS.Timeout | undefined;
	let hideAt = 0;
	let ownFrame = false; // the next frame is the one our own todo-widget removal asked for

	const fullscreen = () => !!tui && isViewportTUI(tui);
	const wide = () => (tui?.terminal.columns ?? 0) >= MIN_COLUMNS;
	const layoutRoot = () => (tui as unknown as { layoutRoot?: Component } | undefined)?.layoutRoot;
	const state = () => `${fullscreen()}:${wide()}:${column}`;

	/** The rows, `width` wide with a left border, padded to at least `rows` lines. Never throws. */
	function panel(width: number, rows = 0): string[] {
		try {
			const th = ui!.theme;
			const style = (l: Line) => (l.head ? th.bold(l.text) : l.tone ? th.fg(l.tone, l.text) : l.text);
			const body = sidebarLines(data, Date.now()).map((l) => truncateToWidth(style(l), width - 2));
			while (body.length < rows) body.push("");
			const bar = th.fg("border", "│");
			return body.map((l) => `${bar} ${l}${" ".repeat(Math.max(0, width - 2 - visibleWidth(l)))}`);
		} catch (e) {
			return [truncateToWidth(`sidebar: ${(e as Error)?.message ?? e}`, width)];
		}
	}
	const scroll = new ScrollView({ render: (w) => panel(w, tui?.terminal.rows ?? 0), invalidate() {} }, { scrollbar: "auto" });

	/** Fullscreen: put pi's current root and the column side by side (again after a tuiMode switch). */
	function mount() {
		const current = layoutRoot();
		if (!tui || !isViewportTUI(tui) || !current || current === root) return;
		piRoot = current;
		root = new HStack([
			{ component: piRoot, basis: 0, grow: 1 },
			{ component: scroll, basis: WIDTH, visible: (v) => v.width >= MIN_COLUMNS },
		]);
		tui.setLayoutRoot(root);
	}
	function unmount() {
		if (tui && isViewportTUI(tui) && root && piRoot && layoutRoot() === root) tui.setLayoutRoot(piRoot);
		root = undefined;
	}

	function refresh() {
		queued = false;
		if (closed || !ui || !tui) return;
		try {
			shown = state();
			if (fullscreen() && column) mount();
			else unmount();
			if (closeOverlay && fullscreen() && column && wide()) closeOverlay(); // the column shows the same rows
			const onScreen = (fullscreen() && column && wide()) || !!closeOverlay;
			ui.setStatus("sidebar", onScreen ? undefined : summary(data));
			if (data.todos.length) ui.setWidget("rpiv-todos", undefined); // rpiv-todo re-adds it after a reload or an empty list
			tui.requestRender();
		} catch {}
	}
	const refreshSoon = (ms = 250) => {
		clearTimeout(later);
		later = setTimeout(refresh, ms);
	};

	/**
	 * rpiv-todo may add its widget back at any time (it loads its view lazily). Each frame checks,
	 * at most every 500 ms; the frame our own removal causes is skipped, so an idle session stays idle.
	 */
	function hideTodos() {
		if (ownFrame) return void (ownFrame = false);
		if (!data.todos.length || hideTimer || closed) return;
		hideTimer = setTimeout(() => {
			hideTimer = undefined;
			hideAt = Date.now();
			ownFrame = true;
			try {
				ui?.setWidget("rpiv-todos", undefined);
			} catch {}
		}, Math.max(0, hideAt + 500 - Date.now()));
	}

	/** Called on every frame: re-lay out after a tuiMode switch, a resize past MIN_COLUMNS or a lost root. */
	function watch() {
		hideTodos();
		if (queued || closed) return;
		if (state() !== shown || (fullscreen() && column && layoutRoot() !== root)) {
			queued = true;
			setTimeout(refresh, 0);
		}
	}

	function readSubagents() {
		subTimer = undefined;
		if (reading) return void (again = true);
		reading = true;
		const requestId = randomUUID();
		let done = false;
		const finish = (reply?: unknown) => {
			if (done) return;
			done = true;
			off();
			clearTimeout(timeout);
			reading = false;
			stopRead = undefined;
			const r = reply as { success?: boolean; data?: { asyncSnapshot?: { runs?: unknown } } } | undefined;
			if (r?.success) data.runs = arr(r.data?.asyncSnapshot?.runs);
			refresh();
			if (again && !closed) {
				again = false;
				subagentsChanged();
			}
		};
		const off = pi.events.on(`subagents:rpc:v1:reply:${requestId}`, finish);
		const timeout = setTimeout(finish, 5000); // no pi-subagents, or it did not answer
		stopRead = finish;
		pi.events.emit("subagents:rpc:v1:request", { version: 1, requestId, method: "status" });
	}
	// Events come in bursts: one status read per 250 ms.
	const subagentsChanged = () => void (subTimer ??= setTimeout(readSubagents, 250));
	for (const name of SUBAGENT_EVENTS) pi.events.on(name, () => !closed && ui && subagentsChanged());

	pi.events.on("kit:shell:rows", (rows) => {
		data.shells = arr(rows);
		refresh();
	});

	function openOverlay() {
		ui?.custom<void>(
			(_t, _theme, _kb, done) => {
				closeOverlay = () => done();
				return { render: (w: number) => panel(w), invalidate() {} };
			},
			{ overlay: true, overlayOptions: { anchor: "right-center", width: WIDTH, maxHeight: "90%", nonCapturing: true } },
		)
			.catch(() => {})
			.finally(() => {
				closeOverlay = undefined;
				refresh();
			});
	}

	pi.registerCommand("sidebar", {
		description: "Show or hide the sidebar: subagents, todos, background shells",
		handler: async (_args, ctx) => {
			if (!tui) return ctx.ui.notify("The sidebar needs the interactive TUI.", "warning");
			if (fullscreen() && wide()) column = !column;
			else if (closeOverlay) closeOverlay();
			else openOverlay();
			refresh();
		},
	});

	pi.on("session_start", (_e, ctx) => {
		if (ctx.mode !== "tui") return;
		ui = ctx.ui;
		data.todos = todosFromBranch(ctx.sessionManager.getBranch());
		// A widget with no rows: its factory hands over the TUI, its render watches the layout.
		ui.setWidget("kit-sidebar", (t) => {
			tui = t;
			return { render: () => (watch(), []), invalidate() {}, dispose: unmount };
		}, { placement: "belowEditor" });
		pi.events.emit("kit:sidebar", true); // the shell extension stops drawing its widget
		subagentsChanged();
		refresh();
		refreshSoon(1500); // rpiv-todo adds its widget asynchronously after session_start
	});
	const replayTodos = (_e: unknown, ctx: ExtensionContext) => {
		if (!ui) return;
		data.todos = todosFromBranch(ctx.sessionManager.getBranch());
		refreshSoon();
	};
	pi.on("session_tree", replayTodos);
	pi.on("session_compact", replayTodos);
	pi.on("turn_end", replayTodos); // todo changes made through another tool (codemode) leave no todo tool_result
	pi.on("tool_execution_end", (e) => void (e.toolName === "todo" && refreshSoon()));
	pi.on("tool_result", (e) => {
		const tasks = (e.details as { tasks?: unknown } | undefined)?.tasks;
		if (e.toolName !== "todo" || e.isError || !Array.isArray(tasks)) return;
		data.todos = tasks;
		refreshSoon(); // after rpiv-todo's own update, which may add its widget back
	});

	pi.on("session_shutdown", () => {
		if (closed || !ui) return;
		closed = true;
		clearTimeout(subTimer);
		clearTimeout(later);
		clearTimeout(hideTimer);
		stopRead?.();
		try {
			closeOverlay?.();
			ui.setStatus("sidebar", undefined);
			ui.setWidget("kit-sidebar", undefined); // disposes the watcher, which puts pi's root back
		} catch {}
		unmount();
		pi.events.emit("kit:sidebar", false);
	});
}
