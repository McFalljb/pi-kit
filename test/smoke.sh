#!/usr/bin/env bash
# Offline smoke test: isolated PI_CODING_AGENT_DIR, a scripted mock model, no real credentials.
# Loads the kit together with pi-subagents, as a real install would.
#
# Usage: test/smoke.sh   (needs pi, node and npm on PATH)
#   PI_SUBAGENTS_DIR=<path>   use an already installed pi-subagents package in place (read-only)
#                             instead of installing it from npm into the temp agent dir
#   PI_SUBAGENTS_VERSION=x.y.z  version to install from npm [0.78.0]
set -uo pipefail
KIT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d "${TMPDIR:-/tmp}/pi-kit-smoke.XXXXXX")"
PORT="${PI_KIT_MOCK_PORT:-18555}"
# Everything the run writes (agent dir, pi-subagents run state, child sessions) stays under $T.
export PI_CODING_AGENT_DIR="$T/agent" PI_OFFLINE=1 PI_SUBAGENTS_TEMP_ROOT="$T/subagents-tmp" TMPDIR="$T/tmp"
mkdir -p "$PI_CODING_AGENT_DIR" "$T/work" "$TMPDIR"

if [ -n "${PI_SUBAGENTS_DIR:-}" ]; then
	SUBAGENTS="$PI_SUBAGENTS_DIR"
else
	V="${PI_SUBAGENTS_VERSION:-0.78.0}"
	npm install --prefix "$PI_CODING_AGENT_DIR/npm" --no-audit --no-fund --silent "pi-subagents@$V" >/dev/null 2>"$T/npm.err" \
		|| { echo "FAIL could not install pi-subagents@$V from npm (see $T/npm.err); set PI_SUBAGENTS_DIR"; exit 2; }
	SUBAGENTS="$PI_CODING_AGENT_DIR/npm/node_modules/pi-subagents"
fi
echo "pi $(pi --version), pi-subagents $(node -p 'require(process.argv[1]).version' "$SUBAGENTS/package.json")"

# Two mock providers on the same server, so the reviewer's model pin can be observed.
cat > "$PI_CODING_AGENT_DIR/models.json" <<JSON
{"providers":{
 "mock":{"baseUrl":"http://127.0.0.1:$PORT/v1","api":"openai-completions","apiKey":"mock","models":[{"id":"mock-1"}]},
 "mockb":{"baseUrl":"http://127.0.0.1:$PORT/v1","api":"openai-completions","apiKey":"mock","models":[{"id":"mock-b"}]}}}
JSON
cat > "$PI_CODING_AGENT_DIR/settings.json" <<JSON
{"defaultProvider":"mock","defaultModel":"mock-1","defaultThinkingLevel":"off","enableInstallTelemetry":false,
 "packages":["$SUBAGENTS","$KIT"],
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
	local before; before="$(wc -l < "$T/mock.log")"
	perl -e 'alarm shift; exec @ARGV' 240 pi -p --no-session "$2" > "$T/$1.out" 2> "$T/$1.err" < /dev/null
	echo "$?" > "$T/$1.exit"
	tail -n +"$((before + 1))" "$T/mock.log" > "$T/$1.log"
}
# sub <args-json>: one parent step that calls the subagent tool.
sub() { step subagent "$1"; }

# 1. guardrails in a headless (no-UI) parent
run p1 "Steps:
$(step bash '{"command":"git stash drop"}'; step bash '{"command":"rm -rf build"}'; step bash '{"command":"kubectl delete pod x"}'; step read '{"path":".env"}'; step bash '{"command":"cat .env"}'; step bash '{"command":"echo token ghp_abcdefghijklmnopqrstuvwxyz0123456789AB password=supersecretvalue123"}'; step bash '{"command":"echo hello-safe"}')"
check "stash drop blocked" "Needs user approval (drops or pops a stash)" "$T/p1.log"
check "rm -rf blocked" "recursive force delete" "$T/p1.log"
check "kubectl delete blocked" "changes a cluster" "$T/p1.log"
check ".env read blocked" "looks like a secret or credential file" "$T/p1.log"
check "cat .env blocked" "touches a secret" "$T/p1.log"
nocheck ".env content never sent" "do-not-read" "$T/mock.log"
nocheck "github token redacted" '"role":"tool","text":"[^"]*ghp_abcdef' "$T/p1.log"
check "token replaced in tool output" '"role":"tool","text":"token \[REDACTED\]' "$T/p1.log"
check "assignment redacted" "password=\[REDACTED\]" "$T/p1.log"
check "safe command runs" "FINAL: hello-safe" "$T/p1.out"

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

# 5. foreground kit.worker: runs in cwd, guardrails apply inside the child
TASK="$(json "Goal: smoke
$(step bash '{"command":"echo fg-child-ran > fg.txt && cat fg.txt"}'; step bash '{"command":"git stash drop"}'; step bash '{"command":"cat .env"}')")"
run p5 "Steps:
$(sub "{\"agent\":\"kit.worker\",\"task\":$TASK,\"async\":false}")"
check "fg worker wrote in its cwd" "fg-child-ran" "$T/work/fg.txt"
check "fg worker: dangerous command blocked" "Needs user approval (drops or pops a stash)" "$T/p5.log"
check "fg worker: secret read blocked" "touches a secret" "$T/p5.log"

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

# 13. shell_stop kills the whole process group, grandchildren included; shell_list shows tasks
run p13 "Steps:
$(step bash_bg '{"command":"bash -c '"'"'sleep 300 & echo $! > gc.pid; wait'"'"' & wait"}'; step bash '{"command":"sleep 1; kill -0 $(cat gc.pid) && echo gc-alive-before"}'; step shell_list '{}'; step shell_stop '{"id":"sh1"}'; step bash '{"command":"sleep 0.5; kill -0 $(cat gc.pid) 2>/dev/null && echo gc-still-alive || echo gc-dead"}')"
check "grandchild ran" "gc-alive-before" "$T/p13.log"
check "shell_list shows the running task" '"role":"tool","text":"sh1  running' "$T/p13.log"
check "shell_stop killed the grandchild" '"role":"tool","text":"gc-dead' "$T/p13.log"
nocheck "stopped task sends no exit notice" "GOT SHELL" "$T/p13.out"

# 14. guardrails apply to the background tools: dangerous blocked headless, secrets blocked, notices redacted
run p14 "Steps:
$(step bash_bg '{"command":"git stash drop"}'; step monitor '{"command":"cat .env"}'; step bash_bg '{"command":"echo token ghp_abcdefghijklmnopqrstuvwxyz0123456789AB password=supersecretvalue123"}')"
check "bash_bg: dangerous command blocked" "Needs user approval (drops or pops a stash)" "$T/p14.log"
check "monitor: secret read blocked" "touches a secret" "$T/p14.log"
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

echo "artifacts: $T"
exit $fail
