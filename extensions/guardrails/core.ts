/**
 * pi-kit guardrails core: best-effort safety rails, not a sandbox.
 *
 * - Confirms dangerous bash commands (destructive git, rm -rf, deploys, cluster/infra changes,
 *   alert silencing, SQL drops). Without a UI (print/json mode, subagent children) they are blocked.
 * - Blocks reading or writing secret files (.env, keys, credential stores) through tools and bash.
 * - In read-only sessions blocks file edits and mutating bash commands.
 * - Redacts secret-shaped strings from tool output before the model sees it.
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

// Type-only import, so the pure functions here load under plain node for test/unit.test.ts.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// [pattern, why] — matched against the whole bash command.
const DANGEROUS: [RegExp, string][] = [
	[/\brm\b(?=[^|;&]*\s(?:-[a-zA-Z]*[rR]|--recursive))(?=[^|;&]*\s(?:-[a-zA-Z]*f|--force))/, "recursive force delete"],
	[/\bgit\b[^|;&]*\bpush\b[^|;&]*(?:\s--force(?:-with-lease)?\b|\s-[a-zA-Z]*f\b|\s\+\S)/, "force push"],
	[/\bgit\b[^|;&]*\bpush\b[^|;&]*\b(?:main|master)\b/, "push to main/master (a merge to main may be a production deploy)"],
	[/\bgh\s+pr\s+merge\b/, "merge a pull request (may deploy)"],
	[/\bgit\b[^|;&]*\bstash\s+(?:drop|pop|clear)\b/, "drops or pops a stash"],
	[/\bgit\b[^|;&]*\breset\s+[^|;&]*--hard\b/, "hard reset discards changes"],
	[/\bgit\b[^|;&]*\bclean\s+-[a-zA-Z]*f/, "git clean deletes untracked files"],
	[/\bgit\b[^|;&]*\bbranch\s+[^|;&]*-D\b/, "force-deletes a branch"],
	[/\bgit\b[^|;&]*\b(?:checkout|restore)\s+(?:--\s+)?\.(?:\s|$)/, "discards working-tree changes"],
	[/\bgit\b[^|;&]*\bworktree\s+remove\b[^|;&]*--force\b/, "force-removes a worktree"],
	[/\bkubectl\b[^|;&]*\b(?:delete|apply|replace|patch|scale|drain|cordon|edit|rollout\s+(?:restart|undo)|set\s+image)\b/, "changes a cluster"],
	[/\bhelm\s+(?:install|upgrade|uninstall|rollback|delete)\b/, "changes a Helm release"],
	[/\b(?:terraform|tofu)\s+(?:apply|destroy|import|state\s+rm)\b/, "changes infrastructure"],
	[/\bdocker\b[^|;&]*\b(?:down|rm|rmi|prune|kill)\b/, "removes containers, images or volumes"],
	[/\bsystemctl\s+(?:restart|stop|disable|kill)\b/, "restarts or stops a service"],
	[/(?:^|[;&|]\s*)(?:\S*\/)?deploy[\w.-]*(?:\s|$)|\b(?:make|just|npm\s+run|pnpm|yarn)\s+deploy\b/, "runs a deploy"],
	[/\b(?:amtool\s+silence|api\/v[12]\/silences?|alerts?\s+ack)\b/i, "silences or acknowledges alerts"],
	[/\b(?:drop|truncate)\s+(?:table|database|schema)\b|\bdelete\s+from\b/i, "destructive SQL"],
	[/\bsudo\b/, "runs as root"],
	[/\b(?:mkfs|dd\s+if=)/, "writes raw disks"],
	[/\b(?:npm|pnpm|yarn)\s+publish\b/, "publishes a package"],
	[/\bcurl\b[^|]*\|\s*(?:ba|z)?sh\b/, "pipes a download into a shell"],
	[/\bssh\b/, "runs on a remote host"],
];

// Mutating commands blocked outright in read-only children (reviewers).
const MUTATING: RegExp[] = [
	/\bgit\b[^|;&]*\b(?:commit|push|merge|rebase|reset|checkout|switch|stash|apply|am|cherry-pick|revert|tag|branch\s+-[dDmM]|worktree\s+(?:add|remove))\b/,
	/\b(?:rm|mv|cp|chmod|chown|touch|mkdir|tee)\b/,
	/(?:^|[^<>&0-9=-])>{1,2}(?![>&])(?!\s*\/dev\/null)/,
	/\bsed\s+[^|;&]*-i\b/,
];

// Secret files: matched against a path (tools) or anywhere in a bash command.
const SECRET_IN_TEXT: RegExp[] = [
	/(?:^|[\s'"=/:])\.env(?:\.(?!example\b|sample\b|template\b|dist\b)[\w-]+)?(?=$|[\s'";|&)<>])/,
	/\bid_(?:rsa|ed25519|ecdsa|dsa)\b(?!\.pub)/,
	/\.(?:pem|key|p12|pfx|keystore|jks)(?=$|[\s'";|&)])/,
	/\.aws\/credentials\b|\.netrc\b|\.pgpass\b|\.npmrc\b|\.pypirc\b|\.docker\/config\.json\b|\.kube\/config\b/,
	/\.pi\/agent\/auth\.json\b|\bcredentials\.json\b|\bsecrets?\.(?:ya?ml|json|toml)\b/,
];
const SECRET_COMMANDS: RegExp[] = [
	/\bsops\b[^|;&]*\s(?:-d|--decrypt|decrypt|exec-env|exec-file)\b/,
	/(?:^|[;&|]\s*)(?:printenv|env|export\s+-p|set)\s*(?:$|[;&|])/,
	/\bpi\s+auth\s+print-/,
	/\b(?:security\s+find-(?:generic|internet)-password|op\s+read|vault\s+kv\s+get|gcloud\s+auth\s+print-)/,
];

const PATH_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls"]);

function isSecretPath(p: string): boolean {
	return SECRET_IN_TEXT.some((r) => r.test(` ${p}`));
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

/** Pure verdict for one shell command: a block reason, or the reasons it needs confirmation. */
export function commandVerdict(cmd: string, readonly: boolean): { block?: string; confirm: string[] } {
	if (SECRET_IN_TEXT.some((r) => r.test(` ${cmd}`)) || SECRET_COMMANDS.some((r) => r.test(cmd))) {
		return { block: "Command touches a secret/credential file or prints secrets. Not allowed; ask the user to run it with `!` if truly needed.", confirm: [] };
	}
	if (readonly && MUTATING.some((r) => r.test(cmd))) {
		return { block: "Read-only session: mutating commands are not allowed.", confirm: [] };
	}
	return { confirm: DANGEROUS.filter(([r]) => r.test(cmd)).map(([, why]) => why) };
}

/**
 * The gate every shell command goes through (the `bash` tool here, and the kit's background shell
 * tools in extensions/shell). Returns a block reason, or undefined when the command may run.
 */
export async function checkCommand(cmd: string, readonly: boolean, ctx: Pick<ExtensionContext, "hasUI" | "ui">): Promise<string | undefined> {
	const v = commandVerdict(cmd, readonly);
	if (v.block) return v.block;
	if (v.confirm.length === 0) return undefined;
	const why = v.confirm.join("; ");
	if (!ctx.hasUI) return `Needs user approval (${why}), and no UI is available. Report it to the orchestrator instead.`;
	const ok = await ctx.ui.confirm("Allow this command?", `${cmd}\n\nReason: ${why}`);
	return ok ? undefined : `User declined: ${why}`;
}

// The kit's background shell tools (extensions/shell). They gate their own commands with
// checkCommand; here they are blocked outright in read-only sessions and get bash-level redaction.
const SHELL_TOOLS = new Set(["bash_bg", "monitor", "shell_stop", "shell_list", "wake_later"]);

export function guardrails(readonly: boolean): (pi: ExtensionAPI) => void {
	return (pi) => register(pi, readonly);
}

function register(pi: ExtensionAPI, readonly: boolean): void {
	pi.on("tool_call", async (event, ctx) => {
		if (readonly && (event.toolName === "edit" || event.toolName === "write")) {
			return { block: true, reason: "This is a read-only session; file changes are not allowed." };
		}
		if (readonly && SHELL_TOOLS.has(event.toolName)) {
			return { block: true, reason: "This is a read-only session; background shell tools are not allowed." };
		}

		if (PATH_TOOLS.has(event.toolName)) {
			const p = (event.input as { path?: unknown }).path;
			if (typeof p === "string" && isSecretPath(p)) {
				return { block: true, reason: `"${p}" looks like a secret or credential file. Do not read or write it; name the file or variable instead.` };
			}
			return undefined;
		}

		if (event.toolName !== "bash") return undefined;
		const reason = await checkCommand(String((event.input as { command?: unknown }).command ?? ""), readonly, ctx);
		return reason ? { block: true, reason } : undefined;
	});

	pi.on("tool_result", async (event) => {
		const assignments = event.toolName === "bash" || SHELL_TOOLS.has(event.toolName);
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
