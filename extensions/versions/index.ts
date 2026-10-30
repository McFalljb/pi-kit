// Version drift warning: at the start of an interactive session, one warning when the running pi
// or a configured recommended package differs from the kit's pins (packages.json, kept equal to
// test/ci/package.json). Fix: scripts/install.sh, or `pi install npm:<name>@<version>`.
import { type ExtensionAPI, getAgentDir, VERSION } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import path from "node:path";

const json = (f: string | URL) => {
	try {
		return JSON.parse(readFileSync(f, "utf8"));
	} catch {
		return undefined;
	}
};
const nameOf = (spec: string) => spec.replace(/^npm:/, "").replace(/^(@?[^@]+)@.*$/, "$1");

export default function versions(pi: ExtensionAPI) {
	let warned = false;
	pi.on("session_start", (_e, ctx) => {
		if (warned || ctx.mode !== "tui") return;
		warned = true;
		const pins = json(new URL("../../packages.json", import.meta.url));
		if (!pins) return;
		const drift: string[] = [];
		if (VERSION !== pins.tested?.pi) drift.push(`pi ${VERSION} (kit tested with ${pins.tested?.pi})`);
		const configured: unknown[] = json(path.join(getAgentDir(), "settings.json"))?.packages ?? [];
		for (const p of pins.recommended ?? []) {
			const have = configured.find((c): c is string => typeof c === "string" && c.startsWith("npm:") && nameOf(c) === p.name);
			if (have && have !== p.spec) drift.push(`${have} (kit tested with ${p.spec})`);
		}
		if (drift.length) ctx.ui.notify(`pi-kit version drift: ${drift.join("; ")}. See GUIDE.md "Updating".`, "warning");
	});
}
