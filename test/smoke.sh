#!/usr/bin/env bash
# Offline smoke test: isolated PI_CODING_AGENT_DIR, a scripted mock model, no real credentials.
# Loads the kit together with pi-subagents, as a real install would.
#
# Usage: test/smoke.sh   (needs pi, node and npm on PATH)
# The recommended packages load in place from test/ci/node_modules when it has them all at their
# pins (after `npm ci --ignore-scripts --prefix test/ci`); otherwise they come from npm.
#   PI_SUBAGENTS_DIR=<path>   use an already installed pi-subagents package in place (read-only)
#   PI_SUBAGENTS_VERSION=x.y.z  install this pi-subagents version from npm instead
#   PI_KIT_RECOMMENDED=1      also load the rest of the recommended set at its pins (no scripts)
set -uo pipefail
KIT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d "${TMPDIR:-/tmp}/pi-kit-smoke.XXXXXX")"
PORT="${PI_KIT_MOCK_PORT:-18555}"
# Everything the run writes (agent dir, pi-subagents run state, child sessions) stays under $T.
export PI_CODING_AGENT_DIR="$T/agent" PI_OFFLINE=1 PI_SUBAGENTS_TEMP_ROOT="$T/subagents-tmp" TMPDIR="$T/tmp"
mkdir -p "$PI_CODING_AGENT_DIR" "$T/work" "$TMPDIR"

PINS="$KIT/test/ci/package.json" NM="$KIT/test/ci/node_modules"
# Every recommended package installed in test/ci at its pin: "1", else "".
FROM_CI="$(node -p 'const fs=require("fs"),v=require(process.argv[2]).dependencies;require(process.argv[1]).recommended.every(p=>{try{return JSON.parse(fs.readFileSync(`${process.argv[3]}/${p.name}/package.json`,"utf8")).version===v[p.name]}catch{return false}})?"1":""' "$KIT/packages.json" "$PINS" "$NM")"
if [ -n "${PI_SUBAGENTS_DIR:-}" ]; then
	SUBAGENTS="$PI_SUBAGENTS_DIR"
elif [ -n "$FROM_CI" ] && [ -z "${PI_SUBAGENTS_VERSION:-}" ]; then
	SUBAGENTS="$NM/pi-subagents"
else
	V="${PI_SUBAGENTS_VERSION:-$(node -p 'require(process.argv[1]).dependencies["pi-subagents"]' "$KIT/test/ci/package.json")}"
	npm install --prefix "$PI_CODING_AGENT_DIR/npm" --no-audit --no-fund --silent "pi-subagents@$V" >/dev/null 2>"$T/npm.err" \
		|| { echo "FAIL could not install pi-subagents@$V from npm (see $T/npm.err); set PI_SUBAGENTS_DIR"; exit 2; }
	SUBAGENTS="$PI_CODING_AGENT_DIR/npm/node_modules/pi-subagents"
fi
echo "pi $(pi --version), pi-subagents $(node -p 'require(process.argv[1]).version' "$SUBAGENTS/package.json") ($SUBAGENTS)"
EXTRA=""
if [ "${PI_KIT_RECOMMENDED:-}" = 1 ]; then
	SPECS="$(node -p 'const v=require(process.argv[2]).dependencies;require(process.argv[1]).recommended.filter(p=>p.name!=="pi-subagents").map(p=>`${p.name}@${v[p.name]}`).join(" ")' "$KIT/packages.json" "$PINS")"
	DIR="$NM"
	if [ -z "$FROM_CI" ]; then
		DIR="$T/extra/node_modules"
		# shellcheck disable=SC2086
		npm install --prefix "$T/extra" --no-audit --no-fund --silent --ignore-scripts $SPECS >/dev/null 2>"$T/npm-extra.err" \
			|| { echo "FAIL could not install the recommended set (see $T/npm-extra.err)"; exit 2; }
	fi
	for spec in $SPECS; do EXTRA="$EXTRA,\"$DIR/${spec%@*}\""; done
	echo "with recommended: $SPECS (from $DIR)"
fi

# Two mock providers on the same server, so the reviewer's model pin can be observed.
cat > "$PI_CODING_AGENT_DIR/models.json" <<JSON
{"providers":{
 "mock":{"baseUrl":"http://127.0.0.1:$PORT/v1","api":"openai-completions","apiKey":"mock","models":[{"id":"mock-1"}]},
 "mockb":{"baseUrl":"http://127.0.0.1:$PORT/v1","api":"openai-completions","apiKey":"mock","models":[{"id":"mock-b"}]}}}
JSON
cat > "$PI_CODING_AGENT_DIR/settings.json" <<JSON
{"defaultProvider":"mock","defaultModel":"mock-1","defaultThinkingLevel":"off","enableInstallTelemetry":false,
 "packages":["$SUBAGENTS","$KIT"$EXTRA],
 "subagents":{"agentOverrides":{"kit.reviewer":{"model":"mockb/mock-b"}}}}
JSON
echo "FAKE_SECRET=do-not-read" > "$T/work/.env"
git -C "$T/work" init -q

node "$KIT/test/mock-llm.mjs" "$PORT" "$T/mock.log" & MOCK=$!
trap 'kill $MOCK 2>/dev/null' EXIT
sleep 0.5
touch "$T/mock.log"
cd "$T/work"
fail=0
if node --test "$KIT/test/unit.test.ts" > "$T/unit.out" 2>&1; then echo "PASS unit tests ($(grep -c '^✔' "$T/unit.out"))"; else echo "FAIL unit tests (see $T/unit.out)"; fail=1; fi
check() { if grep -q -- "$2" "$3"; then echo "PASS $1"; else echo "FAIL $1 (no '$2' in $3)"; fail=1; fi; }
nocheck() { if grep -q -- "$2" "$3"; then echo "FAIL $1 (found '$2' in $3)"; fail=1; else echo "PASS $1"; fi; }
exists() { if [ -e "$2" ]; then echo "PASS $1"; else echo "FAIL $1 ($2 missing)"; fail=1; fi; }
absent() { if [ -e "$2" ]; then echo "FAIL $1 ($2 exists)"; fail=1; else echo "PASS $1"; fi; }

step() { printf '@@ {"name":"%s","arguments":%s}\n' "$1" "$2"; }
json() { node -e 'console.log(JSON.stringify(process.argv[1]))' "$1"; }
# run <name> <prompt>: one headless parent turn (plus pi-subagents' auto-drain of background work).
# The mock log lines of this run are copied to $T/<name>.log.
run() {
	local before start; before="$(wc -l < "$T/mock.log")" start="$(date +%s)"
	perl -e 'alarm shift; exec @ARGV' 240 pi -p --no-session "$2" > "$T/$1.out" 2> "$T/$1.err" < /dev/null
	echo "$?" > "$T/$1.exit"
	echo "$(( $(date +%s) - start ))" > "$T/$1.secs"
	tail -n +"$((before + 1))" "$T/mock.log" > "$T/$1.log"
}
# sub <args-json>: one parent step that calls the subagent tool.
sub() { step subagent "$1"; }

# 1. guardrails in a headless (no-UI) parent
run p1 "Steps:
$(step bash '{"command":"git stash drop"}'; step bash '{"command":"rm -rf build"}'; step bash '{"command":"kubectl delete pod x"}'; step bash '{"command":"echo token ghp_abcdefghijklmnopqrstuvwxyz0123456789AB password=supersecretvalue123"}'; step bash '{"command":"echo hello-safe"}')"
check "stash drop blocked" "Needs user approval (drops or pops a stash)" "$T/p1.log"
check "rm -rf blocked" "recursive force delete" "$T/p1.log"
check "kubectl delete blocked" "changes a cluster" "$T/p1.log"
nocheck ".env content never sent" "do-not-read" "$T/mock.log"
nocheck "github token redacted" '"role":"tool","text":"[^"]*ghp_abcdef' "$T/p1.log"
check "token replaced in tool output" '"role":"tool","text":"token \[REDACTED\]' "$T/p1.log"
check "assignment redacted" "password=\[REDACTED\]" "$T/p1.log"
check "safe command runs" "FINAL: hello-safe" "$T/p1.out"
head -1 "$T/mock.log.system" > "$T/p1.system"
check "system prompt lists the wake_later snippet" "wake_later: Wake this session once later" "$T/p1.system"
check "system prompt has a shell tool guideline" "with bash_bg, not bash" "$T/p1.system"

# 2. common safe commands are not gated
run p2 "Steps:
$(step bash '{"command":"git status 2>&1 | head -1"}'; step bash '{"command":"grep -rn deploy . 2>/dev/null; true"}'; step bash '{"command":"echo x > notes.txt && rm notes.txt"}'; step bash '{"command":"ls -la"}'; step bash '{"command":"cat .env.example 2>/dev/null; true"}'; step bash '{"command":"echo git push origin feature/x"}')"
nocheck "no false-positive gates" "Needs user approval\|touches a secret\|looks like a secret" "$T/p2.log"

# 3. with a UI (RPC mode), dangerous commands ask: first declined, second approved
BEFORE="$(wc -l < "$T/mock.log")"
P3="Steps:
$(step bash '{"command":"git stash drop"}'; step bash '{"command":"git branch -D no-such-branch-xyz 2>&1; true"}')"
node "$KIT/test/rpc-confirm.mjs" "$P3" > "$T/p3.out" 2> "$T/p3.err"
tail -n +"$((BEFORE + 1))" "$T/mock.log" > "$T/p3.log"
check "confirm asked for stash drop" "git stash drop => false" "$T/p3.out"
check "confirm asked for branch -D" "git branch -D no-such-branch-xyz 2>&1; true => true" "$T/p3.out"
check "declined command blocked" "User declined: drops or pops a stash" "$T/p3.log"
check "approved command ran" "not found\|branch 'no-such-branch-xyz'" "$T/p3.log"

# 4. pi-subagents discovers the kit's agent definitions
run p4 "Steps:
$(sub '{"action":"list"}')"
check "kit.worker listed as package agent" "kit.worker (pi-kit" "$T/p4.out"
check "kit.reviewer listed as package agent" "kit.reviewer (pi-kit" "$T/p4.out"
nocheck "no agent load warnings" "kit\.\(worker\|reviewer\).*\(invalid\|error\|warn\)" "$T/p4.err"
if [ "$(cat "$T/p4.exit")" = 0 ] && [ "$(cat "$T/p4.secs")" -lt 60 ]; then echo "PASS print-mode subagent list exits (code 0, $(cat "$T/p4.secs")s)"; else echo "FAIL print-mode subagent list: exit $(cat "$T/p4.exit") after $(cat "$T/p4.secs")s"; fail=1; fi

# 5. foreground kit.worker: runs in cwd, guardrails apply inside the child
TASK="$(json "Goal: smoke
$(step bash '{"command":"echo fg-child-ran > fg.txt && cat fg.txt"}'; step bash '{"command":"git stash drop"}')")"
run p5 "Steps:
$(sub "{\"agent\":\"kit.worker\",\"task\":$TASK,\"async\":false}")"
check "fg worker wrote in its cwd" "fg-child-ran" "$T/work/fg.txt"
check "fg worker: dangerous command blocked" "Needs user approval (drops or pops a stash)" "$T/p5.log"

# 6. foreground kit.reviewer: read-only, and the settings agentOverrides model pin applies
TASK="$(json "Review: smoke
$(step bash '{"command":"touch reviewer-was-here"}'; step write '{"path":"reviewer.txt","content":"x"}'; step bash '{"command":"git status --short"}')")"
run p6 "Steps:
$(sub "{\"agent\":\"kit.reviewer\",\"task\":$TASK,\"async\":false}")"
check "fg reviewer: mutating bash blocked" "Read-only session" "$T/p6.log"
absent "fg reviewer left no touch file" "$T/work/reviewer-was-here"
absent "fg reviewer has no write tool" "$T/work/reviewer.txt"
check "reviewer ran on the pinned model" '"model":"mock-b"' "$T/p6.log"

# 7. background kit.worker: completion notice reaches the parent; guardrails apply in the child
TASK="$(json "Goal: smoke
$(step bash '{"command":"echo bg-child-ran > bg.txt"}'; step bash '{"command":"git stash drop"}')")"
run p7 "Steps:
$(sub "{\"agent\":\"kit.worker\",\"task\":$TASK,\"async\":true}")"
check "bg launch returned a run id" "Async: kit.worker \[" "$T/p7.log"
check "bg completion notice reached parent" "GOT REPORT: Background task completed" "$T/p7.out"
check "bg worker wrote in its cwd" "bg-child-ran" "$T/work/bg.txt"
check "bg worker: dangerous command blocked" "Needs user approval (drops or pops a stash)" "$T/p7.log"

# 8. background kit.reviewer stays read-only
TASK="$(json "Review: smoke
$(step bash '{"command":"touch bg-reviewer-was-here"}')")"
run p8 "Steps:
$(sub "{\"agent\":\"kit.reviewer\",\"task\":$TASK,\"async\":true}")"
check "bg reviewer: mutating bash blocked" "Read-only session" "$T/p8.log"
absent "bg reviewer left no file" "$T/work/bg-reviewer-was-here"

# 9. resume: a follow-up to a finished worker continues its stored session
TASK="$(json "Goal: smoke
$(step bash '{"command":"echo round-one"}')")"
MSG="$(json "Fix:
$(step bash '{"command":"echo round-two"}')")"
run p9 "Steps:
$(sub "{\"agent\":\"kit.worker\",\"task\":$TASK,\"async\":true}"; step bg_wait '{"id":"$ID"}'; sub "{\"action\":\"resume\",\"id\":\"\$ID\",\"message\":$MSG}")"
check "resumed child ran the follow-up" '"role":"tool","text":"round-two' "$T/p9.log"
check "resumed child kept round-one context" '"tools":\["round-one[^"]*","round-two' "$T/p9.log"

# 10. steer: guidance reaches a running worker mid-run
TASK="$(json "Goal: smoke
$(step bash '{"command":"sleep 10; echo slept"}'; step bash '{"command":"echo not-steered"}')")"
MSG="$(json "Change of plan:
$(step bash '{"command":"echo steered-ok"}')")"
run p10 "Steps:
$(sub "{\"agent\":\"kit.worker\",\"task\":$TASK,\"async\":true}"; step bash '{"command":"sleep 3; echo parent-waited"}'; sub "{\"action\":\"steer\",\"id\":\"\$ID\",\"message\":$MSG}")"
check "steered child ran the new instruction" '"role":"tool","text":"steered-ok' "$T/p10.log"

# 11. bash_bg: returns at once; the exit notice (code, last lines) wakes the parent
run p11 "Steps:
$(step bash_bg '{"command":"echo bg-start; sleep 2; echo bg-last-line; exit 3"}')"
check "bash_bg returned an id and output file" '"role":"tool","text":"Started sh1' "$T/p11.log"
check "exit notice woke the parent" "GOT SHELL: Background shell sh1 exited with code 3" "$T/p11.out"
check "exit notice has the last lines" 'bg-last-line' "$T/p11.log"

# 12. monitor: one notice per matching line over time, non-matching lines dropped, ends on exit
run p12 "Steps:
$(step monitor '{"command":"for i in 1 2 3; do echo ERR $i; echo ok $i; sleep 1.5; done","pattern":"^ERR"}')"
N="$(tail -1 "$T/p12.log" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(d.notices.filter(n=>n.startsWith("Monitor sh1")).length)')"
if [ "$N" -ge 3 ]; then echo "PASS monitor sent $N separate notices"; else echo "FAIL monitor sent $N notices (want >= 3)"; fail=1; fi
check "monitor delivered the last match" 'ERR 3' "$T/p12.log"
nocheck "monitor dropped non-matching lines" '"notices":\[[^]]*ok 2' "$T/p12.log"
check "monitor ended with the command" "Monitor total: 3 matching lines" "$T/p12.log"

# 12b. monitor attached to a running bash_bg task sees only lines written after it attached
run p12b "Steps:
$(step bash_bg '{"command":"printf '"'"'old-%s\\n'"'"' line; sleep 1.5; for i in 1 2; do echo after $i; sleep 1; done"}'; step bash '{"command":"sleep 0.5; echo attached"}'; step monitor '{"id":"sh1","pattern":"old|after"}')"
check "attached monitor got new lines" '"notices":\[[^]]*after 2' "$T/p12b.log"
nocheck "attached monitor skipped earlier output" '"notices":\[[^]]*old-line' "$T/p12b.log"

# 13. shell_stop kills the whole process group, grandchildren included; shell_list shows tasks
run p13 "Steps:
$(step bash_bg '{"command":"bash -c '"'"'sleep 300 & echo $! > gc.pid; wait'"'"' & wait"}'; step bash '{"command":"sleep 1; kill -0 $(cat gc.pid) && echo gc-alive-before"}'; step shell_list '{}'; step shell_stop '{"id":"sh1"}'; step bash '{"command":"sleep 0.5; kill -0 $(cat gc.pid) 2>/dev/null && echo gc-still-alive || echo gc-dead"}')"
check "grandchild ran" "gc-alive-before" "$T/p13.log"
check "shell_list shows the running task" '"role":"tool","text":"sh1  running' "$T/p13.log"
check "shell_stop killed the grandchild" '"role":"tool","text":"gc-dead' "$T/p13.log"
nocheck "stopped task sends no exit notice" "GOT SHELL" "$T/p13.out"

# 14. guardrails apply to the background tools: dangerous blocked headless, notices redacted
run p14 "Steps:
$(step bash_bg '{"command":"git stash drop"}'; step bash_bg '{"command":"echo token ghp_abcdefghijklmnopqrstuvwxyz0123456789AB password=supersecretvalue123"}')"
check "bash_bg: dangerous command blocked" "Needs user approval (drops or pops a stash)" "$T/p14.log"
nocheck "notice: token never sent" '"notices":\[[^]]*ghp_abcdef' "$T/p14.log"
nocheck "tool results: token never sent" '"role":"tool","text":"[^"]*ghp_abcdef' "$T/p14.log"
check "notice: assignment redacted" 'password=\[REDACTED\]' "$T/p14.log"
BEFORE="$(wc -l < "$T/mock.log")"
node "$KIT/test/rpc-confirm.mjs" "Steps:
$(step bash_bg '{"command":"git stash drop"}')" > "$T/p14b.out" 2> "$T/p14b.err"
tail -n +"$((BEFORE + 1))" "$T/mock.log" > "$T/p14b.log"
check "bash_bg: confirm asked with a UI" "git stash drop => false" "$T/p14b.out"
check "bash_bg: declined command blocked" "User declined: drops or pops a stash" "$T/p14b.log"

# 15. read-only: no background tools for the reviewer or a PI_KIT_READONLY session
TASK="$(json "Review: smoke
$(step bash_bg '{"command":"touch reviewer-bg-was-here"}'; step monitor '{"command":"touch reviewer-mon-was-here"}')")"
run p15 "Steps:
$(sub "{\"agent\":\"kit.reviewer\",\"task\":$TASK,\"async\":false}")"
check "reviewer: bash_bg unavailable" "Tool bash_bg not found\|background shell tools are not allowed" "$T/p15.log"
absent "reviewer: no file from bash_bg" "$T/work/reviewer-bg-was-here"
absent "reviewer: no file from monitor" "$T/work/reviewer-mon-was-here"
PI_KIT_READONLY=1 run p15b "Steps:
$(step bash_bg '{"command":"touch ro-bg-was-here"}')"
absent "PI_KIT_READONLY session: bash_bg did not run" "$T/work/ro-bg-was-here"

# 16. kit.worker has the tools; the notice wakes the child itself
TASK="$(json "Goal: smoke
$(step bash_bg '{"command":"echo worker-bg > worker-bg.txt; exit 4"}')")"
run p16 "Steps:
$(sub "{\"agent\":\"kit.worker\",\"task\":$TASK,\"async\":false}")"
check "worker ran bash_bg in its cwd" "worker-bg" "$T/work/worker-bg.txt"
check "worker child got the exit notice" "GOT SHELL: Background shell sh1 exited with code 4" "$T/p16.log"

# 17. monitor under a flood: notices stay capped at 20 lines and count the rest
run p17 "Steps:
$(step monitor '{"command":"for i in $(seq 1 50000); do echo ERR $i; done","pattern":"ERR"}')"
check "flood: lines beyond the cap are counted" 'more matching lines (see the output file)' "$T/p17.log"
check "flood: monitor still ends with the command" "Monitor total: 50000 matching lines" "$T/p17.log"

# 18. wake_later: clamped to 60s, fires as a notice; a cancelled timer never fires
run p18 "Steps:
$(step wake_later '{"seconds":120,"prompt":"never"}'; step shell_list '{}'; step shell_stop '{"id":"wk1"}'; step wake_later '{"seconds":1,"prompt":"check the deploy page"}')"
check "wake_later: listed while pending" '"role":"tool","text":"wk1  wakes in' "$T/p18.log"
check "wake_later: cancelled" "Cancelled timer wk1" "$T/p18.log"
check "wake_later: clamped to the minimum" "wakes this session in 60s (clamped from 1)" "$T/p18.log"
check "wake_later: fired with its prompt" "GOT SHELL: Wake-up wk2 after 1m00s: check the deploy page" "$T/p18.out"
nocheck "wake_later: cancelled timer never fired" "Wake-up wk1" "$T/p18.log"

# 19. secrets in output: redacted before lines are cut, key blocks dropped, in monitor lines and the exit tail
cat > "$T/work/leak.sh" <<'SH'
printf '%0290d ghp_abcdefghijklmnopqrstuvwxyz0123456789AB\n' 0
printf '%0227d eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.c2lnbmF0dXJlLXBhcnQtMTIzNDU2\n' 0
echo "-----BEGIN RSA PRIVATE KEY-----"; echo MIIEfakefakefakeAAAAQQQQ1111; echo ZZZZfakebodyline2zzzzzzzzzzz; echo "-----END RSA PRIVATE KEY-----"
echo leak-done
SH
run p19 "Steps:
$(step monitor '{"command":"bash leak.sh"}'; step bash_bg '{"command":"bash leak.sh"}'; step bash '{"command":"sleep 1; echo waited"}')"
check "leak: monitor delivered the output" 'Background shell sh1 exited with code 0[^"]*leak-done' "$T/p19.log"
check "leak: exit tail delivered" 'Background shell sh2 exited with code 0[^"]*leak-done' "$T/p19.log"
nocheck "leak: token cut at the line cap never sent" "ghp_abc" "$T/p19.log"
nocheck "leak: JWT cut before its signature never sent" "eyJhbGci" "$T/p19.log"
nocheck "leak: key block body never sent" "MIIEfake\|ZZZZfake" "$T/p19.log"
check "leak: key block reported" '\[private key block redacted\]' "$T/p19.log"

# 20. processes left in the group after bash exits are reported, listed and killed by shell_stop
run p20 "Steps:
$(step bash_bg '{"command":"sleep 30 & echo $! > lo.pid"}'; step bash '{"command":"sleep 1; kill -0 $(cat lo.pid) && echo lo-alive"}'; step shell_list '{}'; step shell_stop '{"id":"sh1"}'; step bash '{"command":"kill -0 $(cat lo.pid) 2>/dev/null && echo lo-still-alive || echo lo-dead"}')"
check "leftover: background sleep ran" '"role":"tool","text":"lo-alive' "$T/p20.log"
check "leftover: exit notice says it is still running" "1 process is still running in its group; shell_stop sh1 kills them" "$T/p20.log"
check "leftover: shell_list shows it" "processes left in its group" "$T/p20.log"
check "leftover: shell_stop killed it" "Killed the processes left in sh1's group" "$T/p20.log"
check "leftover: sleep is dead" '"role":"tool","text":"lo-dead' "$T/p20.log"

# 21. patterns: nested quantifiers rejected, a slow pattern ends the watch; one monitor per task;
# shell_stop ends the watch first, so no monitor notice follows it (21b)
run p21 "Steps:
$(step monitor '{"command":"echo hi","pattern":"(\\w+\\s?)+$"}'; step monitor '{"command":"printf a%.0s $(seq 4096); echo; sleep 20","pattern":".*.*x"}'; step bash '{"command":"sleep 2; echo waited"}'; step bash_bg '{"command":"sleep 20"}'; step monitor '{"id":"sh2"}'; step monitor '{"id":"sh2"}'; step shell_stop '{"id":"sh2"}')"
check "pattern: nested quantifier rejected" "repeats a group that itself repeats" "$T/p21.log"
check "pattern: slow pattern ended the watch" "Monitor sh1 ended: pattern /.\*.\*x/ took over 1s" "$T/p21.log"
check "pattern: slow pattern's command stopped" "Its command was stopped" "$T/p21.log"
check "monitor: second watch on a task refused" "sh2 already has a monitor. End it first with shell_stop sh2 watch_only" "$T/p21.log"
# The command ignores SIGTERM, so the stop waits 2 s for SIGKILL: longer than a monitor batch.
run p21b "Steps:
$(step monitor '{"command":"trap \"\" TERM; while true; do echo L; sleep 0.1; done"}'; step shell_stop '{"id":"sh1"}')"
check "shell_stop: returned the undelivered lines" "Undelivered monitor lines" "$T/p21b.log"
nocheck "shell_stop: no monitor notice after the stop" '"notices":\[[^]]*Monitor sh1' "$T/p21b.log"

# 22. a watch that falls far behind skips ahead and says so; an output file past the cap kills the task
run p22 "Steps:
$(step monitor '{"command":"yes ERR | head -c 40000000","pattern":"ERR"}')"
check "backlog: skipped bytes reported" "bytes skipped: output came faster than the monitor reads" "$T/p22.log"
check "backlog: monitor still ended with the command" "Monitor total: " "$T/p22.log"
PI_KIT_SHELL_LOG_CAP=1000000 run p22b "Steps:
$(step bash_bg '{"command":"yes | head -c 3000000; sleep 20"}')"
check "log cap: task killed with a clear notice" "Background shell sh1 killed: output file passed 1 MiB" "$T/p22b.log"

# 23. no background shell in the agent dir; reading a shell output file redacts assignments;
# headless wake_later is clamped to the drain window
run p23 "Steps:
$(step bash_bg '{"command":"echo password=supersecretvalue123; echo done"}'; step bash '{"command":"sleep 1; echo waited"}'; step read '{"path":"$OUT"}'; step wake_later '{"seconds":7200,"prompt":"never"}'; step shell_stop '{"id":"wk2"}')"
check "read of a shell log: assignment redacted" '"role":"tool","text":"password=\[REDACTED\]' "$T/p23.log"
nocheck "read of a shell log: value never sent" '"role":"tool","text":"[^"]*supersecretvalue123' "$T/p23.log"
check "headless wake_later clamped to the drain window" "wakes this session in 1800s (clamped from 7200)" "$T/p23.log"

# 24. notes reminder: past the threshold, one reminder in the context, no extra turn, and the
# planned steps still finish (print mode keeps the real answer); 0 disables it
PI_KIT_NOTES_REMIND_PERCENT=0.0001 run p24 "Steps:
$(step bash '{"command":"echo one"}'; step bash '{"command":"echo two"}')"
N="$(tail -1 "$T/p24.log" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).reminders.length)')"
if [ "$N" = 1 ]; then echo "PASS notes reminder sent once"; else echo "FAIL notes reminder: $N in the last request (want 1)"; fail=1; fi
check "notes reminder shows a decimal percent" '"reminders":\["Context is [0-9]*\.[0-9]% full' "$T/p24.log"
check "notes reminder: planned steps finished" "FINAL: two" "$T/p24.out"
if [ "$(wc -l < "$T/p24.log")" -eq 3 ]; then echo "PASS notes reminder started no extra turn"; else echo "FAIL notes reminder: $(wc -l < "$T/p24.log") requests (want 3)"; fail=1; fi
# A reminder due on a turn that ends the run must not start another turn (its text would
# replace the answer in print mode).
PI_KIT_NOTES_REMIND_PERCENT=0.0001 run p24c "hello"
if [ "$(wc -l < "$T/p24c.log")" -eq 1 ] && [ "$(cat "$T/p24c.out")" = "FINAL: no tools" ]; then echo "PASS notes reminder on the final turn adds no turn"; else echo "FAIL notes reminder on the final turn: $(wc -l < "$T/p24c.log") requests, output $(head -c 80 "$T/p24c.out")"; fail=1; fi
PI_KIT_NOTES_REMIND_PERCENT=0 run p24b "Steps:
$(step bash '{"command":"echo one"}')"
nocheck "notes reminder disabled by 0" "compacted soon" "$T/p24b.log"
nocheck "no notes reminder below the threshold" "will be compacted soon" "$T/p1.log"

# 25. pi-desk bridge: pi in its TUI (a pseudo-terminal) against a fake pi-desk: handshake, session,
# status across runs, blockers, panels, wait_idle, reload, reconnect; the sidebar column only outside pi-desk
node "$KIT/test/desk-fake.mjs" desk "$T/desk.log" "$T/desk.screen" > "$T/desk.out" 2>&1 || fail=1
sed -e 's/^OK /PASS desk: /' -e 's/^FAIL /FAIL desk: /' "$T/desk.out"
check "desk: prompt ran through the model" '"text":"FINAL: desk-ran' "$T/mock.log"
check "desk: shell commands do not see the token" 'desk-ran token=\[\]' "$T/mock.log"
nocheck "desk: no sidebar column in pi-desk" "No subagents, todos or shells" "$T/desk.screen"
node "$KIT/test/desk-fake.mjs" plain "$T/plain.screen"
check "desk: sidebar column outside pi-desk" "No subagents, todos or shells" "$T/plain.screen"
node "$KIT/test/desk-fake.mjs" nopanels "$T/nopanels.log" "$T/nopanels.screen" > "$T/nopanels.out" 2>&1 || fail=1
sed -e 's/^OK /PASS desk without panels: /' -e 's/^FAIL /FAIL desk without panels: /' "$T/nopanels.out"
check "desk without panels: sidebar column stays" "No subagents, todos or shells" "$T/nopanels.screen"
node "$KIT/test/desk-fake.mjs" earlyreload "$T/earlyreload.log" "$T/earlyreload.screen" > "$T/earlyreload.out" 2>&1 || fail=1
sed -e 's/^OK /PASS desk reload before the first hello is answered: /' -e 's/^FAIL /FAIL desk reload before the first hello is answered: /' "$T/earlyreload.out"
PI_DESK_SOCKET="$T/no-such-desk.sock" PI_DESK_TOKEN=unused node "$KIT/test/desk-fake.mjs" plain "$T/nodesk.screen"
check "desk: sidebar column when pi-desk is not there" "No subagents, todos or shells" "$T/nodesk.screen"

# 26. the sidebar is one column of normal width with the editor on screen, across /reload and
# /new, outside and inside pi-desk (no panels), also with a second copy of the sidebar loaded
# (another path, as when trying a checkout with -e next to the installed kit)
sidebar_ok() { # <name> <snaps file> <min snaps>
	local bad; bad="$(grep '^SNAP ' "$2" | grep -v 'columns=1 at=106 editor=yes')"
	if [ "$(grep -c '^SNAP ' "$2")" -ge "$3" ] && [ -z "$bad" ]; then echo "PASS $1"; else echo "FAIL $1: $(tr '\n' ' ' < "$2")"; fail=1; fi
}
node "$KIT/test/desk-fake.mjs" plain "$T/side1.screen" /reload /reload /new > "$T/side1.out" 2>&1
sidebar_ok "sidebar: one column across reloads and /new" "$T/side1.out" 4
node "$KIT/test/desk-fake.mjs" reloads "$T/side2.log" "$T/side2.screen" /reload /reload /new > "$T/side2.out" 2>&1
sidebar_ok "sidebar: one column across reloads and /new in pi-desk without panels" "$T/side2.out" 4
mkdir -p "$T/agent2" && cp "$PI_CODING_AGENT_DIR/models.json" "$T/agent2/" && cp -R "$KIT/extensions" "$T/kit2-extensions"
node -e 'const fs=require("fs"),s=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));s.extensions=[process.argv[2]];fs.writeFileSync(process.argv[3],JSON.stringify(s))' "$PI_CODING_AGENT_DIR/settings.json" "$T/kit2-extensions/sidebar/index.ts" "$T/agent2/settings.json"
PI_CODING_AGENT_DIR="$T/agent2" node "$KIT/test/desk-fake.mjs" plain "$T/side3.screen" /reload /new > "$T/side3.out" 2>&1
sidebar_ok "sidebar loaded twice: one column" "$T/side3.out" 3
PI_CODING_AGENT_DIR="$T/agent2" node "$KIT/test/desk-fake.mjs" reloads "$T/side4.log" "$T/side4.screen" /reload /new > "$T/side4.out" 2>&1
sidebar_ok "sidebar loaded twice: one column in pi-desk without panels" "$T/side4.out" 3

if ls -d "$TMPDIR"/pi-shell-* >/dev/null 2>&1; then echo "FAIL shell temp dirs left behind"; fail=1; else echo "PASS shell temp dirs removed at shutdown"; fi

echo "artifacts: $T"
exit $fail
