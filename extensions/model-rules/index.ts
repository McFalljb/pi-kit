// GPT-only rules: when the session's model is an OpenAI GPT model, add rules/gpt.md (or the
// user's <agent-dir>/rules/gpt.md, which wins) to the system prompt as a <gpt_rules> section.
// They curb GPT's habits (over-testing, over-exploring, long reports); other models get nothing.
// The kit's agents list this extension, so kit.worker and kit.reviewer get it on GPT too.
import type { ExtensionAPI, NormalizedBuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KIT_RULES = fileURLToPath(new URL("../../rules/gpt.md", import.meta.url));

// Matches on the model id, not the provider, so GPT served by openai, openai-codex, azure or a
// router (ids like "gpt-6.1-sol" or "openai/gpt-6.1-sol") all count.
export function isGpt(modelId: string | undefined): boolean {
	return /(^|\/)gpt-/i.test(modelId ?? "");
}

export function addRules(options: NormalizedBuildSystemPromptOptions, modelId: string | undefined, rules: string): void {
	if (isGpt(modelId)) options.sections.gpt_rules = rules.trim();
}

export default function modelRules(pi: ExtensionAPI) {
	pi.on("before_agent_start", (event, ctx) => {
		if (!isGpt(ctx.model?.id)) return;
		const user = path.join(process.env.PI_CODING_AGENT_DIR ?? path.join(homedir(), ".pi/agent"), "rules/gpt.md");
		addRules(event.systemPromptOptions, ctx.model?.id, readFileSync(existsSync(user) ? user : KIT_RULES, "utf8"));
	});
}
