---
name: worktree-discipline
description: Rules and commands for isolating every change in its own git worktree, never touching the user's main checkout, uncommitted edits or stashes. Use whenever you or a worker will change code in a git repository.
---

# Worktree discipline

## Rules
- Each change gets its own worktree on its own branch. One writer per worktree.
- Never edit, reset, checkout, clean or stash in the user's main checkout. Their uncommitted
  edits are theirs.
- Never `git stash pop`, `drop` or `clear`. Never `git reset --hard`, `git clean -f` or
  `git checkout -- .` outside a worktree you created.
- Commit locally in the worktree. Pushing, opening PRs and merging need the user's go-ahead.

## Create
```bash
git -C <repo> status --short            # look, don't touch
git -C <repo> fetch origin
git -C <repo> worktree add -b <type>/<slug> <worktrees-dir>/<slug> origin/main
```
Put worktrees outside the main checkout (for example a sibling `<repo>-worktrees/` or the
scratch directory) so tools that scan the repo do not pick them up. Install dependencies inside
the worktree if the build needs them. Hand the path to a worker as the `subagent` call's `cwd`.

pi-subagents' `worktree: true` is different: it needs a clean source checkout, creates a
temporary worktree on its own branch, captures a patch, and removes the worktree and branch when
the patch was captured cleanly. Use it for throwaway experiments, not for a branch that becomes
a PR. Worktrees it keeps (dirty, failed) are removed with
`subagent({ action: "worktree.cleanup", options: { repo, mode: "plan" } })`, then `mode: "apply"`
with the reviewed `planId`; apply asks before removing.

## Inspect
```bash
git worktree list
git -C <wt> log --oneline origin/main..
git -C <wt> diff --stat origin/main..
```

## Clean up (only your own, after merge or abandonment, with the user's OK)
```bash
git -C <repo> worktree remove <wt>       # refuses if dirty: then ask, do not --force
git -C <repo> branch -d <branch>         # -d, not -D; -D needs the user's OK
```
