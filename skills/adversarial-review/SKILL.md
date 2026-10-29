---
name: adversarial-review
description: Get a fresh-context, read-only adversarial review (agent kit.reviewer) of a non-trivial change from a different model, ideally a different provider, before merge. Capped at 2 rounds; verify every finding yourself. Use before merging non-trivial fixes or when the user asks for a second-model or parallel review. Main session only.
---

# Adversarial review by a second model

## 1. Choose the depth by risk
- Routine, reversible docs or config cleanup: the worker's checks plus your own inspection. No
  reviewer needed.
- Non-trivial behavior change: **one** `kit.reviewer` on a different model from the author's.
- Consequential (security, concurrency, data integrity, cross-component contracts) or the user
  asks for parallel review: **two** independent reviewers, launched together with distinct risk
  angles. At least one runs on a different provider. Neither sees the other's findings.
- Several small PRs on one feature: one review of the combined change, not one per PR.
- Before any review: the change's tests, lint and type checks pass (CI green, or the repo's local
  checks). The reviewer looks for what tests can't catch, not for what a test run would show.

## 2. Pin the target
```bash
git -C <wt> fetch origin
git -C <wt> merge-base origin/main HEAD    # BASE
git -C <wt> rev-parse HEAD                 # HEAD: the review covers this commit only
```

## 3. Pick the reviewer model
A different model from the one that wrote the change, ideally a different provider. List the
options with `subagent({ action: "models" })` or `pi --list-models`. Pass it per call
(`model: "provider/id:high"`), or pin it once in settings:
`"subagents": { "agentOverrides": { "kit.reviewer": { "model": "provider/id" } } }`. If no other
provider is configured, say so to the user instead of quietly using the author's model.

## 4. Brief
```markdown
# Adversarial review of <short change name> at <HEAD>

## Goal of the change
<one paragraph: the requirement it serves>

## Scope
`git diff <BASE>..<HEAD>` in this worktree, plus these related files: <paths>.
Angle: <e.g. correctness and edge cases | concurrency and data integrity | security>.
Attack these first: <the 3-5 riskiest things about this change>. Don't audit untouched code.

## Validation evidence so far
<tests the worker ran, with pass/fail; CI state if any>

## Rules
Read-only. Running the existing test suite is <allowed: command | not allowed>.

## Output
Your agent prompt's format: findings most severe first with file:line, failure scenario,
severity, confidence; then the reviewed SHA and VERDICT.
```

## 5. Run it
```ts
subagent({ agent: "kit.reviewer", task: "<brief>", cwd: "<wt>", model: "<provider/id:high>", async: true })
```
For two reviewers, make both calls in the same turn, each with its own angle (and model). Keep
working; each review arrives as a "Background task completed" message. The reviewer has no
edit or write tools, and its bash is limited to read-only commands by the read-only guardrails.

## 6. Verify every finding
Read the code yourself and mark each finding **confirmed**, **plausible** (needs a test to
settle) or **rejected** (with the reason). Never relay or act on an unverified claim. Report to
the user: reviewed SHA, reviewer model(s), verdicts, confirmed findings, and what you rejected
and why.

## 7. Fix and re-review (cap: 2 rounds)
- Send accepted fixes to the **original** worker, with a failing test for each finding first:
  `subagent({ action: "resume", id: "<worker run id>", message: "<accepted findings and the fix to make>" })`.
- Round 2 covers only the fix diff and the findings still open: a fresh `kit.reviewer` with the
  new HEAD, the round-1 findings and how each was resolved. To keep the same reviewer's context,
  `subagent({ action: "resume", id: "<reviewer run id>", message })` works too.
- Usually stop after round 2, and list leftover polish for the user instead of chasing it. If
  real issues keep coming after two rounds, consider whether a simpler implementation would
  remove them, and raise that with the user alongside the fixes.
- Then wait for CI to go green before asking to merge.
