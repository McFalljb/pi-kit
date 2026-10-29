---
name: delegate
description: Split work into self-contained tasks and run them as parallel background pi-subagents children (agent kit.worker), each with a complete brief and its own git worktree, then collect, verify and relay their reports. Use for multi-step implementation, investigations across many files or long runs. Not for single-fact lookups. Main session only.
---

# Delegate to background workers (pi-subagents)

You are the parent session. Children start fresh: they never see this conversation, only the
task text you give them.

## 0. Make the tool available
If only `subagents_enable` is listed (not `subagent`), call `subagents_enable({})` once; the
`subagent` tool is available on the next request. Delegation within the user's approved scope
is authorized by AGENTS.md.

## 1. Decide what to delegate
- Delegate: self-contained implementation, multi-file investigations, long runs (builds, test
  sweeps, backfills). Independent pieces run in parallel.
- Keep in the parent: decisions, synthesis, talking to the user, single-fact lookups, and small,
  low-risk edits.
- One writer per checkout. Two tasks that edit the same files are one task, or run one after
  the other.

## 2. Isolate each code-changing task
Create the worktree yourself (skill `worktree-discipline`), so the branch lives on for the PR
and the CI gate:
```bash
git -C <repo> fetch origin
git -C <repo> worktree add -b <type>/<slug> <worktrees-dir>/<slug> origin/main
```
Pass it as `cwd`. Read-only investigations may run in the repo itself.

pi-subagents' own `worktree: true` makes a *temporary* worktree from a clean checkout, hands
back a patch and removes the worktree and branch afterwards. Use it only for throwaway parallel
experiments whose patch you will apply yourself, not for work that becomes a PR.

## 3. Write a complete brief
Fill every section; "none" is a valid answer, a missing section is not.
```markdown
# <one-line goal>

## Goal and success criteria
What "done" means, checkably (tests that pass, behavior observed, a question answered).

## Context
Known facts, file paths, relevant commits, prior findings, data locations, related docs.

## Binding constraints
- Work only in <worktree path> on branch <branch>. Commit locally; no push, merge, PR or deploy
  (or: "push to origin <branch> allowed", never main).
- No ssh or production changes unless stated here: <exact allowed action or "none">.
- Never read or print secrets. Follow the repo's AGENTS.md.
- Tests: <narrowest target while iterating; anything to run before finishing>.

## Deliverable
The report format from your agent prompt, with commit SHAs and commands run with pass/fail.

Ask with contact_supervisor if a decision is needed; otherwise stop and report blockers rather
than guess.
```

## 4. Launch
One call per task, all in the same turn for parallel work:
```ts
subagent({ agent: "kit.worker", task: "<brief>", cwd: "<worktree>", async: true })
```
- `model: "provider/id:thinking"` overrides the agent's model and thinking for one run.
- Long writers: add `options: { timeoutMs: <ms>, checkpointBeforeDeadlineMs: 120000 }`. Do not
  give writers a hard `toolBudget`.
- Tell the user in one line per worker what is running (worktree, branch, run id). Then keep
  working or end your turn. Each completion arrives as a "Background task completed" message;
  do not poll or sleep. Running work also shows in FleetView (`/subagents-fleet`).

## 5. While they run
- Check: `subagent({ action: "status", id })`, or `options: { view: "transcript", lines: 80 }`.
- Redirect a running worker: `subagent({ action: "steer", id, message })`. The default mode
  lets the running tool call finish, then delivers the message before the child's next step;
  `options: { mode: "follow_up" }` waits until the child's current turn ends. The receipt
  (`queued`, `delivered`, ...) means the child received it, not that it complied.
- A worker that asks a question (`contact_supervisor`) shows up as a supervisor request. Answer
  from context within the approved scope with
  `subagent_supervisor({ action: "reply", replyTo, message })`, and ask the user about material
  choices.
- Stop: `subagent({ action: "stop", id })`. A stopped run cannot be resumed.
- Block on a result only when the next step needs it: `bg_wait({ id })`.

## 6. Collect and verify
For each report:
- Check its claims yourself: `git -C <wt> log --oneline origin/main..`,
  `git -C <wt> diff --stat origin/main..`, and rerun the narrowest relevant test if anything
  looks off.
- Relay to the user briefly: what changed, the commits, the test evidence, and risks.
- Follow-ups, accepted review fixes and CI fixes go to the **same** worker:
  `subagent({ action: "resume", id: "<worker run id>", message: "<follow-up brief>" })`. This
  starts a new child from the stored session, so it keeps the full earlier context, and it
  returns a new run id; use that id for the next round. If resume is refused, start a new
  `kit.worker` in the same worktree with the context it needs, and tell the user it is a fallback.
- If a launch, extension load or child setup fails, report the exact error and the
  worktree state. Do not quietly switch to another execution mode.
