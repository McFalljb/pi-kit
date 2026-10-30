# pi-kit

An orchestrator-plus-workers setup for the [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent),
modelled on how Claude Code is used day to day: one main session that plans, delegates and
talks to you; background workers in their own git worktrees; a read-only reviewer on a
different model; guardrails around dangerous shell commands; background shells and monitors
that wake the session instead of sleep-and-poll loops.

It is a pi package: two agent definitions for [pi-subagents](https://github.com/nicobailon/pi-subagents),
four extensions, five skills, two prompts, global `AGENTS.md` rules, and a vetted list of
third-party packages with pinned versions.

## Quick start

Needs Node 22.19+ and pi 1.2.0.
```bash
git clone https://github.com/McFalljb/pi-kit ~/pi-kit
~/pi-kit/scripts/install.sh              # pinned packages, the kit, AGENTS.md merge (with backup)
~/pi-kit/test/smoke.sh                   # offline check against a mock model
pi                                       # then /login for your providers
```
To have an agent do the setup, point it at [SETUP.md](SETUP.md): it is written as step-by-step
instructions for an agent, including what to ask you and what never to touch.

## What's in it

| Path | What |
|---|---|
| `agents/worker.md`, `agents/reviewer.md` | `kit.worker` (writer, verifies before reporting) and `kit.reviewer` (read-only, adversarial) |
| `extensions/guardrails` | Confirms dangerous commands, redacts secret-shaped output; read-only mode |
| `extensions/shell` | `bash_bg`, `monitor`, `shell_stop`, `shell_list`, `wake_later`, `/shells` |
| `extensions/notes` | Once the context is 75% full, reminds the session to update its session note before compaction |
| `extensions/model-rules` | On OpenAI GPT models only, adds `rules/gpt.md` (less testing, exploring and reporting) to the system prompt; `<agent-dir>/rules/gpt.md` overrides it |
| `config/` | Compact panel defaults for pi-subagents and rpiv-todo; `install.sh` copies them only where no config exists |
| `skills/` | `delegate`, `adversarial-review`, `worktree-discipline`, `session-notes`, `handoff` |
| `prompts/` | `/delegate`, `/review` |
| `AGENTS.md` | Global rules, labelled by role (everyone / parent / child) because workers load it too |
| `packages.json` | Recommended, optional and excluded third-party packages, pinned, with reasons |

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
