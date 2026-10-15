#!/bin/bash
# Capture the measurement context for one wave3 bench artifact:
# gate, live daemon block, engine hashes, machine, and the artifact's own hash.
# Usage: capture-meta.sh <artifact.json> <meta-target.json>
set -euo pipefail
ART="$1"; META="${2:-$1.meta.json}"
SOCKET="$HOME/Library/Application Support/UltraSearch/ultrasearch.sock"
POW=$(pmset -g batt | head -1 | sed -n "s/Now drawing from '\([^']*\)'.*/\1/p")
L=$(sysctl -n vm.loadavg | awk '{print $2}')
STATUS=$(printf '{"op":"status","id":1}\n' | nc -U "$SOCKET" 2>/dev/null || echo '{"ok":false}')
OWNERS=$(lsof -t "$SOCKET" 2>/dev/null | tr '\n' ',' || true)
ART_SHA=$(shasum -a 256 "$ART" | awk '{print $1}')
BIN_SHA=$(shasum -a 256 "$HOME/.local/bin/ultrasearch-daemon" | awk '{print $1}')
APP_SHA=$(shasum -a 256 /Applications/UltraSearch.app/Contents/MacOS/UltraSearch | awk '{print $1}')
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
BUILT="$ROOT/engine/target/release/ultrasearch"
BUILT_SHA=$(shasum -a 256 "$BUILT" | awk '{print $1}')
# codesign rewrites the file, so hashes differ; the Mach-O LC_UUID is the code identity.
uuid() { otool -l "$1" 2>/dev/null | grep -A2 LC_UUID | grep uuid | awk '{print $2}' | head -1; }
BUILT_UUID=$(uuid "$BUILT"); BIN_UUID=$(uuid "$HOME/.local/bin/ultrasearch-daemon"); APP_UUID=$(uuid /Applications/UltraSearch.app/Contents/MacOS/UltraSearch)
export ART META POW L STATUS OWNERS ART_SHA BIN_SHA APP_SHA BUILT_SHA BUILT_UUID BIN_UUID APP_UUID
python3 - <<'PY'
import json, os
s = json.loads(os.environ["STATUS"]) if os.environ["STATUS"].strip() else {}
meta = {
  "capturedAt": __import__("datetime").datetime.utcnow().isoformat() + "Z",
  "artifact": os.path.abspath(os.environ["ART"]),
  "artifactSha256": os.environ["ART_SHA"],
  "machine": {
    "hostname": __import__("socket").gethostname(),
    "model": __import__("subprocess").check_output(["sysctl","-n","hw.model"]).decode().strip(),
    "cpu": __import__("subprocess").check_output(["sysctl","-n","machdep.cpu.brand_string"]).decode().strip(),
    "power": os.environ["POW"],
    "load1": float(os.environ["L"]),
  },
  "engine": {
    "builtSha256": os.environ["BUILT_SHA"],
    "installedLocalBinSha256Signed": os.environ["BIN_SHA"],
    "installedAppBundleSha256Signed": os.environ["APP_SHA"],
    "machOUuidBuilt": os.environ["BUILT_UUID"],
    "machOUuidLocalBin": os.environ["BIN_UUID"],
    "machOUuidAppBundle": os.environ["APP_UUID"],
    "sameCode": os.environ["BUILT_UUID"] != "" and os.environ["BUILT_UUID"] == os.environ["BIN_UUID"] == os.environ["APP_UUID"],
    "note": "codesign rewrites the Mach-O signature, so file hashes differ from the unsigned build; LC_UUID identifies the code",
  },
  "daemon": {
    "socketOwnerPids": [int(x) for x in os.environ["OWNERS"].split(",") if x.strip()],
    "pid": s.get("pid"), "entries": s.get("entries"), "event_id": s.get("event_id"),
    "content_docs": s.get("content_docs"), "socket_ino": s.get("socket_ino"),
    "lock_pid": s.get("lock_pid"), "uptime_ms": s.get("uptime_ms"),
    "replay_in_progress": s.get("replay_in_progress"), "staleness_ms": s.get("staleness_ms"),
  },
}
json.dump(meta, open(os.environ["META"], "w"), indent=2)
print(os.environ["META"], "written; engine sameCode =", meta["engine"]["sameCode"], "; daemon pid =", meta["daemon"]["pid"], "; entries =", meta["daemon"]["entries"])
PY
