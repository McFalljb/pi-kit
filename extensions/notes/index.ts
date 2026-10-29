// Compaction reminder for skill session-notes: when the context passes PI_KIT_NOTES_REMIND_PERCENT
// (default 75) of the window, steer the session once to rewrite its session note's status block
// before pi compacts. Re-arms after each compaction. Not loaded in pi-subagents children.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PERCENT = Number(process.env.PI_KIT_NOTES_REMIND_PERCENT) || 75;

export default function notes(pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT_CHILD === "1") return;
	let reminded = false;
	pi.on("session_compact", () => {
		reminded = false;
	});
	pi.on("turn_end", (_event, ctx) => {
		const percent = ctx.getContextUsage()?.percent;
		if (reminded || percent == null || percent < PERCENT) return;
		reminded = true;
		pi.sendMessage(
			{
				customType: "pi-kit-notes",
				display: true,
				content: `Context is ${Math.round(percent)}% full and will be compacted soon. If this session keeps a session note (skill session-notes), rewrite its status block now: goal, in flight (ids, output paths), waiting on the user, next step. Then carry on.`,
			},
			{ deliverAs: "steer" },
		);
	});
}
