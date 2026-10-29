// Compaction reminder for skill session-notes: when the context passes PI_KIT_NOTES_REMIND_PERCENT
// (default 75; 0 disables) of the window, add one note to the context asking the session to
// rewrite its session note's status block before pi compacts. Only on a turn that ran tools (the
// run goes on), and it never starts a turn of its own, so a final answer is never replaced or
// followed by an extra turn. Re-arms after each compaction. Not loaded in
// pi-subagents children.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const raw = process.env.PI_KIT_NOTES_REMIND_PERCENT;
const PERCENT = raw ? Number(raw) : 75;

export default function notes(pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT_CHILD === "1" || !(PERCENT > 0)) return;
	let reminded = false;
	pi.on("session_compact", () => {
		reminded = false;
	});
	pi.on("turn_end", (event, ctx) => {
		const percent = ctx.getContextUsage()?.percent;
		if (reminded || !event.toolResults.length || percent == null || percent < PERCENT) return;
		reminded = true;
		// triggerTurn false: appended at the end of this turn, seen by the run's next request.
		pi.sendMessage(
			{
				customType: "pi-kit-notes",
				display: true,
				content: `Context is ${percent.toFixed(1)}% full and will be compacted soon. If this session keeps a session note (skill session-notes), rewrite its status block now: goal, in flight (ids, output paths), waiting on the user, next step. Then carry on.`,
			},
			{ triggerTurn: false },
		);
	});
}
