# Setting up pi with pi-kit (instructions for an agent)

You are setting up the pi coding agent with this kit on the user's machine. Follow the steps in
order. Each step says how to check it worked. Stop and tell the user if a check fails; do not
improvise around it.

**Hard rules for the whole setup**
- Never open, read, print or copy credential files: `auth.json` and anything else in the pi
  agent directory that holds keys or tokens, `.env` files, SSH keys, keychains. Name a file if you
  must refer to it.
- Never log in for the user. Model provider login (`/login` inside pi, or `pi auth`) is theirs.
- Back up any file you change outside this repo before changing it, and tell the user the path.
- Do not install anything that is not listed in `packages.json` unless the user asks.

## 1. Prerequisites
```bash
node --version          # needs v22.19.0 or later
pi --version            # the kit is tested with 1.2.0
npm --version
git --version
```
- Node missing or too old: tell the user; do not upgrade it yourself unless they ask.
- pi missing: `npm install -g --ignore-scripts @earendil-works/pi-coding-agent` (ask first if
  global npm installs need `sudo` on this machine; never run `sudo` yourself).

The pi config directory is `$PI_CODING_AGENT_DIR` if set, else `~/.pi/agent`. Call it
`<agent-dir>` below and use the variable form in commands.

## 2. Get the kit
Clone the repo to a stable path; pi loads it in place, so do not delete it later:
```bash
git clone https://github.com/McFalljb/pi-kit ~/pi-kit    # or where the user prefers
```

## 3. Install packages, the kit and the global rules
```bash
~/pi-kit/scripts/install.sh --dry-run     # shows what it would do; nothing changes
```
The dry run ends with an **AGENTS.md overlap report**: one line per kit section with its key
(`operating`, `communication`, `safety`, `background`, `parent`, `delegation`, `review`,
`child`, `notes`) and whether `<agent-dir>/AGENTS.md` already has it, has a section with the same
heading but other text, likely overlaps it (similar heading words at any heading level, or the
same key phrases), or lacks it; then a suggested `--sections` line. **Show the user the report
and ask which sections to add** before running for real:
```bash
~/pi-kit/scripts/install.sh --sections communication,background   # what the user picked
```
Without `--sections` the script appends only the sections reported as new and skips likely
overlaps (it says which), so an unattended run never duplicates rules. The script is
idempotent. It:
1. checks node and pi;
2. installs every **recommended** package in `packages.json` at its pinned version with
   `pi install` (a package already configured under the same name is left as it is and
   reported as "kept");
3. installs the kit itself (`pi install ~/pi-kit`);
4. merges the kit's `AGENTS.md` into `<agent-dir>/AGENTS.md`: copies it if there is none,
   otherwise backs the file up to `AGENTS.md.bak.<timestamp>` and appends the chosen (or new)
   `## ` sections. Existing text is never changed.

Then do these by hand, with the user:
- **Optional packages.** Show the user the `optional` list in `packages.json` with each `why`,
  and install only the ones they pick: `install.sh --optional pi-web-access,pi-mcp-adapter`.
  Mention the `excluded` list and why. The listed `skills` repos are optional too:
  `pi install git:github.com/mattpocock/skills@v1.3.2`, then narrow it in settings with the
  object form from `packages.json` (`"filter"`).
- **"kept" packages.** If the script kept an older version, tell the user the tested version
  and let them decide. An older `pi-subagents` than 0.84.0 has a known sandbox-escape advisory
  (GHSA-6v8j-6w28-2w8r): recommend upgrading.
- **AGENTS.md overlap.** The report catches likely overlaps, not every one. After the merge,
  show the user the appended headings and offer to remove duplicates; do not remove them on
  your own. If they skipped `notes` because they have their own notes rules, the kit's skills
  follow those rules (see skill `session-notes`).
- **Notes folder.** Ask where durable notes should live and replace `<notes-folder>` in
  `<agent-dir>/AGENTS.md` (section "Durable notes and handoffs"), or leave it for the project
  AGENTS.md or `PI_KIT_NOTES_DIR` to set.
- **Reviewer model.** `kit.reviewer` should run on a different model, ideally another provider,
  than the main session. Ask the user which, then
  `install.sh --reviewer-model <provider>/<model-id>` (backs up `settings.json`, then sets
  `subagents.agentOverrides["kit.reviewer"].model`). Without an answer, leave it unset and tell
  them. `pi --list-models` lists what is configured (it needs a provider logged in).
- **Login.** Tell the user to start `pi` and run `/login` (or configure `models.json`) for the
  providers they use. Do not do it for them.

Check: `pi list` shows the recommended packages and the kit.

## 4. Verify offline
These use a temporary agent dir and a scripted mock model: no credentials, no model calls.
```bash
~/pi-kit/test/typecheck.sh                     # "typecheck OK against <pi version>"
~/pi-kit/test/merge.sh                         # AGENTS.md merge; ends "fail=0"
~/pi-kit/test/smoke.sh                         # ends with no FAIL lines; exit code 0
PI_KIT_RECOMMENDED=1 ~/pi-kit/test/smoke.sh    # same, with the recommended set loaded
```
`typecheck.sh` installs TypeScript into a temp dir; `smoke.sh` installs the pinned
pi-subagents from npm into its temp dir (network needed for both) and takes several minutes.
Report the PASS/FAIL counts to the user. Any FAIL: stop and show the lines.

## 5. Manual check list (with the user, after login)
In a scratch git repo, start `pi` and check:
1. "list the subagents" shows `kit.worker` and `kit.reviewer` under package agents.
2. "run `sleep 5; echo done` in the background" uses `bash_bg`, the footer shows
   `1 shell · /shells` and a widget line above the editor shows it, and a notice with exit code 0 arrives about 5 s later without prompting.
3. `/shells` lists it and offers to stop a running task.
4. "run `git stash drop`" asks for confirmation (decline it).
5. "read .env" (create a dummy one first) is blocked.
6. "start a kit.worker in the background that lists the five largest files here" returns a run
   id at once and a report later.
7. `/todos` opens the todo overlay (if `@juicesharp/rpiv-todo` is installed).

Tell the user what passed, what failed, and anything you skipped.

## Uninstall
`pi remove <source>` for each package (`pi list` shows the sources), and restore
`<agent-dir>/AGENTS.md` and `settings.json` from their `.bak.<timestamp>` copies if wanted.
