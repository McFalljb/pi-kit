#!/usr/bin/env bash
# Type-check the extensions against the locally installed pi. Leaves no node_modules behind.
set -euo pipefail
KIT="$(cd "$(dirname "$0")/.." && pwd)"
PI_PKG="$(dirname "$(dirname "$(dirname "$(readlink -f "$(command -v pi)")")")")"   # .../pi-coding-agent
TMP="$(mktemp -d "${TMPDIR:-/tmp}/pi-kit-tc.XXXXXX")"
trap 'rm -rf "$KIT/node_modules" "$TMP"' EXIT
(cd "$TMP" && npm init -y >/dev/null && npm i --silent --ignore-scripts typescript@5.6.3 @types/node@22 >/dev/null)
mkdir -p "$KIT/node_modules/@earendil-works"
ln -s "$PI_PKG" "$KIT/node_modules/@earendil-works/pi-coding-agent"
# A global install nests pi's dependencies under it; a local one (test/ci) hoists them next to it.
dep() { if [ -e "$PI_PKG/node_modules/$1" ]; then echo "$PI_PKG/node_modules/$1"; else echo "$(dirname "$(dirname "$PI_PKG")")/$1"; fi; }
for d in pi-ai pi-agent-core pi-tui; do ln -s "$(dep "@earendil-works/$d")" "$KIT/node_modules/@earendil-works/$d"; done
ln -s "$(dep typebox)" "$KIT/node_modules/typebox"
ln -s "$TMP/node_modules/@types" "$KIT/node_modules/@types"
"$TMP/node_modules/.bin/tsc" -p "$KIT/tsconfig.json" && echo "typecheck OK against $(pi --version)"
