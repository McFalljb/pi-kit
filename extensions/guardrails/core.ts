/**
 * pi-kit guardrails core: best-effort safety rails, not a sandbox.
 *
 * - Command rules are opt-in: with no config no command asks or is blocked. The user turns on
 *   named presets (destructive git, rm -rf, deploys, cluster/infra changes, alert silencing, SQL
 *   drops, ...) or adds their own regex rules, each with action `ask` or `block`, in
 *   <agent-dir>/extensions/guardrails/config.json and, per project, <cwd>/.pi/guardrails.json.
 *   The project file is tighten-only: it can add rules and raise `ask` to `block`, never turn off
 *   or weaken what the global file enabled (a repo or an agent could write it). `ask` confirms
 *   with a UI; without one (print/json mode, subagent children) it blocks. Bad config warns once
 *   and keeps the valid rules.
 * - In read-only sessions blocks file edits and mutating bash commands (always on).
 * - Redacts secret-shaped strings from tool output before the model sees it (always on).
 *
 * checkCommand() is the one command gate; extensions/shell calls it for its background tools.
 *
 * Entry points: index.ts (normal; read-only when PI_KIT_READONLY=1) and readonly.ts (always
 * read-only, loaded by the kit's reviewer agent through its `extensions` frontmatter).
 *
 * Pattern matching on shell text is bypassable (aliases, scripts, eval, base64). For a real
 * boundary run pi in a container or VM; see pi's docs/security.md and docs/containerization.md.
 * Commands the user types with `!` go through user_bash, not tool_call, and are not gated.
 */

import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import os from "node:os";
import path from "node:path";
// Type-only import, so the pure functions here load under plain node for test/unit.test.ts.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Opt-in presets: name -> [pattern, why], each matched against the whole bash command.
// None is on unless the user's config enables it (e.g. "enable": {"force-push": "ask"}).
export const PRESETS: Record<string, [RegExp, string][]> = {
	"rm-rf": [[/\brm\b(?=[^|;&]*\s(?:-[a-zA-Z]*[rR]|--recursive))(?=[^|;&]*\s(?:-[a-zA-Z]*f|--force))/, "recursive force delete"]],
	"force-push": [[/\bgit\b[^|;&]*\bpush\b[^|;&]*(?:\s--force(?:-with-lease)?\b|\s-[a-zA-Z]*f\b|\s\+\S)/, "force push"]],
	"push-main": [[/\bgit\b[^|;&]*\bpush\b[^|;&]*\b(?:main|master)\b/, "push to main/master (a merge to main may be a production deploy)"]],
	"pr-merge": [[/\bgh\s+pr\s+merge\b/, "merge a pull request (may deploy)"]],
	"git-destructive": [
		[/\bgit\b[^|;&]*\bstash\s+(?:drop|pop|clear)\b/, "drops or pops a stash"],
		[/\bgit\b[^|;&]*\breset\s+[^|;&]*--hard\b/, "hard reset discards changes"],
		[/\bgit\b[^|;&]*\bclean\s+-[a-zA-Z]*f/, "git clean deletes untracked files"],
		[/\bgit\b[^|;&]*\bbranch\s+[^|;&]*-D\b/, "force-deletes a branch"],
		[/\bgit\b[^|;&]*\b(?:checkout|restore)\s+(?:--\s+)?\.(?:\s|$)/, "discards working-tree changes"],
		[/\bgit\b[^|;&]*\bworktree\s+remove\b[^|;&]*--force\b/, "force-removes a worktree"],
	],
	kubernetes: [[/\bkubectl\b[^|;&]*\b(?:delete|apply|replace|patch|scale|drain|cordon|edit|rollout\s+(?:restart|undo)|set\s+image)\b/, "changes a cluster"]],
	helm: [[/\bhelm\s+(?:install|upgrade|uninstall|rollback|delete)\b/, "changes a Helm release"]],
	terraform: [[/\b(?:terraform|tofu)\s+(?:apply|destroy|import|state\s+rm)\b/, "changes infrastructure"]],
	docker: [[/\bdocker\b[^|;&]*\b(?:down|rm|rmi|prune|kill)\b/, "removes containers, images or volumes"]],
	systemctl: [[/\bsystemctl\s+(?:restart|stop|disable|kill)\b/, "restarts or stops a service"]],
	deploy: [[/(?:^|[;&|]\s*)(?:\S*\/)?deploy[\w.-]*(?:\s|$)|\b(?:make|just|npm\s+run|pnpm|yarn)\s+deploy\b/, "runs a deploy"]],
	alerts: [[/\b(?:amtool\s+silence|api\/v[12]\/silences?|alerts?\s+ack)\b/i, "silences or acknowledges alerts"]],
	"sql-destructive": [[/\b(?:drop|truncate)\s+(?:table|database|schema)\b|\bdelete\s+from\b/i, "destructive SQL"]],
	"raw-disk": [[/\b(?:mkfs|dd\s+if=)/, "writes raw disks"]],
	"npm-publish": [[/\b(?:npm|pnpm|yarn)\s+publish\b/, "publishes a package"]],
	"curl-pipe-sh": [[/\bcurl\b[^|]*\|\s*(?:ba|z)?sh\b/, "pipes a download into a shell"]],
	// ssh and sudo have no preset: they prompted on every remote or root command and blocked
	// headless children outright. Remote and root work is governed by AGENTS.md instead.
};

export type Action = "ask" | "block";
/** One active command rule; `source` says where it was turned on (shown by /guardrails). */
export interface Rule {
	name: string;
	pattern: RegExp;
	reason: string;
	action: Action;
	source: string;
	/** A user-written rule (not a preset): tested only against the first MAX_TESTED chars. */
	custom?: boolean;
}

type Setting = Action | "off";
const SETTINGS = new Set(["ask", "block", "off"]);
interface CustomRule {
	pattern: RegExp;
	reason: string;
	action: Setting;
}
/** One parsed config file. */
export interface Layer {
	source: string;
	/** A project file: may add rules or raise ask to block, never turn off or weaken earlier layers. */
	tightenOnly?: boolean;
	enable: Record<string, Setting>;
	rules: [string, CustomRule][];
}

/**
 * Parses one config file. Every problem becomes a warning and only the bad entry is skipped;
 * invalid JSON (or a non-object) yields no layer and an `error` instead.
 *
 * {"enable": {"<preset>" | "all": "ask" | "block" | "off"},
 *  "rules": [{"name"?, "pattern", "reason"?, "action"?: "ask" | "block" | "off", "flags"?}]}
 */
export function parseConfig(text: string, source: string): { layer?: Layer; error?: string; warnings: string[] } {
	const warnings: string[] = [];
	const warn = (m: string) => warnings.push(`${source}: ${m}`);
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (e) {
		return { error: `invalid JSON (${(e as Error).message})`, warnings };
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "expected a JSON object", warnings };
	const obj = raw as Record<string, unknown>;
	for (const k of Object.keys(obj)) if (k !== "enable" && k !== "rules" && !k.startsWith("//")) warn(`unknown key "${k}" ignored (expected "enable" and "rules")`);
	const layer: Layer = { source, enable: {}, rules: [] };

	if (obj.enable !== undefined) {
		if (!obj.enable || typeof obj.enable !== "object" || Array.isArray(obj.enable)) warn(`"enable" must be an object like {"force-push": "ask"}; ignored`);
		else
			for (const [name, v] of Object.entries(obj.enable as Record<string, unknown>)) {
				if (name !== "all" && !Object.hasOwn(PRESETS, name)) warn(`unknown preset "${name}" ignored (presets: ${Object.keys(PRESETS).join(", ")})`);
				else if (typeof v !== "string" || !SETTINGS.has(v)) warn(`preset "${name}": action must be "ask", "block" or "off"; ignored`);
				else layer.enable[name] = v as Setting;
			}
	}

	if (obj.rules !== undefined) {
		if (!Array.isArray(obj.rules)) warn(`"rules" must be an array; ignored`);
		else
			obj.rules.forEach((r: unknown, i: number) => {
				const at = `rule ${i + 1}`;
				if (!r || typeof r !== "object" || Array.isArray(r)) return warn(`${at}: must be an object; skipped`);
				const { name, pattern, reason, action = "ask", flags = "" } = r as Record<string, unknown>;
				const label = typeof name === "string" && name ? `rule "${name}"` : at;
				if (typeof pattern !== "string" || !pattern) return warn(`${label}: "pattern" must be a non-empty string; skipped`);
				if (typeof action !== "string" || !SETTINGS.has(action)) return warn(`${label}: action must be "ask", "block" or "off"; skipped`);
				if (typeof flags !== "string") return warn(`${label}: "flags" must be a string; skipped`);
				if (reason !== undefined && typeof reason !== "string") return warn(`${label}: "reason" must be a string; skipped`);
				let re: RegExp;
				try {
					// g and y make test() stateful; drop them.
					re = new RegExp(pattern, flags.replace(/[gy]/g, ""));
				} catch (e) {
					return warn(`${label}: bad regex (${(e as Error).message}); skipped, the other rules still apply`);
				}
				const key = typeof name === "string" && name ? name : `${source}#${i + 1}`;
				layer.rules.push([key, { pattern: re, reason: (reason as string | undefined) || `matches /${pattern}/`, action: action as Setting }]);
			});
	}
	return { layer, warnings };
}

const RANK: Record<Setting, number> = { off: 0, ask: 1, block: 2 };

/**
 * Active rules from layers in order (global, then project). For a preset, the last layer that sets
 * it (by name, else through "all") wins, and a custom rule replaces an earlier one of the same
 * name ("off" removes it). A tightenOnly layer may only add or raise ask to block: an entry that
 * would turn off or weaken a preset or rule from a trusted layer (or swap a rule's pattern) is
 * ignored, and the layer gets one warning listing them, pushed to `warnings`.
 */
export function mergeLayers(layers: Layer[], warnings: string[] = []): Rule[] {
	const ignored = new Map<Layer, string[]>();
	const ignore = (l: Layer, what: string) => ignored.set(l, [...(ignored.get(l) ?? []), what]);

	const rules: Rule[] = [];
	for (const [name, patterns] of Object.entries(PRESETS)) {
		let set: Setting = "off";
		let source = "";
		for (const l of layers) {
			const named = l.enable[name];
			const v = named ?? l.enable.all;
			if (!v) continue;
			if (l.tightenOnly && RANK[v] < RANK[set]) {
				// Through "all" only "off" is worth a warning; "all": "ask" just leaves block presets at block.
				if (named || v === "off") ignore(l, `"${name}": "${v}"`);
				continue;
			}
			[set, source] = [v, l.source];
		}
		if (set !== "off") for (const [pattern, reason] of patterns) rules.push({ name, pattern, reason, action: set, source });
	}

	const custom = new Map<string, Rule>();
	const trusted = new Map<string, Rule>(); // custom rules as the trusted (non-tightenOnly) layers left them
	for (const l of layers) {
		for (const [name, r] of l.rules) {
			const t = trusted.get(name);
			if (l.tightenOnly && t && (r.action === "off" || RANK[r.action] < RANK[t.action] || r.pattern.source !== t.pattern.source || r.pattern.flags !== t.pattern.flags)) {
				ignore(l, `rule "${name}"`);
				continue;
			}
			custom.delete(name);
			if (r.action !== "off") custom.set(name, { name, pattern: r.pattern, reason: r.reason, action: r.action, source: l.source, custom: true });
		}
		if (!l.tightenOnly) {
			trusted.clear();
			for (const [k, v] of custom) trusted.set(k, v);
		}
	}

	for (const [l, what] of ignored) {
		warnings.push(`${l.source}: ignored ${what.join(", ")}: a project file can add rules or raise "ask" to "block", but not turn off or weaken the global config`);
	}
	return [...rules, ...custom.values()];
}

function agentDir(): string {
	const e = process.env.PI_CODING_AGENT_DIR;
	if (!e) return path.join(os.homedir(), ".pi", "agent");
	return e === "~" ? os.homedir() : e.startsWith("~/") ? path.join(os.homedir(), e.slice(2)) : e;
}

/** The config files, in merge order: global, then the project's (relative to the session cwd; tighten-only). */
export function configPaths(cwd: string): string[] {
	return [path.join(agentDir(), "extensions", "guardrails", "config.json"), path.join(cwd, ".pi", "guardrails.json")];
}

export const MAX_CONFIG = 64 * 1024;

/**
 * Reads a config file without ever blocking or reading without bound: opens it non-blocking (a
 * FIFO would otherwise wait for a writer), then reads only a regular file of at most MAX_CONFIG
 * bytes. undefined text means the file does not exist.
 */
function readConfig(f: string): { text?: string; error?: string } {
	let fd: number;
	try {
		fd = openSync(f, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		return code === "ENOENT" || code === "ENOTDIR" ? {} : { error: `cannot read (${(e as Error).message})` };
	}
	try {
		const st = fstatSync(fd);
		if (!st.isFile()) return { error: "not a regular file" };
		if (st.size > MAX_CONFIG) return { error: `larger than ${MAX_CONFIG / 1024} KB` };
		const buf = Buffer.alloc(MAX_CONFIG + 1);
		let n = 0;
		for (let r; n < buf.length && (r = readSync(fd, buf, n, buf.length - n, n)) > 0; ) n += r;
		if (n > MAX_CONFIG) return { error: `larger than ${MAX_CONFIG / 1024} KB` };
		return { text: buf.subarray(0, n).toString("utf8") };
	} catch (e) {
		return { error: `cannot read (${(e as Error).message})` };
	} finally {
		closeSync(fd);
	}
}

// Parsed files by path, re-parsed only when the text changes, so an edit applies to the next command.
const parsed = new Map<string, { text: string; layer?: Layer; error?: string; warnings: string[] }>();
// The last layer each path parsed to, kept while the file is unreadable or half-written.
const lastGood = new Map<string, Layer>();

/**
 * Reads and merges the config files. A missing file is no layer. A file that cannot be read or
 * parsed keeps that path's last good rules for this process (or none) and warns. Never throws.
 */
export function loadRules(files: string[]): { rules: Rule[]; warnings: string[] } {
	const layers: Layer[] = [];
	const warnings: string[] = [];
	for (const [i, f] of files.entries()) {
		const { text, error: readError } = readConfig(f);
		let layer: Layer | undefined;
		let error = readError;
		if (text === undefined && !readError) {
			lastGood.delete(f); // deleted on purpose: its rules go
			continue;
		}
		if (text !== undefined) {
			let p = parsed.get(f);
			if (!p || p.text !== text) parsed.set(f, (p = { text, ...parseConfig(text, f) }));
			warnings.push(...p.warnings);
			layer = p.layer;
			error = p.error;
			if (layer) lastGood.set(f, layer);
		}
		if (error) {
			layer = lastGood.get(f);
			warnings.push(`${f}: ${error}; ${layer ? "keeping its last good rules until it is fixed" : "none of its rules apply until it is fixed"}`);
		}
		// Every file after the first (global) one is a project file: tighten-only.
		if (layer) layers.push({ ...layer, tightenOnly: i > 0 });
	}
	return { rules: mergeLayers(layers, warnings), warnings };
}

// Warnings shown and still current: each is shown once while it persists, and again if it comes
// back after a load without it.
let warned = new Set<string>();
/** Shows new config warnings from a full, current list: a UI notice, or stderr without a UI. */
export function warnOnce(warnings: string[], ctx: Pick<ExtensionContext, "hasUI" | "ui">): void {
	for (const w of new Set(warnings)) {
		if (warned.has(w)) continue;
		if (ctx.hasUI) ctx.ui.notify(`pi-kit guardrails: ${w}`, "warning");
		else console.error(`pi-kit guardrails: ${w}`);
	}
	warned = new Set(warnings);
}

// Mutating commands blocked outright in read-only children (reviewers).
const MUTATING: RegExp[] = [
	/\bgit\b[^|;&]*\b(?:commit|push|merge|rebase|reset|checkout|switch|stash|apply|am|cherry-pick|revert|tag|branch\s+-[dDmM]|worktree\s+(?:add|remove))\b/,
	/\b(?:rm|mv|cp|chmod|chown|touch|mkdir|tee)\b/,
	/(?:^|[^<>&0-9=-])>{1,2}(?![>&])(?!\s*\/dev\/null)/,
	/\bsed\s+[^|;&]*-i\b/,
];

// More programs that write, matched only as the command word of a segment or as git's subcommand,
// so `cat ln.txt`, `grep -rn unlink src` and `git log -- add.md` run. Kept in step with pi-desk's
// port (tools/pi-desk-cli/readonly.odin) through test/readonly-vectors.json.
const WRAPPERS = new Set(["sudo", "doas", "xargs", "env", "command", "builtin", "exec", "nohup", "time", "nice", "ionice", "timeout", "stdbuf", "caffeinate", "chroot", "!", "if", "then", "else", "elif", "do", "while", "until"]);
// Each wrapper's options that take the next word as their value (sudo's -E takes none).
const WRAPPER_VALUED: Record<string, string[]> = {
	sudo: ["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U", "-T", "--user", "--group", "--chdir", "--prompt", "--role", "--type", "--host", "--other-user", "--close-from", "--command-timeout"],
	doas: ["-u", "-C"],
	xargs: ["-I", "-L", "-n", "-P", "-s", "-E", "-d", "-a", "--max-args", "--max-procs", "--max-lines", "--max-chars", "--arg-file", "--delimiter", "--eof"],
	env: ["-u", "-C", "--unset", "--chdir"],
	timeout: ["-s", "-k", "--signal", "--kill-after"],
	nice: ["-n", "--adjustment"],
	ionice: ["-c", "-n", "-p", "-P", "-u", "--class", "--classdata", "--pid", "--pgid", "--uid"],
	stdbuf: ["-i", "-o", "-e", "--input", "--output", "--error"],
	caffeinate: ["-t", "-w"],
	time: ["-f", "-o", "--format", "--output"],
	exec: ["-a"],
	chroot: ["--userspec", "--groups"],
};
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const GIT_GLOBAL_VALUED = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--super-prefix", "--exec-path"]);
const GIT_WRITES = new Set(["clean", "restore", "pull", "add", "init", "update-ref"]);

/**
 * The commands in `cmd`, each as [program, ...args]: one per segment (split at | ; & ( ) { } `
 * and newlines, so `$(…)` and `if …; then …` count), quotes dropped, the program as its basename,
 * after variable assignments, shell keywords and wrappers with their options; plus what a shell
 * runs with -c, or eval.
 */
function commandsOf(cmd: string): string[][] {
	const out: string[][] = [];
	for (const seg of cmd.split(/[|;&(){}`\n]/)) commandOf(seg.split(/\s+/).map((w) => w.replace(/['"\\]/g, "")), out);
	return out;
}

function commandOf(words: string[], out: string[][]): void {
	for (let k = 0; k < words.length; ) {
		const w = words[k];
		if (w === "" || /^[^-/=][^/=]*=/.test(w)) {
			k++; // empty, or X=1
			continue;
		}
		const name = w.slice(w.lastIndexOf("/") + 1);
		if (WRAPPERS.has(name)) {
			// its options and their values, a timeout's duration and chroot's new root, up to the command
			let rooted = false;
			for (k++; k < words.length; k++) {
				const o = words[k];
				if (o === "--") {
					k++;
					break;
				}
				if (o.startsWith("-")) {
					if (WRAPPER_VALUED[name]?.includes(o)) k++;
				} else if (name === "chroot" && !rooted) rooted = true;
				else if (name !== "timeout" || !/^\d/.test(o)) break;
			}
			continue;
		}
		const args = words.slice(k + 1);
		out.push([name, ...args]);
		if (name === "eval") commandOf(args, out);
		else if (SHELLS.has(name)) {
			const c = args.findIndex((a) => /^-(?!-).*c/.test(a));
			if (c >= 0) commandOf(args.slice(c + 1), out);
		}
		return;
	}
}

/** Whether `git config <args>` only reads (--get, --get-all, ..., --list, -l, or the get/list subcommand) and has no write option and no write option. */
function gitConfigReads(args: string[]): boolean {
	const first = args.find((a) => !a.startsWith("-"));
	const reads = first === "get" || first === "list" || args.some((a) => /^(?:--get(?:-all|-regexp|-urlmatch|-color|-colorbool)?|--list|-l)$/.test(a));
	return reads && !args.some((a) => /^(?:--add|--unset|--unset-all|--replace-all|--rename-section|--remove-section|--edit|-e)$/.test(a));
}

/** Whether one command from commandsOf writes: see the cases below. */
function writes([name, ...args]: string[]): boolean {
	switch (name) {
		case "git": {
			// its subcommand, after git's global options (-C dir, -c k=v, --git-dir x, ...)
			let k = 0;
			while (k < args.length && args[k].startsWith("-")) k += GIT_GLOBAL_VALUED.has(args[k]) ? 2 : 1;
			const sub = args[k];
			return sub === "config" ? !gitConfigReads(args.slice(k + 1)) : GIT_WRITES.has(sub);
		}
		case "rmdir":
		case "unlink":
		case "ln":
		case "truncate":
		case "wget":
			return true;
		case "dd":
			return args.some((a) => a.startsWith("of="));
		case "find":
			return args.includes("-delete");
		case "perl": // -i in a switch cluster (-i, -pi, -0777i), not inside -M's module or -e's code
			return args.some((a) => /^-(?!-)(?:0x|[^MmIeEdDCxVFi])*i/.test(a));
		case "curl": // writes a file: -o, -O, -c (cookie jar), -D (headers), in a cluster too
			return args.some((a) => /^-(?!-)[^=:.]*[oOcD]|^--(?:output|remote-name|cookie-jar|dump-header)/.test(a));
		case "tar": // creates, extracts or changes an archive (old style too: tar xzf)
			return args.some((a, i) => /^-(?!-)[^=:.]*[xcruA]|^--(?:extract|get|create|append|update|delete|concatenate)/.test(a) || (i === 0 && !a.startsWith("-") && /[xcruA]/.test(a)));
	}
	return false;
}

/** Whether `p` (relative to `cwd`) is a background shell output file (extensions/shell). */
export function isShellLog(p: string, cwd: string): boolean {
	const rel = path.relative(os.tmpdir(), path.resolve(cwd, p));
	return /^pi-shell-[^/\\]+[/\\][^/\\]+\.log$/.test(rel);
}

// High-confidence token shapes, applied to every tool result.
const TOKEN_PATTERNS: [RegExp, string][] = [
	[/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]"],
	[/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]"],
	[/\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/g, "[REDACTED]"],
	[/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g, "[REDACTED]"],
	[/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED]"],
	[/\bAIza[0-9A-Za-z_-]{35}\b/g, "[REDACTED]"],
	[/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[REDACTED JWT]"],
	[/(\b[a-z][a-z0-9+.-]*:\/\/[^:/\s@]+:)([^@\s]+)(@)/g, "$1[REDACTED]$3"],
];
// key=value secrets: only for bash output, since applying it to source files would corrupt edits.
const ASSIGNMENT: [RegExp, string] = [
	/((?:password|passwd|secret|token|api[_-]?key|access[_-]?key|auth)["']?\s*[:=]\s*["']?)([A-Za-z0-9_\-+/=.]{12,})/gi,
	"$1[REDACTED]",
];

export function redact(s: string, assignments: boolean): string {
	let out = s;
	for (const [r, rep] of TOKEN_PATTERNS) out = out.replace(r, rep);
	if (assignments) out = out.replace(ASSIGNMENT[0], ASSIGNMENT[1]);
	return out;
}

export const MAX_TESTED = 64 * 1024;

/**
 * Pure verdict for one shell command against the active rules: a block reason, or the reasons it
 * needs confirmation. Read-only sessions block mutating commands whatever the rules say.
 */
export function commandVerdict(cmd: string, readonly: boolean, rules: Rule[] = []): { block?: string; confirm: string[] } {
	if (readonly && (MUTATING.some((r) => r.test(cmd)) || commandsOf(cmd).some(writes))) {
		return { block: "Read-only session: mutating commands are not allowed.", confirm: [] };
	}
	// User regexes see at most the first MAX_TESTED chars, so a slow pattern cannot stall on a huge command.
	const head = cmd.length > MAX_TESTED ? cmd.slice(0, MAX_TESTED) : cmd;
	const hits = rules.filter((r) => r.pattern.test(r.custom ? head : cmd));
	const blocked = hits.filter((r) => r.action === "block").map((r) => r.reason);
	if (blocked.length) return { block: `Blocked by a guardrails rule (${blocked.join("; ")}). Report it to the orchestrator or ask the user instead.`, confirm: [] };
	return { confirm: hits.map((r) => r.reason) };
}

/**
 * The gate every shell command goes through (the `bash` tool here, and the kit's background shell
 * tools in extensions/shell). Returns a block reason, or undefined when the command may run.
 * Rules come from the config files (configPaths), read again for each command.
 */
export async function checkCommand(cmd: string, readonly: boolean, ctx: Pick<ExtensionContext, "hasUI" | "ui" | "cwd">): Promise<string | undefined> {
	const { rules, warnings } = loadRules(configPaths(ctx.cwd));
	warnOnce(warnings, ctx);
	const v = commandVerdict(cmd, readonly, rules);
	if (v.block) return v.block;
	if (v.confirm.length === 0) return undefined;
	const why = v.confirm.join("; ");
	if (!ctx.hasUI) return `Needs user approval (${why}), and no UI is available. Report it to the orchestrator instead.`;
	const ok = await ctx.ui.confirm("Allow this command?", `${cmd}\n\nReason: ${why}`);
	return ok ? undefined : `User declined: ${why}`;
}

/** Text for /guardrails: the files read, the active rules and where each came from. */
export function describeRules(files: string[], rules: Rule[], warnings: string[], readonly: boolean): string {
	const out = [`Guardrails config (global, then project; the project file can only add or tighten): ${files.join(", ")}`];
	if (readonly) out.push("Read-only session: mutating commands and file edits are blocked.");
	if (rules.length === 0) out.push("No command rules are on: no command asks or is blocked.");
	else for (const r of rules) out.push(`- ${r.action} ${r.name}: ${r.reason} [${r.source}]`);
	if (warnings.length) out.push("Warnings:", ...warnings.map((w) => `- ${w}`));
	out.push(`Presets: ${Object.keys(PRESETS).join(", ")} (or "all"). Example: {"enable": {"force-push": "ask"}}`);
	return out.join("\n");
}

// The kit's background shell tools (extensions/shell). They gate their own commands with
// checkCommand; here they are blocked outright in read-only sessions and get bash-level redaction.
const SHELL_TOOLS = new Set(["bash_bg", "monitor", "shell_stop", "shell_list", "wake_later"]);

export function guardrails(readonly: boolean): (pi: ExtensionAPI) => void {
	return (pi) => register(pi, readonly);
}

function register(pi: ExtensionAPI, readonly: boolean): void {
	// Show config problems at startup, not only at the first command.
	pi.on("session_start", (_e, ctx) => warnOnce(loadRules(configPaths(ctx.cwd)).warnings, ctx));

	pi.registerCommand("guardrails", {
		description: "Show the active guardrails command rules and where they come from",
		handler: async (_args, ctx) => {
			const files = configPaths(ctx.cwd);
			const { rules, warnings } = loadRules(files);
			ctx.ui.notify(describeRules(files, rules, warnings, readonly), warnings.length ? "warning" : "info");
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (readonly && (event.toolName === "edit" || event.toolName === "write")) {
			return { block: true, reason: "This is a read-only session; file changes are not allowed." };
		}
		if (readonly && SHELL_TOOLS.has(event.toolName)) {
			return { block: true, reason: "This is a read-only session; background shell tools are not allowed." };
		}

		if (event.toolName !== "bash") return undefined;
		const reason = await checkCommand(String((event.input as { command?: unknown }).command ?? ""), readonly, ctx);
		return reason ? { block: true, reason } : undefined;
	});

	pi.on("tool_result", async (event, ctx) => {
		// Shell output files hold raw command output, so reading one is redacted like bash output.
		const p = (event.input as { path?: unknown }).path;
		const assignments = event.toolName === "bash" || SHELL_TOOLS.has(event.toolName) || (event.toolName === "read" && typeof p === "string" && isShellLog(p, ctx.cwd));
		let changed = false;
		const content = event.content.map((part) => {
			if (part.type !== "text") return part;
			const t = redact(part.text, assignments);
			if (t !== part.text) changed = true;
			return { ...part, text: t };
		});
		if (!changed) return undefined;
		// Replacing content without structuredContent would drop it; redact it too.
		const structuredContent =
			event.structuredContent === undefined ? undefined : JSON.parse(redact(JSON.stringify(event.structuredContent), assignments));
		return { content, structuredContent };
	});
}
