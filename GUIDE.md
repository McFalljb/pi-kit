# pi orchestrator kit: guide

This kit reproduces an orchestrator-plus-workers workflow, normally run in Claude Code, in **pi**
(npm `@earendil-works/pi-coding-agent`; formerly `@mariozechner/pi-coding-agent`). Delegation
runs on the third-party extension **pi-subagents** (npm `pi-subagents`,
github.com/nicobailon/pi-subagents). The kit adds two agent definitions, guardrails, the process
skills and two prompts on top of it.

Tested offline (mock model) against pi **1.2.0** and pi-subagents **0.78.0**. npm's latest
pi-subagents on 2026-10-29 is 0.84.0; it has not been tested with the kit.

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
  untested. Reads of secret files are blocked and secret-shaped output is redacted.
  These are pattern matches, not a sandbox.
- **Process lives in skills**, loaded on demand: `delegate`, `adversarial-review`,
  `worktree-discipline` and `session-notes`. Prompts `/delegate` and `/review` start the first two.
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
| MCP | Built in; children need `mcp:` entries in `tools` and must run async | Not used by the kit agents |
| Memory / notes | No built-in memory | `session-notes` skill |

## 3. Setup

1. **Install pi** (Node 22.19 or later): `npm install -g --ignore-scripts @earendil-works/pi-coding-agent`
   or `curl -fsSL https://pi.dev/install.sh | sh`. Connect a provider with `/login` or
   `~/.pi/agent/models.json`.
2. **Install pi-subagents** if it is not already: `pi install npm:pi-subagents@0.78.0` (the
   tested version). An existing install stays as it is, including its prompt filters.
3. **Put the kit at a stable path**, for example `~/pi-kit`. pi loads local packages in place and
   never modifies them.
4. **Verify offline.** No credentials; a mock model and a temporary `PI_CODING_AGENT_DIR`:
   ```bash
   ~/pi-kit/test/typecheck.sh    # tsc of the guardrails against the installed pi
   ~/pi-kit/test/smoke.sh        # 34 checks; installs pi-subagents@0.78.0 from npm into the temp dir
   PI_SUBAGENTS_DIR=~/.pi/agent/npm/node_modules/pi-subagents ~/pi-kit/test/smoke.sh   # or use your copy, read-only
   ```
5. **Install the kit:** `pi install ~/pi-kit`. This adds a `packages` entry to
   `~/.pi/agent/settings.json`. Check with `pi list`, then in pi `subagent({ action: "list" })`
   (or ask "list the subagents"): `kit.worker` and `kit.reviewer` appear under package agents.
6. **Global rules.** Back up `~/.pi/agent/AGENTS.md`. With no file, copy the kit's `AGENTS.md`.
   With an existing file, merge section by section:

   | Kit section | Typical existing section | What to do |
   |---|---|---|
   | Operating rules | Operating Rules | Keep yours |
   | Safety | Standing Authorization → Safety and authority | Keep yours; add the kit bullets yours lacks (secrets, personal info, merge to `main`, stashes, do not work around a guardrail) |
   | Parent session | Standing Authorization → Parent session | Keep yours (same policy: orchestrate within scope, review by risk, fixes to the original worker) |
   | Delegation mechanics *(kit)* | none | Append: it names the `subagent` calls, `kit.*` agents, worktrees and `async` |
   | Review and merge gate *(kit)* | Partly in Parent session (review depth, two reviewers) | Append: adds the 2-round cap, the different-model rule and the CI gate |
   | Child sessions | Standing Authorization → Child sessions | Keep yours |
   | Durable notes | Your notes section | Keep yours; the kit's points at the `session-notes` skill |

   The kit's agents set `inheritGlobalContext: true`, so children read this file too. Keep parent
   rules labeled as parent-only, as the kit's file does.
7. **Pick models.** The orchestrator uses `defaultProvider`, `defaultModel` and
   `defaultThinkingLevel`. Pin the reviewer to another provider:
   ```json
   "subagents": { "agentOverrides": { "kit.reviewer": { "model": "provider/id" } } }
   ```
   `kit.worker` uses the session's model unless you pin it the same way. List models with
   `subagent({ action: "models" })` or `pi --list-models`.
8. **Try it** in a repo: `pi`, then "start a kit.worker in the background that lists the five
   largest files in this repo". The run shows in FleetView; the report arrives on its own.

`PI_KIT_READONLY=1 pi` starts a session whose guardrails are read-only (no edits, no mutating
bash), which is handy for a look-only session.

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
- **Children load only the extensions their agent lists.** The kit's agents list only the
  guardrails, so other installed extensions (web search, MCP adapters, custom tools) are not in
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
- **pi-subagents is large and moves fast** (0.78 → 0.84 in about two weeks). Pin a version and
  rerun `test/smoke.sh` after upgrading; frontmatter or tool parameters may change.
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
