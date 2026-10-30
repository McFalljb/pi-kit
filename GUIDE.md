# pi orchestrator kit: guide

This kit reproduces an orchestrator-plus-workers workflow, normally run in Claude Code, in **pi**
(npm `@earendil-works/pi-coding-agent`; formerly `@mariozechner/pi-coding-agent`). Delegation
runs on the third-party extension **pi-subagents** (npm `pi-subagents`,
github.com/nicobailon/pi-subagents). The kit adds two agent definitions, guardrails, the process
skills and two prompts on top of it.

Tested offline (mock model) against pi **1.2.0** and pi-subagents **0.84.0**, alone and with the
recommended set in `packages.json` loaded. Setup steps are in [SETUP.md](SETUP.md).

## 1. Architecture

- **One interactive main session is the orchestrator.** The global `AGENTS.md` makes it decide,
  synthesize, talk briefly, and do small work and single-fact lookups itself.
- **Workers are pi-subagents children.** The parent calls the `subagent` tool with
  `agent: "kit.worker"`, a full brief as `task`, a git worktree as `cwd`, and `async: true`.
  The call returns a run id at once. The child runs in pi-subagents' detached runner process with
  fresh context. When it finishes, a `Background task completed: **kit.worker**` message with its
  report wakes the parent, like a Claude Code background-agent notification.
- **Follow-ups go to the same worker.** `action: "resume"` starts a new child from the finished
  run's stored session, so it keeps the full earlier context, and returns a new run id.
  `action: "steer"` sends guidance to a child that is still running.
- **Children can ask.** `kit.worker` and `kit.reviewer` have `contact_supervisor`; the parent
  answers with `subagent_supervisor({ action: "reply", replyTo, message })`.
- **Agent definitions** (`agents/worker.md`, `agents/reviewer.md`) use pi-subagents frontmatter.
  `package: kit` registers them as `kit.worker` and `kit.reviewer`, so they never shadow
  pi-subagents' builtin `worker` and `reviewer`. `package.json` exposes the folder through
  `pi.subagents.agents`. Both use `systemPromptMode: replace`, inherit the repo's and the global
  `AGENTS.md` (`inheritProjectContext`, `inheritGlobalContext`), get an explicit tool allowlist,
  and load the guardrails through `extensions`.
- **The reviewer is read-only and on another model.** `kit.reviewer` has no `edit` or `write`
  tool, and its guardrails entry point (`extensions/guardrails/readonly.ts`) blocks mutating bash.
  Its model is set per call (`model: "provider/id:high"`) or pinned once with
  `subagents.agentOverrides` in settings.
- **Guardrails are an extension** (`extensions/guardrails`). In the TUI, dangerous commands ask
  for confirmation. Without a UI (headless runs, background children) they are blocked and the
  child reports them. Whether a foreground child inside the TUI gets the dialog or a block is
  untested. Secret files and credential commands (`.env`, sops, aws sso, teleport, gcloud,
  kubectl) are not blocked: agents use them when a task needs them and follow the AGENTS.md rule
  never to expose secret values. Token-shaped output is redacted.
  These are pattern matches, not a sandbox.
- **Session notes have a compaction reminder** (`extensions/notes`). Skill `session-notes`
  keeps a running note (status block plus timeline). When the context passes 75% of the window,
  the extension adds one line to the context asking the session to rewrite the status block, at
  the end of a turn that ran tools, so the run's next request sees it. It never starts a turn and
  never lands after a final answer. It re-arms after each compaction.
  `PI_KIT_NOTES_REMIND_PERCENT` sets the threshold; `0` turns the reminder off. pi's `session_before_compact` hook fires too late for
  the model to write anything, hence the threshold. With a window under about 64k tokens pi's
  own compaction threshold can come first. Not loaded in pi-subagents children.
- **Background shells are an extension** (`extensions/shell`), modelled on Claude Code's
  background Bash, Monitor, TaskStop and ScheduleWakeup:
  - `bash_bg { command, cwd?, timeout? }` starts the command with `bash -c` in its own process
    group, writes stdout and stderr to `<tmpdir>/pi-shell-*/shN.log` (mode 0600) and returns
    the id and path at once. On exit a notice (exit code or signal, duration, last 10 lines,
    path) wakes the session. If processes it started are still running in its group (`sleep 30 &`,
    a server started with `&`), the notice says how many; `shell_stop <id>` kills them, and the
    task stays listed until they are gone. A task whose output file passes 1 GiB is killed with
    a notice saying so. `cwd` may not be inside the pi agent dir (`PI_CODING_AGENT_DIR`, default
    `~/.pi/agent`), `~/.ssh`, `~/.aws`, `~/.kube` or `~/.gnupg`.
  - `monitor { command | id, pattern?, cwd?, timeout? }` runs a command, or attaches to a
    running `bash_bg` task, and sends a notice for new lines matching `pattern` (a JavaScript
    regex; every line if omitted). Notices are batched about once a second, hold at most 20
    lines of at most 300 characters (the rest are counted), and stop after 50 notices. It ends
    when the command exits (one final notice with the total), on `shell_stop`, or at `timeout`
    (which kills a command the monitor started, and only ends the watch on an attached task).
    A task has at most one monitor; end it with `shell_stop <id> watch_only` to start another.
    Patterns that repeat a group which itself repeats (`(a+)+`, `(\w+\s?)+$`) are rejected.
    Matching runs in a worker thread with a 1 s budget per batch of lines, since any regex can
    backtrack for minutes on one line (`.*.*x` takes over 10 s on 4 KB): a pattern that runs out
    ends the watch with a notice (and stops a command the monitor started). Only the first
    4096 characters of a line are matched. When the unread output passes 8 MB the monitor skips
    to the newest output and reports how many bytes it skipped.
  - `shell_stop { id, watch_only? }` ends the monitor first (its undelivered lines come back in
    the result), then kills the whole process group (SIGTERM, SIGKILL after 2 s) and sends no
    exit notice; `watch_only` ends only the monitor. On a task that has exited it kills the
    processes left in its group. It also cancels a timer. A group known to be empty is never
    signalled again, since its id may by then belong to an unrelated process.
  - `wake_later { seconds, prompt }`: a one-shot timer, clamped to 60-3600 s (headless: at most
    1800 s, the drain window), that wakes the session with the prompt. For checks no shell
    command can observe.
  - `shell_list {}` and `/shells` list running and the last 20 finished tasks and pending
    timers; in the TUI, `/shells` then offers a picker that stops the chosen task (the same
    path as `shell_stop`). A widget above the editor (the sidebar instead, when it is loaded)
    shows one line per running shell (id,
    running time, `watching /pattern/ · N matches` when monitored, command), finished shell
    with processes left in its group, and pending timer (time left, prompt), at most 5 plus
    `+N more · /shells`; it never shows output lines. The footer counts them, e.g.
    `2 shells · 1 monitor · 1 timer · /shells`.
  - Every command goes through the guardrails' `checkCommand`, the same gate as `bash`
    (confirm with a UI, block without).
    Each output line is redacted like bash output before it is cut to length, so a cut cannot
    leave a token too short to be recognised; the lines of a private key block are dropped and
    reported once as `[private key block redacted]`. Read-only sessions do not register the
    tools, and the read-only guardrails block them by name.
  - All process groups, leftovers included, are killed and the `pi-shell-*` directory is removed
    when the session ends or reloads. Headless runs (`pi -p`, subagent children) wait at the
    end of a turn for the next notice or until every task and timer is done, up to 30 minutes,
    then kill what is left and send one notice listing it.
  - `kit.worker` has the tools; `kit.reviewer` does not.
- **A sidebar replaces the widgets under the transcript** (`extensions/sidebar`). It lists
  background subagents (pi-subagents: label, state, running time, current tool), background
  shells, monitors and timers (the rows of the shell widget) and todos (rpiv-todo: done/total,
  the one in progress highlighted). While it is loaded in the TUI, the rpiv-todo widget and the
  shell widget and footer count are hidden; turn off pi-subagents' own widget with
  `"subagents": {"asyncWidget": false}`.
  - Fullscreen `tuiMode` (pi's default): a 34-column column right of the transcript when the
    terminal is at least 120 columns wide. It scrolls on its own with the mouse wheel.
    `/sidebar` hides or shows it; when it is hidden or the terminal is narrower, the footer
    shows a summary instead, e.g. `2 subagents · todos 1/4 · 1 shell · /sidebar`. On a narrower
    terminal `/sidebar` opens the overlay below instead.
  - Regular `tuiMode`: the footer summary; `/sidebar` opens or closes the same rows as an overlay
    on the right that does not take keyboard focus. While the overlay is open, pi refuses to
    change `tuiMode` in `/settings` ("Close active overlays before changing TUI mode"): close it
    with `/sidebar` first.
  - Switching `tuiMode` in `/settings` or resizing the terminal re-lays it out on the next frame.
  - Limits: it shows only background subagents (foreground ones are in the transcript), and the
    subagent list updates only when pi-subagents reports a change (it does so only in sessions
    with a UI). A paused run is listed as paused and not counted as running. If something else
    closes the overlay, the next `/sidebar` only notices that; run it again to reopen. The widgets stay hidden while the extension is loaded, also with the column off
    (the footer summary stands in). With the column on, pi's layout renders the transcript once
    more per frame to measure it, which a very long transcript may feel.
- **Process lives in skills**, loaded on demand: `delegate`, `adversarial-review`,
  `worktree-discipline`, `session-notes` and `handoff`. Prompts `/delegate` and `/review` start
  the first two.
- **CI is the merge gate** (one rule in `AGENTS.md`): required checks green on the PR's latest
  commit, red checks fixed through the original worker, then the user approves the merge.

## 2. Claude Code → pi mapping

| Claude Code | pi / pi-subagents | In this kit |
|---|---|---|
| `~/.claude/CLAUDE.md` | `~/.pi/agent/AGENTS.md` (pi also reads `CLAUDE.md`) | `AGENTS.md`, role-aware because children load it too |
| Project `CLAUDE.md` | `AGENTS.md` / `CLAUDE.md` in the cwd and its parents | Unchanged; children get it via `inheritProjectContext: true` |
| Agent tool | pi-subagents `subagent` tool (`agent`, `task`, `cwd`, `model`, `async`) | `kit.worker`, `kit.reviewer` |
| `.claude/agents/*.md` | Agent Markdown with frontmatter: package (`pi.subagents.agents`), `~/.pi/agent/agents/`, `.pi/agents/` | `agents/*.md`; a user or project agent of the same runtime name wins |
| Background agent + completion notice | `async: true`; completion message wakes the parent | Used for all workers and reviewers |
| Background Bash (`run_in_background`) | No built-in equivalent | `bash_bg` (kit `extensions/shell`) |
| Monitor | No built-in equivalent | `monitor` |
| TaskStop | No built-in equivalent | `shell_stop` |
| ScheduleWakeup | No built-in equivalent | `wake_later` |
| TodoWrite | No built-in equivalent | `todo` and `/todos` from `@juicesharp/rpiv-todo` (recommended) |
| AskUserQuestion | No built-in equivalent | `ask_user` from `pi-ask-user` (recommended) |
| Plan mode | No built-in equivalent | Ask for a plan first, or `PI_KIT_READONLY=1 pi`; `@plannotator/pi-extension` is optional |
| SendMessage to an agent | `action: "steer"` (running), `action: "resume"` (finished) | Fixes go to the original worker with `resume` |
| Agent asks the parent | `contact_supervisor` / `subagent_supervisor` | In both agents' tools |
| Per-agent model and effort | Frontmatter `model`, `thinking`; per call `model: "provider/id:level"`; `subagents.agentOverrides` | Reviewer pinned in settings or per call |
| Status of background agents | `action: "status"` (`options.view: "transcript"`), FleetView, `/subagents-fleet` | Same |
| Worktree isolation (`isolation: worktree`) | `worktree: true`: temporary, needs a clean checkout, returns a patch | Kit creates its own worktrees and passes `cwd` (skill `worktree-discipline`) |
| Skills | Same `SKILL.md` format; `~/.pi/agent/skills`, `.pi/skills`, packages | 5 skills; force one with `/skill:name` |
| Slash commands | Prompt templates (`prompts/*.md` → `/name`) | `/delegate`, `/review` |
| Hooks (PreToolUse, PostToolUse) | Extension events `tool_call` (block) and `tool_result` (rewrite) | Guardrails |
| Permission modes, allow/deny | None; tools run freely. Agent `tools` allowlists | Guardrails; reviewer allowlist without edit/write |
| Plugins | pi packages: `pi install npm:… / git:… / <path>` | `package.json` with a `pi` manifest |
| `--resume`, `--continue`, `/compact` | Same flags, `/resume`, `/tree`, `/fork`, `/compact` | n/a |
| MCP | Built in; children need `mcp:` entries in `tools` and must run async | Not used by the kit agents; `pi-mcp-adapter` (optional) for lazy docs servers such as Context7 |
| Memory / notes | No built-in memory | `session-notes` skill |
| Handoff between sessions | `--resume`, session JSONL files | `handoff` skill (write one, or pick up from a handoff or another session's JSONL) |

## 3. Setup

[SETUP.md](SETUP.md) is the step-by-step version, written so an agent can follow it.
`scripts/install.sh` does the idempotent parts: pinned packages from `packages.json`, the kit,
and the `AGENTS.md` merge (backup, then append the `## ` sections the file lacks).

**Packages.** `packages.json` lists what was vetted on the date it names (npm metadata, README,
source read from the tarball, never run):
- *recommended*: `pi-subagents`, `pi-ask-user`, `@ff-labs/pi-fff`, `@juicesharp/rpiv-todo`;
- *optional*, each with its caveat: `pi-web-access`, `pi-mcp-adapter`, `pi-intercom`,
  `pi-autoresearch`, `@plannotator/pi-extension`, and two skill repos;
- *excluded*, with the reason: packages that change model routing or auth or bridge to another
  vendor (`pi-claude-bridge`, `pi-cursor-sdk`), computer use, and packages that overlap the
  kit's own tools or guardrails.

pi's package installer runs npm lifecycle scripts; the recommended set has none.

**AGENTS.md.** The kit's sections are labelled by role because children load the global file
too (`inheritGlobalContext: true`). Sections marked *(kit)* are kit mechanics; the rest are
general rules you may already have under other headings. The installer appends any section
whose heading is missing, so if yours covers the same ground under another name, remove the
duplicate by hand.

**Models.** The orchestrator uses `defaultProvider`, `defaultModel` and `defaultThinkingLevel`.
Pin the reviewer to another provider with `install.sh --reviewer-model provider/id`, or by hand:
```json
"subagents": { "agentOverrides": { "kit.reviewer": { "model": "provider/id" } } }
```
`kit.worker` uses the session's model unless you pin it the same way.

`PI_KIT_READONLY=1 pi` starts a session whose guardrails are read-only (no edits, no mutating
bash, no background shells), which is handy for a look-only session.

## 4. Daily workflow

1. Describe the goal. The main session splits it and shows one line per worker (worktree and
   branch), or type `/delegate <task>`.
2. It creates a worktree per code change, then launches each worker in the same turn:
   `subagent({ agent: "kit.worker", task: <brief>, cwd: <worktree>, async: true })`. It tells you
   the run ids and keeps talking to you.
3. A worker that needs a decision asks through `contact_supervisor`; the parent answers within
   scope or asks you. To redirect a running worker: `action: "steer"`.
4. Each completion wakes the parent. It checks the commits and diffs in the worktree, reruns the
   narrowest test if anything looks off, and relays a short summary.
5. For a non-trivial change, `/review` (or "adversarial review") starts `kit.reviewer` on a
   different model against the exact head SHA; two reviewers with distinct angles for
   consequential changes. The parent verifies each finding, sends accepted fixes to the original
   worker with `action: "resume"`, and stops after 2 rounds.
6. Push and open the PR (with your go-ahead), then wait for the required
   checks on the head SHA (`gh pr checks <n> --required --watch`), read failures with
   `gh run view <run-id> --log-failed`, send real failures back to the worker (allowed to push
   its branch), re-run a flake once and call it a flake. Green on the exact SHA, then the parent
   asks you, then `gh pr merge --match-head-commit <SHA>`.
7. The parent updates notes at milestones (`session-notes`).

## 5. Limitations and workarounds

- **No sandbox.** pi runs tools with your OS permissions. The guardrails match shell text;
  aliases, scripts, `eval` or encoding bypass them, and commands you type with `!` are not gated.
  For real isolation run pi in a container or VM (pi `docs/containerization.md`), or wrap
  background children with pi-subagents' `runnerLaunchers`.
- **Read-only reviewer is best-effort.** It has no edit/write tools (a `write` call fails with
  "Tool write not found"), but its bash is limited only by patterns. A test suite it runs can
  still write files.
- **Children load only the extensions their agent lists.** The kit's agents list only the kit's
  own (guardrails; the worker also gets the shell tools), so other installed extensions (web search, MCP adapters, custom tools) are not in
  kit children. Foreground children never load ambient extensions anyway. Add what a worker needs
  to its `extensions` (or `subagentOnlyExtensions`) and `tools`; MCP tools need async children.
- **Notices reach only the launching process.** Background runs survive quitting pi, but the
  completion notice goes only to the pi process that started the run. After a restart, read
  results with `subagent({ action: "status", id })`. A headless `pi -p` parent waits for its
  background runs at the end of its turn (auto-drain, with its own deadline).
- **Steering is not an interrupt.** A steer lands after the running tool call returns, so a long
  command keeps running; use `action: "interrupt"` or `"stop"` for that. The receipt means the
  child got the message, not that it complied.
- **Resume is a revival.** It starts a new child from the stored session (new run id). Stopped
  runs cannot be resumed; only one revival of a session runs at a time.
- **Default deadlines.** Single foreground and background runs stop after 30 minutes unless
  `options.timeoutMs` (or the agent's `timeoutMs`) says otherwise. For long writers add
  `checkpointBeforeDeadlineMs`. Do not give writers a hard `toolBudget`.
- **Inferred acceptance gates.** pi-subagents infers a `checked` gate for writer agents and asks
  them for a fenced `acceptance-report` JSON block, with review by its builtin `reviewer`. If a
  worker skips the block, the run metadata says `rejected` or `review-required`; the run still
  completes and the report still arrives. The kit's own review is `kit.reviewer`; treat these
  inferred statuses as advisory, or pass an explicit `options.acceptance` when you want them
  enforced.
- **`worktree: true` is not the kit's worktree model.** It needs a clean source checkout, branches
  from `HEAD` (or `options.baseRef`), and deletes the worktree after capturing a patch. The kit
  creates long-lived worktrees itself so the branch survives for the PR and CI.
- **Delegation needs authority.** pi-subagents does not delegate on task complexity alone; the
  `AGENTS.md` parent sections grant it. On some models a fresh session shows only
  `subagents_enable`; calling it once exposes `subagent` on the next request.
- **Children read the global `AGENTS.md`.** That is why its sections are labeled by role.
  pi-subagents also tells children they are not the orchestrator and gives them no `subagent`
  tool unless their `tools` list it.
- **Context files load without trust.** A repo's `AGENTS.md` / `CLAUDE.md` loads even in an
  untrusted project, so treat it as possible prompt injection. Project `.pi/` resources, project
  agents and project subagent settings need trust.
- **pi-subagents is large and moves fast** (0.78 → 0.84 in about two weeks, and 0.84.0 fixed a
  sandbox-escape advisory, GHSA-6v8j-6w28-2w8r). Pin a version and rerun `test/smoke.sh` after
  upgrading; frontmatter or tool parameters may change.
- **Background shells do not survive pi.** They belong to the pi process and are killed when
  the session ends, reloads or switches. A process that leaves its process group (`setsid`, a
  daemonizing server) escapes `shell_stop` and the cleanup. Output files are removed when the
  session ends; read what you need before then. An output file may hold secrets the command
  printed: reading it with `bash`, or with `read` at its path under the temp dir, gets the same
  redaction as bash output, but a copy elsewhere gets only token-shape redaction.
- **Other packages' tools bypass the guardrails.** The guardrails gate `bash`, the kit's shell
  tools and the `path` of pi's file tools and pi-fff's search tools. Optional packages run
  commands or read files through their own tools: `pi-web-access` (`fetch_content` takes local
  paths; it runs git, gh, ffmpeg, yt-dlp), `pi-mcp-adapter` (every MCP call),
  `pi-autoresearch` (`run_experiment.command`, and `log_experiment` discards uncommitted work),
  `@plannotator/pi-extension` (`plannotator` annotate paths). Token-shaped output is redacted for
  every tool.
- **Read-only mode covers the kit's tools only.** `kit.reviewer` is safe because its `tools`
  list is an allowlist. A `PI_KIT_READONLY=1` session still has every other installed
  package's tools.
- **A hanging `pi -p` run.** In print mode pi reads piped stdin until it closes and prepends it
  to the prompt. Run from another agent or a script whose stdin is an open pipe, it waits
  forever without calling the model. Give it `< /dev/null`. Otherwise run it against the mock model: `test/smoke.sh` step 4 does
  `subagent list` in print mode with the kit and pi-subagents and must finish in seconds (it
  also does with pi-intercom, pi-web-access, pi-claude-bridge and pi-cursor-sdk loaded). If the
  mock run is fast, the hang is in the model provider, not the kit: provider extensions such as
  `pi-claude-bridge` run their own agent process and hand each tool call across to pi. Retry with
  a built-in provider to confirm, and use the provider's debug log (`CLAUDE_BRIDGE_DEBUG=1` for
  the bridge) to see where it waits.
- **No plan mode.** pi has none built in; ask for a plan before edits, or use read-only mode.
  `@plannotator/pi-extension` is optional (heavy, opens a browser and a local server).
- **No CI-side enforcement.** The CI gate is an `AGENTS.md` rule the parent follows plus a guardrail that
  asks before `gh pr merge`; branch protection on the host is what actually enforces it.

## 6. Sources

- pi: https://www.npmjs.com/package/@earendil-works/pi-coding-agent, https://github.com/earendil-works/pi
  (packages/coding-agent), https://pi.dev/docs. Installed docs: `docs/configuration.md`,
  `skills.md`, `prompt-templates.md`, `extensions.md`, `packages.md`, `security.md`,
  `settings.md`, `models.md`, `cli.md`
- pi-subagents: https://github.com/nicobailon/pi-subagents, https://www.npmjs.com/package/pi-subagents.
  Installed docs (`node_modules/pi-subagents/docs/`): `agents.md` (frontmatter, discovery,
  overrides, extension loading), `tool-reference.md` (parameters, status/steer/resume/stop,
  acceptance gates), `workflows.md` (orchestration pattern, worktree isolation, supervisor,
  recursion guard), `configuration.md` (`timeoutMs`, `waitTool`, concurrency), `models.md`
- GitHub CLI: `gh pr checks --help` (`--required`, `--watch`, `--fail-fast`, `bucket`),
  `gh run view --log-failed`, `gh run rerun --failed`, `gh pr merge --match-head-commit`
- Agent Skills spec: https://agentskills.io/specification
