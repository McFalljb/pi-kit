// Version drift warning: at the start of an interactive session, one warning when the running pi
// or a configured recommended package is older than the kit's pins (test/ci/package.json, the one
// list CI tests and Dependabot updates) or not pinned. Fix: scripts/install.sh --update.
import { type ExtensionAPI, getAgentDir, VERSION } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import path from "node:path";
import { drift } from "./drift.ts";

const json = (f: string | URL) => {
	try {
		return JSON.parse(readFileSync(f, "utf8"));
	} catch {
		return undefined;
	}
};

export default function versions(pi: ExtensionAPI) {
	let warned = false;
	pi.on("session_start", (_e, ctx) => {
		if (warned || ctx.mode !== "tui") return;
		warned = true;
		const pins = json(new URL("../../test/ci/package.json", import.meta.url))?.dependencies;
		if (!pins) return;
		const lines = drift(pins, VERSION, json(path.join(getAgentDir(), "settings.json"))?.packages ?? []);
		if (lines.length) ctx.ui.notify(`pi-kit version drift: ${lines.join("; ")}. See GUIDE.md "Updating".`, "warning");
	});
}
