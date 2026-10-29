// Read-only guardrails for reviewer children: blocks edit/write and mutating bash on top of the
// normal rules. Loaded through the reviewer agent's `extensions` frontmatter, so it applies in
// both foreground (in-process) and background pi-subagents children.
import { guardrails } from "./core.ts";

export default guardrails(true);
