---
description: Plan and launch parallel background kit.worker subagents for a task
argument-hint: "<task>"
---
Load skill `delegate` and follow it for this task: $@

First list the independent pieces you would hand to workers (one line each, with worktree and branch). Create the worktrees, then launch each with `subagent({ agent: "kit.worker", task, cwd, async: true })` in the same turn. Tell me in one or two lines what is running, with the run ids.
