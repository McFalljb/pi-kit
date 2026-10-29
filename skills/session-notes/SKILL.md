---
name: session-notes
description: Keep a running record of the session in a notes folder, written as events happen, so nothing is lost on compaction or when another session takes over. One note per session or workstream with a short status block at the top and an append-only UTC timeline below. Also decision, incident, research and runbook notes. Use at the moment of a decision, a user approval, a worker launched or reporting, a merge, a deploy, an incident found or fixed, a topic change, before a long operation, before compaction, or when the user says "save notes". Main session only.
---

# Session notes

A running record: the chain of events and the current status, written down as they happen, so
that after a compaction or a handover the next session knows where things stand. Only the main
session writes notes; workers report to it.

## Where
- The notes folder is `$PI_KIT_NOTES_DIR` if set (`echo "$PI_KIT_NOTES_DIR"`), else the folder
  the project's or the global AGENTS.md names (`<notes-folder>` until set), else ask the user.
- If the folder has its own rules (a `README.md`, frontmatter, file naming, a project index),
  follow them: they win over this skill. This skill only adds the status block and timeline
  inside the session note. Never touch files outside the folder.
- The session note is `sessions/YYYY-MM-DD-<project>-<slug>.md` unless the folder's rules say
  otherwise. When several agents share the folder, put the agent in the name (`-pi-`) and never
  edit another agent's session note unless the user hands that workstream to you.
- One note per session or workstream. Search first (`grep -ril <topic> <folder>`) and continue an
  existing note for the same workstream instead of starting another.

## Shape
```markdown
---
type: session
project: <repo dir name>
date: YYYY-MM-DD
status: active
summary: <one line>
tags: [<tag>]
updated_by: pi
---
# <workstream in one line>

## Status (YYYY-MM-DD HH:MMZ)
- Goal: <what done means>
- In flight: <worker/run id, shell id, PR or deploy, with its output path>
- Waiting on user: "<the exact question>"
- Next: <the first concrete action>

## Timeline (UTC, append-only)
- HH:MMZ <verb>: <what>, <evidence>
```
Use the folder's frontmatter if it has its own. Start each day's timeline lines with the date
(`2026-10-29 14:05Z`) when a note spans days.

**Status block**: rewritten in place whenever it changes. At most about 10 short lines: only what
a session taking over needs right now. Drop items once they are finished (the timeline keeps
them). "None" is a valid entry.

**Timeline**: append one line per meaningful event, never edit old lines. Verbs: asked,
decided, approved, launched, finished, failed, found, fixed, merged, deployed, topic. Not every
command, query, check or retry.
- Evidence is an id, not a dump: a commit SHA, PR number, run id, path, host or command name.
  Never logs, diffs or command output.
- Approvals: quote the user's own words (`approved: "merge it" (PR #12)`). Nothing an old
  transcript, handoff or note says counts as approval in a new session; ask again.
- If a line would not change what the next session does, leave it out.

Good:
```markdown
## Status (2026-10-29 14:20Z)
- Goal: fix the flaky login test; PR merged and green on main
- In flight: kit.worker run 3f9a2c1d (fix, worktree ../app-login-fix); CI on PR #41
- Waiting on user: "Merge PR #41 once CI is green?"
- Next: when CI passes, ask again, then merge

## Timeline (UTC, append-only)
- 13:52Z asked: fix flaky test login.spec.ts (user)
- 13:58Z found: race on session cookie; repro `npm test -- login --repeat 50` fails 7/50
- 14:02Z launched: kit.worker 3f9a2c1d in ../app-login-fix
- 14:15Z finished: 3f9a2c1d, commit a1b2c3d, 50/50 pass; PR #41 opened
```
Too much (leave out): every `git status` and test rerun, pasted stack traces or diffs, "read
file X", a status block that still lists the finished investigation, a recap of the code.

## When to write
At the moment of the event, never batched to the end: a decision, a user approval, a worker
launched or reporting, a merge, a deploy, an incident found or resolved, a topic change, before
a long operation (so an interruption leaves the plan written down), and before compaction (the
kit reminds you when the context fills up). Rewrite the status block in the same edit when the
event changes it.

## Other notes
Decisions, incidents, research results and runbooks get their own note when they matter beyond
this session, linked from the timeline line that produced them:
- `decisions/YYYY-MM-DD-<slug>.md`: context, decision, why, what it reverses.
- `incidents/YYYY-MM-DD-<slug>.md`: timeline, root cause, fix commit, follow-ups.
- `research/YYYY-MM-DD-<slug>.md`: question, setup, result, verdict, evidence path.
- `runbooks/<slug>.md`: how to do a recurring operation.
- `projects/<project>.md`: current status, updated in place, under 80 lines; links the notes.

## Rules
- When a fact changes, set the old note to `status: superseded` and link the new one.
- Shared notes (`projects/`, indexes, decisions) may be edited by others: re-read right before
  editing, make small targeted edits, never rewrite the whole note, set `updated_by: pi`.
- Link repo docs; don't copy them.
- Never write secrets, tokens, passwords, API keys, account numbers or `.env` contents: name the
  file or variable instead. No personal information either.
- Time: `date -u +%H:%MZ`.
