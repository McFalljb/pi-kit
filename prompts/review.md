---
description: Adversarial second-model review (kit.reviewer) of the current change before merge
argument-hint: "[worktree or SHA] [reviewer provider/model]"
---
Load skill `adversarial-review` and run it on ${1:-the change we just finished}. Reviewer model: ${2:-pick one from a different provider than the author's and tell me which}. Launch with `subagent({ agent: "kit.reviewer", task, cwd, model, async: true })`. Verify every finding before reporting it.
