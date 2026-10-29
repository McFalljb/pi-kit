#!/usr/bin/env bash
# Idempotent pi-kit install: checks prerequisites, installs the pinned packages from packages.json
# and the kit itself with `pi install`, merges the kit's AGENTS.md into the global one (backup
# first, append missing sections only) and optionally pins the reviewer model.
# Never reads credential files and never runs /login. See SETUP.md.
#
# Usage: scripts/install.sh [--optional name,name] [--reviewer-model provider/id] [--dry-run]
set -euo pipefail
KIT="$(cd "$(dirname "$0")/.." && pwd)"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
OPTIONAL="" REVIEWER="" DRY=0
while [ $# -gt 0 ]; do
	case "$1" in
		--optional) OPTIONAL="$2"; shift 2 ;;
		--reviewer-model) REVIEWER="$2"; shift 2 ;;
		--dry-run) DRY=1; shift ;;
		*) echo "unknown argument: $1" >&2; exit 2 ;;
	esac
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

# 3. AGENTS.md: copy if missing; otherwise back up and append each "## " section whose heading
# is not already there. Re-running appends nothing.
GLOBAL="$AGENT_DIR/AGENTS.md"
if [ ! -f "$GLOBAL" ]; then
	echo "creating $GLOBAL"
	run cp "$KIT/AGENTS.md" "$GLOBAL"
else
	MISSING="$(node - "$KIT/AGENTS.md" "$GLOBAL" <<'JS'
const fs = require("fs");
const [kit, global] = process.argv.slice(2).map((f) => fs.readFileSync(f, "utf8"));
const have = new Set(global.split("\n").filter((l) => l.startsWith("## ")).map((l) => l.trim()));
const sections = kit.split(/^(?=## )/m).slice(1);
process.stdout.write(sections.filter((s) => !have.has(s.split("\n")[0].trim())).join(""));
JS
)"
	if [ -n "$MISSING" ]; then
		BACKUP="$GLOBAL.bak.$(date +%Y%m%d%H%M%S)"
		echo "appending $(grep -c '^## ' <<< "$MISSING") kit section(s) to $GLOBAL (backup: $BACKUP):"
		grep '^## ' <<< "$MISSING" | sed 's/^/  /'
		if [ "$DRY" = 0 ]; then cp "$GLOBAL" "$BACKUP"; printf '\n%s' "$MISSING" >> "$GLOBAL"; fi
	else
		echo "ok: $GLOBAL already has every kit section"
	fi
fi

# 4. Reviewer model override (subagents.agentOverrides["kit.reviewer"].model)
if [ -n "$REVIEWER" ]; then
	echo "pinning kit.reviewer to $REVIEWER"
	if [ "$DRY" = 0 ]; then
		cp "$AGENT_DIR/settings.json" "$AGENT_DIR/settings.json.bak.$(date +%Y%m%d%H%M%S)"
		node -e 'const fs=require("fs"),f=process.argv[1],s=JSON.parse(fs.readFileSync(f,"utf8"));s.subagents??={};s.subagents.agentOverrides??={};s.subagents.agentOverrides["kit.reviewer"]={...s.subagents.agentOverrides["kit.reviewer"],model:process.argv[2]};fs.writeFileSync(f,JSON.stringify(s,null,2)+"\n")' "$AGENT_DIR/settings.json" "$REVIEWER"
	fi
else
	echo "reminder: pin the reviewer to another provider: scripts/install.sh --reviewer-model <provider>/<model-id>"
fi
echo "done. Next: test/typecheck.sh, test/smoke.sh, then the manual checks in SETUP.md."
