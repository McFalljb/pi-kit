// Pure helpers for the model-rules extension (unit-tested without pi).
import type { NormalizedBuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";

// Matches on the model id, not the provider, so GPT served by openai, openai-codex, a router or
// Bedrock (ids like "gpt-6.1-sol", "openai/gpt-6.1-sol", "us.openai.gpt-6.1-sol") all count.
// Custom-named deployments (e.g. Azure) whose id lacks "gpt-" do not.
export function isGpt(modelId: string | undefined): boolean {
	return /(^|[/.])gpt-/i.test(modelId ?? "");
}

export function addRules(options: NormalizedBuildSystemPromptOptions, modelId: string | undefined, rules: string): void {
	if (isGpt(modelId)) options.sections.gpt_rules = rules.trim();
}
