// Pure helper for the versions extension (unit-tested in test/unit.test.ts).

const PI = "@earendil-works/pi-coding-agent";
const nameOf = (spec: string) => spec.replace(/^npm:/, "").replace(/^(@?[^@]+)@.*$/, "$1");
const parts = (v: string) => (/^\d+\.\d+\.\d+$/.test(v) ? v.split(".").map(Number) : undefined);
/** True when `have` is not an exact x.y.z version or is older than `pin`. */
function behind(have: string, pin: string): boolean {
	const a = parts(have), b = parts(pin);
	if (!a || !b) return have !== pin;
	for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
	return false;
}

/**
 * What differs from the pins (test/ci/package.json dependencies) in a way worth a warning: pi or a
 * configured `npm:` package (plain string entries, as install.sh writes them) that is older than
 * its pin or not pinned to an exact version. Newer is fine.
 */
export function drift(pins: Record<string, string>, piVersion: string, configured: unknown[]): string[] {
	const out: string[] = [];
	if (behind(piVersion, pins[PI])) out.push(`pi ${piVersion} (kit tested with ${pins[PI]})`);
	for (const c of configured) {
		if (typeof c !== "string" || !c.startsWith("npm:")) continue;
		const name = nameOf(c);
		if (name === PI || !pins[name]) continue;
		const at = c.lastIndexOf("@");
		const have = at > c.indexOf(name) ? c.slice(at + 1) : "";
		if (behind(have, pins[name])) out.push(`${c} (kit tested with npm:${name}@${pins[name]})`);
	}
	return out;
}
