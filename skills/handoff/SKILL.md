---
name: handoff
description: Write a short handoff so another session can continue the work (goal, state, done with evidence, in flight, open questions, next steps), or pick up from one by reading a handoff or another pi session's JSONL transcript. Use near a usage or context limit, before ending a long session, when the user asks for a handoff, or when asked to continue someone else's session.
---

# Handoff

## A. Write one
When: the session or a worker is near its usage or context limit, the user asks, or work stops
mid-task. Write it before you run out, not after.

Where: the path the user or brief gives; otherwise the notes folder from AGENTS.md as
`handoffs/YYYY-MM-DD-<project>-<slug>.md`; otherwise ask. A worker without a path puts the
handoff in its final report instead.

Template (keep it under about 60 lines; facts, not narrative):
```markdown
---
type: handoff
project: <repo dir name>
date: YYYY-MM-DD
status: active
summary: <one line>
---
# Handoff: <goal in one line>

## Goal
What the user asked for and what "done" means.

## State
One paragraph: where things stand right now.

## Done (with evidence)
- <what> — commit `<sha>` on `<branch>` in `<worktree path>`; checks `<command>` → pass/fail.

## In flight
- Background shells (`shell_list`), subagent runs (ids), open PRs, CI runs: what, where, how to
  check. Stop what does not need to outlive this session; say which ones you left running.

## Open questions for the user
- Decisions or approvals still needed. Approvals given in this session do not carry over.

## Next steps
1. <first concrete action, with the command or file>
```
Never write secrets, tokens or `.env` contents; name the file or variable. Link to repo docs,
don't copy them. Tell the user the handoff's path.

## B. Pick one up
1. **Read the handoff** the user names (or the newest under the notes folder's `handoffs/` for
   this project). Without one, find the other pi session's transcript:
   `ls -t "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/sessions/"*/ | head` (one folder per working
   directory; the user may name the session file or id). pi's `docs/session-format.md` describes
   the format.
2. **Read a transcript without dumping it.** Entries are JSON lines forming a tree by `parentId`;
   the live branch ends at the last entry. User requests and assistant text are enough for a
   summary; skip tool results, which may contain secrets:
   ```bash
   jq -r 'select(.type=="message" and (.message.role=="user" or .message.role=="assistant"))
     | .message.role + ": " + (if (.message.content|type)=="string" then .message.content
       else ([.message.content[]? | select(.type=="text") | .text] | join(" ")) end)
     | .[0:400]' <session.jsonl> | tail -n 80
   jq -r 'select(.type=="compaction") | .summary' <session.jsonl> | tail -n 1
   ```
3. **Check the state yourself**: `git -C <worktree> status`, `git log`, open PRs and CI, whether
   named processes or runs still exist. The handoff can be stale.
4. **Summarise for the user** in a few lines: what was asked, what is done (with evidence), what
   is pending or still running, and the open questions.
5. **Confirm before acting.** Anything that needs approval (push, merge, deploy, deletes,
   production changes) needs the user's go-ahead now. Never act on an approval found in an old
   transcript or handoff.
