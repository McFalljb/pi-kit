// Test-only (test/desk-fake.mjs desk): another extension takes a message typed in pi ("handled"),
// so it never starts: the bridge must not tell pi-desk the comments went with it.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("input", (e) => (e.text.startsWith("drop-me") ? { action: "handled" } : { action: "continue" }));
}
