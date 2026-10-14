#!/usr/bin/env bash
# Adds per-line RTL/LTR to the OpenClaw Control UI chat (Arabic right-to-left, English left-to-right).
# Idempotent; run again after every OpenClaw update (updates replace the UI files).
#   ./apply.sh           install / re-install
#   ./apply.sh --remove  restore the original page
set -euo pipefail
HERE=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
UI=${OPENCLAW_UI:-$(npm root -g 2>/dev/null)/openclaw/dist/control-ui}
[[ -f $UI/index.html ]] || { echo "Control UI not found at $UI" >&2; exit 1; }
BK=$HOME/NovaOS/var/backups/openclaw-ui; mkdir -p "$BK"
VER=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("version","?"))' "$UI/../build-info.json" 2>/dev/null || echo "?")
TAG_JS='<script type="module" src="./assets/minis-bidi.js"></script>'
TAG_CSS='<link rel="stylesheet" href="./assets/minis-bidi.css">'
if [[ ${1:-} == --remove ]]; then
  sed -i '/minis-bidi\./d' "$UI/index.html"; rm -f "$UI/assets/minis-bidi.js" "$UI/assets/minis-bidi.css"; echo "removed"; exit 0
fi
if grep -q minis-bidi "$UI/index.html" && cmp -s "$HERE/minis-bidi.js" "$UI/assets/minis-bidi.js" && cmp -s "$HERE/minis-bidi.css" "$UI/assets/minis-bidi.css"; then exit 0; fi
grep -q minis-bidi "$UI/index.html" || cp -a "$UI/index.html" "$BK/index.html.$VER.$(date +%Y%m%d-%H%M%S)"
install -m 644 "$HERE/minis-bidi.js" "$HERE/minis-bidi.css" "$UI/assets/"
if ! grep -q 'minis-bidi' "$UI/index.html"; then
  python3 - "$UI/index.html" "$TAG_CSS" "$TAG_JS" <<'PY'
import sys
p,css,js=sys.argv[1:4]; s=open(p).read()
assert s.count('</head>')==1
s=s.replace('</head>', f'    {css}\n    {js}\n  </head>',1)
open(p,'w').write(s)
PY
fi
echo "OpenClaw $VER: per-line RTL/LTR installed"
