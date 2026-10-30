#!/usr/bin/env bash
# Tests the AGENTS.md merge in scripts/install.sh with fixture files, a stub `pi` and a temp agent
# dir. No network, no real pi config. Usage: test/merge.sh
set -uo pipefail
KIT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d "${TMPDIR:-/tmp}/pi-kit-merge.XXXXXX")"
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin"
export XDG_CONFIG_HOME="$T/xdg"   # install.sh seeds rpiv-todo's config there, not in ~/.config
# Stub pi: a version, and `pi install` does nothing (every package is already configured below).
printf '#!/bin/sh\n[ "$1" = --version ] && echo 1.2.0\nexit 0\n' > "$T/bin/pi"; chmod +x "$T/bin/pi"
PKGS="$(node -p 'const m=require(process.argv[1]);JSON.stringify([...m.recommended.map(p=>p.spec),process.argv[2]])' "$KIT/packages.json" "$KIT")"
fail=0 n=0
ok() { n=$((n + 1)); echo "PASS $1"; }
bad() { n=$((n + 1)); echo "FAIL $1"; fail=1; }
has() { if grep -q -- "$2" "$3"; then ok "$1"; else bad "$1 (no '$2' in $3)"; fi; }
hasnt() { if grep -q -- "$2" "$3"; then bad "$1 (found '$2' in $3)"; else ok "$1"; fi; }
heads() { grep -c '^## ' "$1"; }
# install <case> <fixture or -> [args...]: fresh agent dir with the fixture as AGENTS.md, run install.sh.
install() {
	local c="$1" f="$2"; shift 2
	export PI_CODING_AGENT_DIR="$T/$c"
	mkdir -p "$PI_CODING_AGENT_DIR"
	[ -f "$PI_CODING_AGENT_DIR/settings.json" ] || echo "{\"packages\":$PKGS}" > "$PI_CODING_AGENT_DIR/settings.json"
	[ "$f" = - ] || [ -f "$PI_CODING_AGENT_DIR/AGENTS.md" ] || cp "$f" "$PI_CODING_AGENT_DIR/AGENTS.md"
	PATH="$T/bin:$PATH" "$KIT/scripts/install.sh" "$@" > "$T/$c.out" 2>&1
	echo $? > "$T/$c.exit"
}
A() { echo "$T/$1/AGENTS.md"; }

# 1. no file: the kit's file is created whole
install none -
has "none: created" "created" "$T/none.out"
if cmp -s "$(A none)" "$KIT/AGENTS.md"; then ok "none: identical to the kit's"; else bad "none: differs from the kit's"; fi

# 2. empty file: every section is new and appended
: > "$T/empty.md"
install empty "$T/empty.md" --dry-run
has "empty dry-run: suggests all sections" "suggested: scripts/install.sh --sections operating,communication,safety,background,parent,delegation,review,child,notes" "$T/empty.out"
if [ ! -s "$(A empty)" ]; then ok "empty dry-run: file unchanged"; else bad "empty dry-run: file changed"; fi
install empty "$T/empty.md"
if [ "$(heads "$(A empty)")" = 9 ]; then ok "empty: 9 sections appended"; else bad "empty: $(heads "$(A empty)") sections"; fi
if ls "$T/empty/AGENTS.md.bak."* >/dev/null 2>&1; then ok "empty: backup written"; else bad "empty: no backup"; fi

# 3. kit-identical file: nothing to append, re-run is a no-op
install same "$KIT/AGENTS.md"
has "same: every section already there" "operating     Operating rules (Everyone): already there" "$T/same.out"
has "same: nothing appended" "ok: nothing to append" "$T/same.out"
if cmp -s "$(A same)" "$KIT/AGENTS.md"; then ok "same: unchanged"; else bad "same: changed"; fi

# 4. a file with its own rules: overlaps reported and skipped, only new sections appended
install own "$KIT/test/fixtures/agents-own-rules.md" --dry-run
has "own: operating overlap by heading words" 'operating     Operating rules (Everyone): likely overlap, heading words match "## Operating Rules"' "$T/own.out"
has "own: parent overlap at any heading level" 'parent        Parent session (Parent): likely overlap, heading words match "### Parent session"' "$T/own.out"
has "own: child overlap" 'child         Child sessions (Child): likely overlap' "$T/own.out"
has "own: safety overlap" 'safety        Safety (Everyone): likely overlap, heading words match "### Safety and authority"' "$T/own.out"
has "own: notes overlap" 'notes         Durable notes and handoffs (Parent): likely overlap, heading words match "## Durable notes (vault)"' "$T/own.out"
has "own: suggested line" "suggested: scripts/install.sh --sections communication,background,delegation,review" "$T/own.out"
install own -
B="$(ls "$T/own/AGENTS.md.bak."* 2>/dev/null | head -1)"
if [ -n "$B" ] && cmp -s "$B" "$KIT/test/fixtures/agents-own-rules.md"; then ok "own: backup matches the original"; else bad "own: backup missing or different"; fi
has "own: overlaps skipped and said so" "skipped notes: likely overlap" "$T/own.out"
for h in "## Communication" "## Background work" "## Delegation mechanics" "## Review and merge gate"; do has "own: appended $h" "^$h" "$(A own)"; done
hasnt "own: no duplicate operating rules" "^## Operating rules (Everyone)" "$(A own)"
hasnt "own: no generic notes section" "<notes-folder>" "$(A own)"
install own -
has "own: re-run appends nothing" "ok: nothing to append" "$T/own.out"

# 4b. content overlap: a differently named section that says the same thing
printf '## House style\n\nThink before coding, and keep changes small.\n' > "$T/content.md"
install content "$T/content.md" --dry-run
has "content: overlap by key phrase" 'operating     Operating rules (Everyone): likely overlap, content has "think before coding"' "$T/content.out"

# 4c. the kit minus one section: the kit's own text never counts as an overlap
node -e 'const fs=require("fs");process.stdout.write(fs.readFileSync(process.argv[1],"utf8").replace(/^## Durable notes[\s\S]*$/m,""))' "$KIT/AGENTS.md" > "$T/minus.md"
install minus "$T/minus.md" --dry-run
has "minus: the missing section is new" "notes         Durable notes and handoffs (Parent): new" "$T/minus.out"
has "minus: suggests only it" "suggested: scripts/install.sh --sections notes$" "$T/minus.out"

# 4d. headings inside fenced code blocks are ignored; a one-word heading needs the same words
printf '## Rules\n\nBe nice.\n\n```markdown\n## Parent session\n```\n' > "$T/fence.md"
install fence "$T/fence.md" --dry-run
has "fence: heading in a code block ignored" "parent        Parent session (Parent): new" "$T/fence.out"
has "fence: one-word heading is not a partial match" "operating     Operating rules (Everyone): new" "$T/fence.out"
printf '## Safety\n\nCareful.\n' > "$T/oneword.md"
install oneword "$T/oneword.md" --dry-run
has "oneword: same single word still matches" 'safety        Safety (Everyone): likely overlap, heading words match "## Safety"' "$T/oneword.out"

# 4e. same heading, other text: says how to compare and re-add
printf '## Communication (Everyone)\n\n- My own words.\n' > "$T/differs.md"
install differs "$T/differs.md" --dry-run
has "differs: reported" "communication Communication (Everyone): same heading, different text: left alone" "$T/differs.out"
has "differs: hint to compare" "to compare: diff" "$T/differs.out"
has "differs: hint to re-add" "remove your section, then --sections communication" "$T/differs.out"

# 5. --sections: only the chosen ones, even an overlap; unknown keys refused before anything runs
install pick "$KIT/test/fixtures/agents-own-rules.md" --sections communication,notes
if [ "$(heads "$(A pick)")" = 5 ]; then ok "pick: 2 sections appended"; else bad "pick: $(grep '^## ' "$(A pick)" | tr '\n' '|')"; fi
has "pick: chosen overlap appended" "^## Durable notes and handoffs" "$(A pick)"
hasnt "pick: others not appended" "^## Background work" "$(A pick)"
install bad - --sections communication,bogus
if [ "$(cat "$T/bad.exit")" = 2 ]; then ok "unknown key: exit 2"; else bad "unknown key: exit $(cat "$T/bad.exit")"; fi
has "unknown key: named" "unknown --sections key: bogus" "$T/bad.out"
if [ ! -e "$(A bad)" ]; then ok "unknown key: nothing written"; else bad "unknown key: file written"; fi

# 6. panel configs: seeded only where neither rpiv-todo location has one; relative XDG = unset
R=rpiv-todo/config.json
mkdir -p "$T/h1/.config/rpiv-todo" && echo '{}' > "$T/h1/.config/$R"
HOME="$T/h1" XDG_CONFIG_HOME="$T/x1" install seed1 -
has "seed: legacy rpiv-todo config kept" "kept: $T/h1/.config/$R" "$T/seed1.out"
if [ ! -e "$T/x1/$R" ]; then ok "seed: no XDG copy beside a legacy config"; else bad "seed: XDG copy written"; fi
has "seed: subagent config seeded" "seeded $T/seed1/extensions/subagent/config.json" "$T/seed1.out"
HOME="$T/h2" XDG_CONFIG_HOME=rel install seed2 -
if [ -e "$T/h2/.config/$R" ]; then ok "seed: relative XDG_CONFIG_HOME ignored"; else bad "seed: not in HOME/.config"; fi
HOME="$T/h3" XDG_CONFIG_HOME="$T/x3" install seed3 - --dry-run
has "seed dry-run: says would seed" "would seed $T/x3/$R" "$T/seed3.out"
hasnt "seed dry-run: no seeded line" "^seeded" "$T/seed3.out"
if [ ! -e "$T/seed3/extensions/subagent/config.json" ]; then ok "seed dry-run: nothing written"; else bad "seed dry-run: written"; fi

echo "merge tests: $n run, fail=$fail"
exit $fail
