---
name: session-notes
description: Write or update durable Obsidian-style notes (session, decision, incident, research, runbook) with required frontmatter in the notes vault. Use when a task or commit lands, a decision is made, an incident is diagnosed, a result arrives, the topic changes, or the user says "save notes". Main session only.
---

# Session notes

Only the main session writes notes. Workers report to it.

## Where
The vault folder named in AGENTS.md (ask the user if none is). Read its `README.md` first; its
conventions win over this skill. Never touch files outside that folder.

## Layout
- `sessions/YYYY-MM-DD-<project>-pi-<slug>.md`: what got done, state, next. Your own notes only;
  never edit another agent's session notes.
- `decisions/YYYY-MM-DD-<slug>.md`: context, decision, why, what it reverses.
- `incidents/YYYY-MM-DD-<slug>.md`: timeline, root cause, fix commit, follow-ups.
- `research/YYYY-MM-DD-<slug>.md`: question, setup, result, verdict, evidence path.
- `runbooks/<slug>.md`: how to do a recurring operation.
- `projects/<project>.md`: current status, updated in place, under 80 lines; links the notes above.

## Frontmatter (required on every note)
```yaml
---
type: session | decision | incident | research | runbook | project
project: <repo dir name>
date: YYYY-MM-DD
status: active | superseded | resolved
summary: <one line>
tags: [<tag>, ...]
updated_by: pi
---
```

## Rules
- Write at the milestone, not at the end of the session.
- Search the vault first (`grep -ril <topic> <vault>`); update an existing note instead of
  duplicating. When a fact changes, set the old note to `status: superseded` and link the new one.
- Shared notes (`projects/`, `_index.md`, decisions) may be edited by other agents: re-read right
  before editing, make small targeted edits, never rewrite the whole note, set `updated_by: pi`.
- Record facts with evidence: commit SHAs, paths, hosts, commands. Link repo docs; don't copy them.
- Never write secrets, tokens, passwords, API keys, account numbers or `.env` contents. Name the
  file or variable instead. No personal information either.
- Wikilinks within the vault: `[[YYYY-MM-DD-slug]]`.
