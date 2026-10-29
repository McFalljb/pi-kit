// Ambient guardrails: loaded in every pi session that has the kit installed (and in pi-subagents
// background children that load ambient extensions). PI_KIT_READONLY=1 makes it read-only.
import { guardrails } from "./core.ts";

export default guardrails(process.env.PI_KIT_READONLY === "1");
