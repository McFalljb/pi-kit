# pi-kit

An orchestrator-plus-workers setup for the [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent),
modelled on how Claude Code is used day to day: one main session that plans, delegates and
talks to you; background workers in their own git worktrees; a read-only reviewer on a
different model; guardrails around dangerous shell commands; background shells and monitors
that wake the session instead of sleep-and-poll loops.

It is a pi package: two agent definitions for [pi-subagents](https://github.com/nicobailon/pi-subagents),
six extensions, five skills, two prompts, global `AGENTS.md` rules, and a vetted list of
third-party packages with pinned versions.

## Quick start

Needs Node 22.19+ and the pi version pinned in `test/ci/package.json`.
```bash
git clone https://github.com/McFalljb/pi-kit ~/pi-kit
~/pi-kit/scripts/install.sh              # pinned packages, the kit, AGENTS.md merge (with backup)
~/pi-kit/test/smoke.sh                   # offline check against a mock model
pi                                       # then /login for your providers
```
To have an agent do the setup, point it at [SETUP.md](SETUP.md): it is written as step-by-step
instructions for an agent, including what to ask you and what never to touch.

## What you get

- **Sidebar.** In a terminal at least 120 columns wide, background subagents, todos and
  background shells, monitors and timers sit in a column on the right instead of in panels under
  the transcript. Narrower, or in regular `tuiMode`, a one-line footer summary stands in.
  `/sidebar` shows or hides it (or opens it as an overlay). Completed todos drop off at your next
  message, like rpiv-todo's own panel. In a pi-desk tab that draws panels, the same sections show there instead.
- **Workers and a reviewer.** `kit.worker` does delegated work in its own git worktree;
  `kit.reviewer` reviews read-only, ideally on another provider. The parent session plans and
  talks to you (`AGENTS.md`, skills `delegate` and `adversarial-review`).
- **Background shells.** `bash_bg`, `monitor` and `wake_later` wake the session when something
  happens instead of sleep-and-poll loops.
- **Guardrails.** Dangerous commands ask first; secret-shaped output is redacted.
- **GPT rules.** On OpenAI GPT models only, a short rule set cuts over-testing, over-exploring and
  long reports. Put your own version in `~/.pi/agent/rules/gpt.md` to override it. For
  gpt-6.1-sol, set thinking to `medium` (OpenAI's Codex ships it at `low`).
- **Pinned versions.** pi and the recommended packages are pinned and tested together; pi warns
  once at startup if yours are older or unpinned.

## Keeping it up to date

**Get the latest kit** (after changes land on `main`):
```bash
cd ~/pi-kit && git pull
scripts/install.sh --update     # move packages to the pins; point pi at this checkout
```
Then start a new `pi` session. `--update` backs up `~/.pi/agent/settings.json`
first. If your pi is older or newer than the pin, it prints the one command to install the
pinned pi; run it yourself.

What `--update` does not touch:
- **Your `~/.pi/agent/AGENTS.md`.** The installer only appends sections you don't have, so it
  never changes your wording. When the kit's `AGENTS.md` changes, compare and edit by hand:
  `git diff ORIG_HEAD -- AGENTS.md` after the pull shows what changed.
- **Your panel settings** (`~/.pi/agent/extensions/subagent/config.json`,
  `~/.config/rpiv-todo/config.json`) once they exist. The kit's defaults are in `config/`.
- **Optional packages**, unless you name them: `--update --optional pi-web-access` moves
  that one to its pin too.

**Check it worked:** `pi --version` matches the pi pin in `test/ci/package.json`, a new
session starts without a version warning, and `test/smoke.sh` passes offline.

**How versions move:** Dependabot opens a weekly PR that bumps `test/ci/package.json`; CI tests
the new versions, including contract tests for the internals the sidebar and GPT rules rely on.
Someone reads the changelogs, tries the PR on one machine with the sidebar test prompt, and
merges; then every machine runs the two commands above. A nightly canary runs the same tests
against the latest releases and opens a `canary` issue when they break. The full checklist and
the test prompt are in [GUIDE.md → Updating](GUIDE.md#updating).

**Undo:** each run leaves `settings.json.bak.<timestamp>` (and `AGENTS.md.bak.<timestamp>` when
it appends) in `~/.pi/agent/`; copy one back to restore. [SETUP.md → Uninstall](SETUP.md#uninstall)
removes the kit entirely.

## What's in it

| Path | What |
|---|---|
| `agents/worker.md`, `agents/reviewer.md` | `kit.worker` (writer, verifies before reporting) and `kit.reviewer` (read-only, adversarial) |
| `extensions/guardrails` | Confirms dangerous commands, redacts secret-shaped output; read-only mode |
| `extensions/shell` | `bash_bg`, `monitor`, `shell_stop`, `shell_list`, `wake_later`, `/shells` |
| `extensions/sidebar` | Right-hand column with background subagents, todos and shells instead of widgets under the transcript; `/sidebar` |
| `extensions/desk-bridge` | In a pi-desk tab: reports session, status (idle/working, waiting on a dialog, question, blockers) and the sidebar's sections as panels; answers prompt, reload and wait-idle requests; `inDesk()` |
| `extensions/desk` | In pi-desk's Home session (`PI_DESK_CONTROL_TOKEN`): `desk_state`, `desk_run` (any pi-desk command), `desk_prompt`, `desk_wait`, and short notices about other sessions |
| `extensions/notes` | Once the context is 75% full, reminds the session to update its session note before compaction |
| `extensions/model-rules` | On OpenAI GPT models only, adds `rules/gpt.md` (less testing, exploring and reporting) to the system prompt; `<agent-dir>/rules/gpt.md` overrides it |
| `extensions/versions` | At the start of an interactive session, warns once if pi or a recommended package is older than its pin or unpinned |
| `config/` | Compact panel defaults for pi-subagents and rpiv-todo; `install.sh` copies them only where no config exists |
| `skills/` | `delegate`, `adversarial-review`, `worktree-discipline`, `session-notes`, `handoff`, `desk` |
| `prompts/` | `/delegate`, `/review` |
| `AGENTS.md` | Global rules, labelled by role (everyone / parent / child) because workers load it too |
| `packages.json` | Recommended, optional and excluded third-party packages, with reasons; pins for the optional ones |
| `test/ci/package.json` | The pins CI tests and Dependabot updates: pi and the recommended packages |

## Claude Code → pi

| Claude Code | pi with this kit |
|---|---|
| `~/.claude/CLAUDE.md` | `~/.pi/agent/AGENTS.md` |
| Agent tool, background agents | pi-subagents `subagent({ agent: "kit.worker", async: true })` |
| SendMessage to an agent | `subagent({ action: "steer" \| "resume" })` |
| Bash `run_in_background` | `bash_bg` |
| Monitor | `monitor` |
| TaskStop | `shell_stop` |
| ScheduleWakeup | `wake_later` |
| TodoWrite | `todo` from `@juicesharp/rpiv-todo` |
| AskUserQuestion | `ask_user` from `pi-ask-user` |
| PreToolUse / PostToolUse hooks | Extension `tool_call` / `tool_result` events (the guardrails) |
| Permission prompts | Guardrail confirmations for dangerous commands only; no sandbox |
| Plugins, skills, slash commands | pi packages, the same `SKILL.md` format, prompt templates |

[GUIDE.md](GUIDE.md) has the full mapping, the daily workflow and the known limitations.

## Limits
The guardrails match shell text: they are a seatbelt, not a sandbox. Run pi in a container or
VM for real isolation. Background shells belong to the pi process and do not survive a restart:
they, any processes they left running in their group, and their output files go when the session
ends. See GUIDE.md for their limits (log cap, rejected regex shapes, monitor backlog).

MIT licensed.
