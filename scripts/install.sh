#!/usr/bin/env bash
# Idempotent pi-kit install: checks prerequisites, installs the pinned packages from packages.json
# and the kit itself with `pi install`, merges the kit's AGENTS.md into the global one (backup
# first, append new sections only, skip likely overlaps), optionally pins the reviewer model and
# seeds compact panel configs for pi-subagents and rpiv-todo where none exist.
# Never reads credential files and never runs /login. See SETUP.md.
#
# Usage: scripts/install.sh [--optional name,name] [--reviewer-model provider/id] [--sections key,key] [--dry-run]
#   --sections  append only these kit AGENTS.md sections (keys: operating, communication, safety,
#               background, parent, delegation, review, child, notes); --dry-run shows the report
set -euo pipefail
KIT="$(cd "$(dirname "$0")/.." && pwd)"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
OPTIONAL="" REVIEWER="" SECTIONS="" DRY=0
while [ $# -gt 0 ]; do
	case "$1" in
		--optional) OPTIONAL="$2"; shift 2 ;;
		--reviewer-model) REVIEWER="$2"; shift 2 ;;
		--sections) SECTIONS="$2"; shift 2 ;;
		--dry-run) DRY=1; shift ;;
		*) echo "unknown argument: $1" >&2; exit 2 ;;
	esac
done
for k in ${SECTIONS//,/ }; do
	case "$k" in operating|communication|safety|background|parent|delegation|review|child|notes) ;;
		*) echo "unknown --sections key: $k (see the usage line in $0)" >&2; exit 2 ;; esac
done
run() { if [ "$DRY" = 1 ]; then echo "would run: $*"; else "$@"; fi; }

# 1. Prerequisites
command -v node >/dev/null || { echo "node not found: install Node.js 22.19 or later" >&2; exit 1; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=19)?0:1)' \
	|| { echo "node $(node --version) is too old: pi needs 22.19 or later" >&2; exit 1; }
command -v pi >/dev/null || { echo "pi not found: npm install -g --ignore-scripts @earendil-works/pi-coding-agent" >&2; exit 1; }
echo "node $(node --version), pi $(pi --version), agent dir $AGENT_DIR"
mkdir -p "$AGENT_DIR"

# 2. Packages: install each pinned spec unless a package of that name is already configured.
# Prints "<spec>\t<name>\t<installed spec or ->" for the recommended set plus the chosen optional ones.
PLAN="$(node - "$KIT/packages.json" "$AGENT_DIR/settings.json" "$OPTIONAL" <<'JS'
const fs = require("fs");
const [manifest, settingsPath, optional] = process.argv.slice(2);
const m = JSON.parse(fs.readFileSync(manifest, "utf8"));
let configured = [];
try { configured = (JSON.parse(fs.readFileSync(settingsPath, "utf8")).packages || []).map((p) => (typeof p === "string" ? p : p.source)); } catch {}
const nameOf = (spec) => spec.replace(/^npm:/, "").replace(/^(@?[^@]+)@.*$/, "$1");
const wanted = optional.split(",").filter(Boolean);
const unknown = wanted.filter((n) => !m.optional.some((p) => p.name === n));
if (unknown.length) { console.error(`unknown optional package(s): ${unknown.join(", ")}`); process.exit(2); }
for (const p of [...m.recommended, ...m.optional.filter((p) => wanted.includes(p.name))]) {
  const have = configured.find((c) => typeof c === "string" && nameOf(c) === p.name) || "-";
  console.log(`${p.spec}\t${p.name}\t${have}`);
}
JS
)"
while IFS=$'\t' read -r spec name have; do
	[ -n "$spec" ] || continue
	if [ "$have" = "-" ]; then
		echo "installing $spec"
		run pi install "$spec"
	elif [ "$have" = "$spec" ]; then
		echo "ok: $spec"
	else
		echo "kept: $name is already configured as $have (kit tested with $spec; change it yourself if you want)"
	fi
done <<< "$PLAN"
# pi stores local paths relative to settings.json, so compare resolved real paths.
if node -e 'const fs=require("fs"),path=require("path"),f=process.argv[1],s=JSON.parse(fs.readFileSync(f,"utf8"));const real=(p)=>{try{return fs.realpathSync(path.resolve(path.dirname(f),p))}catch{return ""}};process.exit((s.packages||[]).some(p=>real(typeof p==="string"?p:p.source)===fs.realpathSync(process.argv[2]))?0:1)' "$AGENT_DIR/settings.json" "$KIT" 2>/dev/null; then
	echo "ok: kit ($KIT)"
else
	echo "installing kit from $KIT"
	run pi install "$KIT"
fi

# 3. AGENTS.md: report how each kit section overlaps the global file, then append the chosen
# sections (--sections), or every section that is neither there nor a likely overlap. Backs the
# file up first; existing text is never changed. Re-running appends nothing.
node "$KIT/scripts/agents-merge.mjs" "$KIT/AGENTS.md" "$AGENT_DIR/AGENTS.md" "$SECTIONS" "$DRY"

# 4. Reviewer model override (subagents.agentOverrides["kit.reviewer"].model)
CURRENT=""
if [ -n "$REVIEWER" ]; then
	CURRENT="$(node -e 'try{const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(s.subagents?.agentOverrides?.["kit.reviewer"]?.model??"")}catch{}' "$AGENT_DIR/settings.json")"
fi
if [ -n "$REVIEWER" ] && [ "$CURRENT" = "$REVIEWER" ]; then
	echo "ok: kit.reviewer already pinned to $REVIEWER"
elif [ -n "$REVIEWER" ]; then
	echo "pinning kit.reviewer to $REVIEWER"
	if [ "$DRY" = 0 ]; then
		cp "$AGENT_DIR/settings.json" "$AGENT_DIR/settings.json.bak.$(date +%Y%m%d%H%M%S)"
		node -e 'const fs=require("fs"),f=process.argv[1],s=JSON.parse(fs.readFileSync(f,"utf8"));s.subagents??={};s.subagents.agentOverrides??={};s.subagents.agentOverrides["kit.reviewer"]={...s.subagents.agentOverrides["kit.reviewer"],model:process.argv[2]};fs.writeFileSync(f,JSON.stringify(s,null,2)+"\n")' "$AGENT_DIR/settings.json" "$REVIEWER"
	fi
else
	echo "reminder: pin the reviewer to another provider: scripts/install.sh --reviewer-model <provider>/<model-id>"
fi

# 5. Compact panels: seed pi-subagents' and rpiv-todo's config with the kit's quieter defaults
# (config/), only where no config file exists yet. An existing config is never changed.
# seed <kit file> <target> [other path the package also reads]
seed() {
	local f
	for f in "$2" ${3:+"$3"}; do [ -e "$f" ] && { echo "kept: $f exists (kit defaults are in $1)"; return; }; done
	if [ "$DRY" = 1 ]; then echo "would seed $2 from $1"
	else mkdir -p "$(dirname "$2")" && cp "$1" "$2" && echo "seeded $2 from $1"; fi
}
seed "$KIT/config/subagent.json" "$AGENT_DIR/extensions/subagent/config.json"
# rpiv-todo reads $XDG_CONFIG_HOME (absolute paths only), falling back to ~/.config.
XDG="${XDG_CONFIG_HOME:-}"; case "$XDG" in /*) ;; *) XDG="$HOME/.config" ;; esac
seed "$KIT/config/rpiv-todo.json" "$XDG/rpiv-todo/config.json" "$HOME/.config/rpiv-todo/config.json"
echo "done. Next: test/typecheck.sh, test/smoke.sh, then the manual checks in SETUP.md."
