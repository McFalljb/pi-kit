// Merge the kit's AGENTS.md sections into a global AGENTS.md. Called by install.sh.
// Usage: node agents-merge.mjs <kit AGENTS.md> <global AGENTS.md> <keys,comma,separated or ""> <dry 0|1>
// Prints an overlap report per kit section, then appends: the chosen keys, or (no keys) every
// section that is neither present nor a likely overlap. Backs the file up first. Never edits text.
import fs from "node:fs";

// Short key per kit section (by the first word of its heading) and phrases that show a user's
// file already covers it.
const KEYS = {
	operating: { word: "operating", phrases: ["think before coding", "surgical change", "verifiable goal"] },
	communication: { word: "communication", phrases: ["lead with the outcome", "say what you did not verify"] },
	safety: { word: "safety", phrases: ["personal information", "read-only by default", "never pop, drop"] },
	background: { word: "background", phrases: ["bash_bg", "run_in_background", "poll in a loop"] },
	parent: { word: "parent", phrases: ["delegate multi-step", "single-fact lookup"] },
	delegation: { word: "delegation", phrases: ["subagents_enable", "action: \"steer\""] },
	review: { word: "review", phrases: ["merge gate", "required checks are green"] },
	child: { word: "child", phrases: ["assigned scope", "never report done on red"] },
	notes: { word: "durable", phrases: ["session note", "write a handoff"] },
};
const STOP = new Set(["and", "the", "of", "a", "an", "for", "to", "in", "on", "with", "kit"]);

const [kitPath, globalPath, keyArg, dry] = process.argv.slice(2);
const kit = fs.readFileSync(kitPath, "utf8");
const exists = fs.existsSync(globalPath);
const global = exists ? fs.readFileSync(globalPath, "utf8") : "";

const firstLine = (s) => s.split("\n")[0].trim();
// Heading words: lowercase, without "(...)", "*(kit)*", punctuation, stop words or a plural "s".
const words = (h) => new Set(h.replace(/^#+\s*/, "").replace(/\*?\([^)]*\)\*?/g, " ").toLowerCase().split(/[^a-z0-9]+/)
	.filter((w) => w && !STOP.has(w)).map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w)));
const subset = (a, b) => a.size > 0 && [...a].every((w) => b.has(w));
const same = (a, b) => a.size === b.size && subset(a, b);
// Code blocks hold examples, not rules: drop them before looking at headings and phrases.
const prose = (text) => text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, "");

const sections = kit.split(/^(?=## )/m).slice(1).map((text) => {
	const heading = firstLine(text);
	const first = [...words(heading)][0];
	const key = Object.keys(KEYS).find((k) => KEYS[k].word === first);
	if (!key) throw new Error(`kit section without a key: ${heading}`);
	return { key, heading, text };
});
const userHeadings = prose(global).split("\n").filter((l) => /^#{1,6}\s/.test(l)).map((l) => l.trim());
const userSections = new Map(global.split(/^(?=## )/m).filter((s) => s.startsWith("## ")).map((s) => [firstLine(s), s.trim()]));
// Key phrases are looked for only outside the sections the kit itself put there.
const kitHeadings = new Set(sections.map((s) => s.heading));
const lower = prose(global.split(/^(?=## )/m).filter((s) => !kitHeadings.has(firstLine(s))).join("")).toLowerCase();

// Status per section: present (same heading and text), differs (same heading, other text),
// overlap (heading words or key phrases), new.
for (const s of sections) {
	if (userSections.has(s.heading)) {
		s.status = userSections.get(s.heading) === s.text.trim() ? "present" : "differs";
		continue;
	}
	const kw = words(s.heading);
	// A one-word user heading ("## Rules") must have the same words; longer ones may be a
	// superset or subset ("### Safety and authority", "## Durable notes").
	const h = userHeadings.find((u) => (words(u).size === 1 ? same(kw, words(u)) : subset(kw, words(u)) || subset(words(u), kw)));
	const p = KEYS[s.key].phrases.find((x) => lower.includes(x.toLowerCase()));
	if (h) Object.assign(s, { status: "overlap", why: `heading words match "${h}"` });
	else if (p) Object.assign(s, { status: "overlap", why: `content has "${p}"` });
	else s.status = "new";
}

const chosen = keyArg ? keyArg.split(",").map((k) => k.trim()).filter(Boolean) : null;
const unknown = (chosen || []).filter((k) => !KEYS[k]);
if (unknown.length) {
	console.error(`unknown section key(s): ${unknown.join(", ")}; known: ${Object.keys(KEYS).join(", ")}`);
	process.exit(2);
}

const label = { present: "already there", differs: "same heading, different text: left alone", new: "new" };
console.log(`AGENTS.md overlap report for ${globalPath}${exists ? "" : " (missing)"}:`);
for (const s of sections) console.log(`  ${s.key.padEnd(14)}${s.heading.replace(/^## /, "")}: ${s.status === "overlap" ? `likely overlap, ${s.why}` : label[s.status]}`);
for (const s of sections.filter((s) => s.status === "differs")) {
	console.log(`  ${"".padEnd(14)}to compare: diff <(sed -n '/^${s.heading.replace(/[*()]/g, ".")}$/,/^## /p' ${globalPath}) <(sed -n '/^${s.heading.replace(/[*()]/g, ".")}$/,/^## /p' ${kitPath})`);
	console.log(`  ${"".padEnd(14)}to take the kit's: remove your section, then --sections ${s.key}`);
}
const suggested = sections.filter((s) => s.status === "new").map((s) => s.key);
console.log(`suggested: scripts/install.sh --sections ${suggested.join(",") || "<none>"}`);

const add = sections.filter((s) => (chosen ? chosen.includes(s.key) && !userSections.has(s.heading) : s.status === "new"));
if (!chosen) for (const s of sections.filter((s) => s.status === "overlap")) console.log(`skipped ${s.key}: likely overlap (add it with --sections ${s.key})`);
if (!add.length) {
	console.log(`ok: nothing to append to ${globalPath}`);
	process.exit(0);
}
const verb = dry === "1" ? "would append" : "appending";
console.log(`${verb} ${add.length} kit section(s) to ${globalPath}: ${add.map((s) => s.key).join(", ")}`);
if (dry === "1") process.exit(0);
if (!exists) {
	// New file: the kit's intro, then the chosen sections.
	fs.writeFileSync(globalPath, kit.split(/^(?=## )/m)[0] + add.map((s) => s.text).join(""));
	console.log(`created ${globalPath}`);
} else {
	const backup = `${globalPath}.bak.${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}`;
	fs.copyFileSync(globalPath, backup);
	fs.appendFileSync(globalPath, `\n${add.map((s) => s.text).join("")}`);
	console.log(`backup: ${backup}`);
}
