#!/usr/bin/env bash
# Run on the Mac: copy results back, scrub host, user and paths, write RESULT.md.
set -euo pipefail
HOST=${HOST:-bench-server}
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST=${DEST:-./paperless-results}

read -r rhome rhost rfqdn ruser < <(ssh "$HOST" 'printf "%s %s %s %s\n" "$HOME" "$(hostname -s)" "$(hostname -f 2>/dev/null || hostname)" "$(id -un)"')
mkdir -p "$DEST/results"
rsync -a --delete "$HOST:packmem-paperless/results/" "$DEST/results/"

python3 -I - "$DEST/results" "$rhome" "$rhost" "$rfqdn" "$ruser" "$HOST" <<'EOF'
import re, sys
from pathlib import Path
root, home, host, fqdn, user, alias = sys.argv[1:]
subs = [(re.escape(home + "/packmem-paperless"), "$WORK"), (re.escape(home), "$HOME")]
for h in sorted({fqdn, host, alias}, key=len, reverse=True):
    if h:
        subs.append((r"(?<![\w.-])" + re.escape(h) + r"(?![\w-])", "linux-server"))
if user not in ("root", "paperless"):
    subs.append((r"(?<![\w-])" + re.escape(user) + r"(?![\w-])", "<user>"))
n = 0
for p in Path(root).rglob("*"):
    if not p.is_file():
        continue
    try:
        text = p.read_text()
    except UnicodeDecodeError:
        continue
    new = text
    for pat, rep in subs:
        new = re.sub(pat, rep, new, flags=re.I if rep == "linux-server" else 0)
    if new != text:
        p.write_text(new)
        n += 1
print(f"scrubbed {n} files")
EOF

python3 -I "$HERE/summarize.py" "$DEST/results" > "$DEST/RESULT.md"
echo "wrote $DEST/RESULT.md"

left=$(grep -rIl -e "$rhost" -e "$ruser" -e "$rhome" "$DEST/results" "$DEST/RESULT.md" 2>/dev/null || true)
if [[ -n "$left" ]]; then
  echo "WARNING: host, user or home still appears in:"; echo "$left"
fi
