// Version drift warning: at the start of an interactive session, one warning when the running pi
// or a configured recommended package differs from the kit's pins (test/ci/package.json, the one
// list CI tests and Dependabot updates). Fix: scripts/install.sh, or `pi install npm:<name>@<version>`.
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
		const pins: Record<string, string> | undefined = json(new URL("../../test/ci/package.json", import.meta.url))?.dependencies;
		if (!pins) return;
		const drift: string[] = [];
		const { "@earendil-works/pi-coding-agent": tested, ...packages } = pins;
		if (VERSION !== tested) drift.push(`pi ${VERSION} (kit tested with ${tested})`);
		const configured: unknown[] = json(path.join(getAgentDir(), "settings.json"))?.packages ?? [];
		for (const [name, version] of Object.entries(packages)) {
			const have = configured.find((c): c is string => typeof c === "string" && c.startsWith("npm:") && nameOf(c) === name);
			if (have && have !== `npm:${name}@${version}`) drift.push(`${have} (kit tested with npm:${name}@${version})`);
		}
		if (drift.length) ctx.ui.notify(`pi-kit version drift: ${drift.join("; ")}. See GUIDE.md "Updating".`, "warning");
	});
}
