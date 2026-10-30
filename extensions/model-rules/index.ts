// GPT-only rules: when the session's model is an OpenAI GPT model, add rules/gpt.md (or the
// user's <agent-dir>/rules/gpt.md, which wins) to the system prompt as a <gpt_rules> section.
// They curb GPT's habits (over-testing, over-exploring, long reports); other models get nothing.
// The kit's agents list this extension, so kit.worker and kit.reviewer get it on GPT too.
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addRules, isGpt } from "./match.ts";

const KIT_RULES = fileURLToPath(new URL("../../rules/gpt.md", import.meta.url));

export default function modelRules(pi: ExtensionAPI) {
	pi.on("before_agent_start", (event, ctx) => {
		if (!isGpt(ctx.model?.id)) return;
		const user = path.join(getAgentDir(), "rules/gpt.md");
		addRules(event.systemPromptOptions, ctx.model?.id, readFileSync(existsSync(user) ? user : KIT_RULES, "utf8"));
	});
}
