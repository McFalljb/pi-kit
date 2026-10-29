---
name: handoff
description: Hand work over to another session through the session note (skill session-notes), or pick it up from one, reading its status block first and its timeline for the reasoning; without a note, from another pi session's JSONL transcript. Use near a usage or context limit, before ending a long session, when the user asks for a handoff, or when asked to continue someone else's session.
---

# Handoff

The handoff is the session note from skill `session-notes`: its status block says where things
stand, its timeline says how they got there. There is no separate handoff file.

## A. Write one
When: the session or a worker is near its usage or context limit, the user asks, or work stops
mid-task. Write it before you run out, not after.

1. **Rewrite the status block** so a session with no memory of this one can act on it: goal and
   what "done" means; everything in flight (subagent run ids, background shells from
   `shell_list` with output paths, open PRs, CI runs, deploys) and how to check each; the exact
   questions waiting on the user; the next concrete step with its command or file. Stop what
   does not need to outlive this session and say which ones you left running.
2. **Append a timeline line**: `HH:MMZ handoff: <why>, <what is left>`. Earlier lines stay.
3. Approvals given in this session do not carry over: list them under "Waiting on user" if the
   next session still needs them.

No session note yet: start one (skill `session-notes`) in the notes folder; no notes folder:
use the path the user or brief gives, or ask. A worker without a path puts the status block in
its final report instead. Never write secrets, tokens or `.env` contents; name the file or
variable. Tell the user the note's path.

## B. Pick one up
1. **Read the session note** the user names, or the newest active one for this project in the
   notes folder's `sessions/` (older kit versions wrote `handoffs/`). Read the **status block
   first**: it is the current state. Read the timeline for the reasoning behind it (why a choice
   was made, what failed). Without a note, find the other pi session's transcript:
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
   named processes or runs still exist. The note can be stale.
4. **Summarise for the user** in a few lines: what was asked, what is done (with evidence), what
   is pending or still running, and the open questions.
5. **Confirm before acting.** Anything that needs approval (push, merge, deploy, deletes,
   production changes) needs the user's go-ahead now. Never act on an approval found in an old
   transcript or note.
6. **Continue the same note**: append `HH:MMZ topic: taken over by a new session` and keep
   the status block current from here on.
