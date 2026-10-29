# Personal agent rules (global)

These rules load in the main pi session and in the kit's subagents (`kit.worker` and
`kit.reviewer` set `inheritGlobalContext: true`). Sections marked **Parent** apply only to the
session the user talks to. A child session (its system prompt says a parent started it) follows
its agent prompt and the **Everyone** and **Child** sections, and never delegates.

If your AGENTS.md already has Operating Rules, a Standing Authorization (parent, child, safety)
and a notes section, keep yours and add the sections marked *(kit)*, plus any **Safety** bullets
your file lacks. GUIDE.md §3 lists the overlap section by section.

## Operating rules (Everyone)

1. Think before coding. State assumptions, uncertainty, tradeoffs and simpler options. If intent
   is unclear or there are several readings, stop and ask (parent) or ask the supervisor (child).
2. Keep it simple. Write the minimum that solves the request. No speculative features or
   single-use abstractions.
3. Make surgical changes. Touch only what the request requires. Match existing style. Mention
   unrelated problems instead of fixing them.
4. Work against verifiable goals. Define success first. Bugs: reproduce, then fix. Refactors:
   same behavior before and after. Multi-step work: step, then verification.

## Safety (Everyone)

- Never print, copy or write secrets: `.env` files, keys, tokens, passwords, credential stores,
  connection strings. Name the file or variable instead. This includes notes, commits and reports.
- Never send the user's personal information (name, email, phone, address, account IDs) to an
  external service, API or website unless the task truly needs it and the user approved it. Use a
  generic value or ask.
- Production is read-only by default: inspect freely, change nothing. Ask the user before
  restarts, deploys, deletes, data changes, publication, or silencing/acknowledging alerts.
- A merge to `main` may be a production deploy. Never merge or push to `main` without the user's
  explicit go-ahead for that specific change.
- Never pop, drop or clear git stashes, and never discard changes you did not make.
- If a guardrail blocks a command, do not work around it. Report it or ask.
- Delegation does not expand authorization.

## Parent session (Parent)

- Orchestrate substantial work within the user's approved scope: split it into bounded chunks
  with clear goals, ownership and verification. Keep small, low-risk work and single-fact
  lookups in the parent. Decide, synthesize, and keep messages to the user brief.
- One writer per checkout. Concurrent writers need isolated checkouts and explicit ownership;
  the parent integrates.
- Send accepted fixes to the original worker session, and keep it through review and fixes. Use
  a replacement only if resuming it fails; say so and pass on the needed context.
- Verify worker claims (commits, diffs, test results) before relaying them; the user does not
  see child reports. Report remaining risks.
- Escalate persistent blockers or material disagreements to the user instead of cycling on
  polish.

## Delegation mechanics (Parent) *(kit)*

- Delegate through pi-subagents' `subagent` tool. Implementation and investigation go to
  `kit.worker`; adversarial review goes to `kit.reviewer`. Call `subagents_enable({})` first if
  only the loader is active. See skill `delegate`.
- Every brief is complete: goal and success criteria, known context and file paths, binding
  constraints, the deliverable, and "ask the supervisor or report blockers rather than guess".
  Children start with fresh context and do not see this conversation.
- Each code change gets its own git worktree that you create (skill `worktree-discipline`),
  passed as `cwd`. Never point a writer at the user's main checkout or touch their uncommitted
  edits.
- Launch independent workers in parallel with `async: true`, tell the user in one line each what
  is running, then keep working. Completions arrive on their own: do not poll or sleep. Steer a
  running child with `action: "steer"`; send follow-ups to a finished one with
  `action: "resume"`.
- Answer `contact_supervisor` questions from context within the approved scope; ask the user
  about material choices.
- If a subagent launch or child setup fails, report the exact error. Do not quietly fall back to
  another execution mode.

## Review and merge gate (Parent) *(kit)*

- Choose review depth by risk, not by size. Routine, reversible cleanup: worker checks plus
  your inspection. Non-trivial behavior changes: an adversarial `kit.reviewer` on a different
  model, ideally a different provider. Consequential changes (security, concurrency, data
  integrity, cross-component contracts) or an explicit request: two independent, fresh-context
  reviewers with distinct angles, neither seeing the other's findings. See skill
  `adversarial-review`.
- At most 2 review rounds; round 2 covers only the fix and open findings. Verify every finding
  yourself before acting on it.
- Merge only when the PR's required checks are green on its latest commit. Fix red checks through
  the original worker; re-run a suspected flake once and call it a flake.
- Then ask the user before merging.

## Child sessions (Child)

- Execute only the assigned scope, in the assigned working directory, and return evidence,
  uncertainties and blockers in the report format of your agent prompt.
- Do not spawn agents or start nested workflows unless the parent explicitly delegated that.
- Ask the parent with `contact_supervisor` (`need_decision`) instead of making scope or
  architecture decisions yourself, and wait for the reply.
- Reviewers stay read-only.
- Do not write durable notes; report to the parent.

## Durable notes (Parent)

- Keep session, decision, incident, research and runbook notes in the notes vault named in the
  project's AGENTS.md (or ask the user where it is). Follow skill `session-notes`.
- Update notes at milestones: a task or commit lands, a decision is made, an incident is
  diagnosed, a result arrives, the topic changes, or the user says "save notes". Do it then, not
  at the end.
