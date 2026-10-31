#!/usr/bin/env node
// Nightly canary: compare the kit's pins (test/ci/package.json) with the latest npm releases.
//   node scripts/canary-versions.mjs            print pin vs latest (read-only)
//   node scripts/canary-versions.mjs --write D  set D/package.json (a copy of test/ci) to the latest
//                                               versions and remove D/package-lock.json
// pi's sibling packages follow pi through the existing "overrides". See GUIDE.md "Updating".
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PINS = fileURLToPath(new URL("../test/ci", import.meta.url));
const write = process.argv[2] === "--write";
const dir = path.resolve(write ? (process.argv[3] ?? "") : PINS);
if (write && (!process.argv[3] || dir === PINS)) {
	console.error("usage: canary-versions.mjs --write <copy of test/ci> (never the kit's own pins)");
	process.exit(2);
}
const file = path.join(dir, "package.json");
const pkg = JSON.parse(readFileSync(file, "utf8"));

let same = true;
for (const [name, pin] of Object.entries(pkg.dependencies)) {
	const latest = execFileSync("npm", ["view", name, "version"], { encoding: "utf8" }).trim();
	if (!/^\d+\.\d+\.\d+/.test(latest)) throw new Error(`npm view ${name} version gave "${latest}"`);
	if (latest !== pin) same = false;
	console.log(`${name.padEnd(34)} pin ${pin.padEnd(10)} latest ${latest}${latest === pin ? "" : "  (differs)"}`);
	pkg.dependencies[name] = latest;
}
console.log(same ? "latest equals the pins" : "latest differs from the pins");
if (write) {
	writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
	rmSync(path.join(dir, "package-lock.json"), { force: true });
}
