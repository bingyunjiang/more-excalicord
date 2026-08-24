#!/bin/zsh
set -euo pipefail

BASE_URL="http://127.0.0.1:5002/v1"
HEALTH=$(curl --fail --silent --retry 20 --retry-connrefused --retry-delay 1 "$BASE_URL/health")
TOKEN=$(printf '%s' "$HEALTH" | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')

printf '%s' "$HEALTH" | /usr/bin/python3 -c '
import json, sys
d = json.load(sys.stdin)
assert d["ok"] is True
assert d["protocolVersion"] == 1
assert d["platform"] == "macos"
assert "display" in d["capabilities"]
assert "desktop-icons" in d["capabilities"]
'

UNAUTHORIZED=$(curl --silent --output /dev/null --write-out '%{http_code}' "$BASE_URL/status")
test "$UNAUTHORIZED" = "403"

curl --fail --silent \
  -H "X-Excalicord-Token: $TOKEN" \
  "$BASE_URL/status" \
  | /usr/bin/python3 -c '
import json, sys
d = json.load(sys.stdin)
assert d["ok"] is True
assert d["state"] in {"idle", "recording", "paused"}
'

curl --fail --silent \
  -H "X-Excalicord-Token: $TOKEN" \
  "$BASE_URL/desktop-icons" \
  | /usr/bin/python3 -c '
import json, sys
d = json.load(sys.stdin)
assert d["ok"] is True
assert isinstance(d["hidden"], bool)
assert isinstance(d["managedByRecording"], bool)
'

echo "capture-agent smoke test passed"
