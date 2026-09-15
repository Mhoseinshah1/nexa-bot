#!/usr/bin/env bash
# Does the subscription Nexa hands the customer actually carry traffic?
#
# `tests/acceptance/real-panel-sanaei.test.ts` A4 proves the subscription
# listener serves a config carrying this client's own UUID and the inbound's
# port. That is a strong check and it is still not the question the customer is
# asking. A config can name the right UUID and the right port and not connect —
# a flow the inbound refuses, a `limitIp` it does not support, an inbound the
# panel accepted and Xray will not serve. Each produces a service that looks
# provisioned and does not work, which is the shape of most of the legacy
# failures in `docs/research/`.
#
# So this connects. It takes a `subId` that Nexa provisioned, fetches the
# subscription the CUSTOMER would fetch, builds an xray-core client from the
# `vless://` URI in it and nothing else, and moves bytes through it to an origin
# that only exists for the run.
#
# ## Why a script and not an acceptance case
#
# It was written as `tests/acceptance/real-panel-usable.test.ts` first and that
# file did not work: an xray client spawned from inside the vitest worker failed
# every request with `proxy/http: failed to read response ... unexpected EOF`,
# while THE SAME GENERATED CONFIG FILE run from a shell moved bytes fine. It was
# bisected far enough to rule out the account (a known-good UUID failed the same
# way), the origin (a separate-process origin failed the same way), the upstream
# address, the port, the panel's xray reload and a stale listener on the client
# port. The cause is not known.
#
# Shipping that as a test would have been shipping a red suite; claiming it
# passed would have been worse. So the proof lives here, where it runs, and
# `docs/real-panel-acceptance.md` says exactly this.
#
# Usage:
#   scripts/real-panel-tunnel-check.sh <sub-id> [expected-uuid]
#
# Environment (same names the acceptance suite uses):
#   NEXA_ACCEPTANCE_SUB_URL    the subscription listener, e.g. http://127.0.0.2:2096/
#   NEXA_ACCEPTANCE_XRAY_BIN   a real xray-core binary
#   NEXA_ACCEPTANCE_PANEL_HOST host to dial the inbound on (default: the sub URL's host)
set -euo pipefail

SUB_ID="${1:-}"
EXPECT_UUID="${2:-}"
if [ -z "$SUB_ID" ]; then
    echo "usage: $0 <sub-id> [expected-uuid]" >&2
    exit 2
fi
: "${NEXA_ACCEPTANCE_SUB_URL:?set it to the subscription listener of the panel}"
: "${NEXA_ACCEPTANCE_XRAY_BIN:?set it to a real xray-core binary}"

WORK="$(mktemp -d)"
ORIGIN_HOST=127.0.0.3
ORIGIN_PORT=18099
PROXY_PORT=11099
PAYLOAD="nexa-tunnel-check-$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n')"
ORIGIN_PID=""
XRAY_PID=""

cleanup() {
    [ -n "$XRAY_PID" ] && kill "$XRAY_PID" 2> /dev/null || true
    [ -n "$ORIGIN_PID" ] && kill "$ORIGIN_PID" 2> /dev/null || true
    rm -rf "$WORK"
}
trap cleanup EXIT

# 1. An origin that exists only for this run, carrying a payload a coincidence
#    could not produce.
mkdir -p "$WORK/origin"
printf '%s' "$PAYLOAD" > "$WORK/origin/payload.txt"
# `exec`, so that $! is python's own pid. Without it the subshell is what gets
# recorded, `kill` reaps the subshell, and python keeps the port — which made
# the second run of this script fail its own direct-control check.
(cd "$WORK/origin" && exec python3 -m http.server "$ORIGIN_PORT" --bind "$ORIGIN_HOST" > "$WORK/origin.log" 2>&1) &
ORIGIN_PID=$!
sleep 2

# The control. Without it a failure through the tunnel cannot be told apart from
# a broken origin.
DIRECT=$(curl -sS --noproxy '*' --max-time 8 "http://$ORIGIN_HOST:$ORIGIN_PORT/payload.txt")
if [ "$DIRECT" != "$PAYLOAD" ]; then
    echo "FAIL: the origin does not answer directly; nothing below would mean anything" >&2
    exit 1
fi
echo "ok    the origin answers directly"

# 2. The subscription, as the customer fetches it.
SUB_BASE="${NEXA_ACCEPTANCE_SUB_URL%/}"
curl -sS --noproxy '*' --max-time 15 "$SUB_BASE/sub/$SUB_ID" > "$WORK/sub.b64"
base64 -d < "$WORK/sub.b64" > "$WORK/sub.txt" 2> /dev/null || {
    echo "FAIL: the subscription body is not base64" >&2
    exit 1
}
LINK=$(head -n 1 "$WORK/sub.txt")
case "$LINK" in
    vless://*) ;;
    *)
        echo "FAIL: the subscription served no vless link: $LINK" >&2
        exit 1
        ;;
esac
echo "ok    the subscription serves a vless link"

# 3. The client, built from the LINK and nothing this script already knows.
PANEL_HOST="${NEXA_ACCEPTANCE_PANEL_HOST:-$(printf '%s' "$SUB_BASE" | sed -E 's#^[a-z]+://([^:/]+).*#\1#')}"
python3 - "$LINK" "$PANEL_HOST" "$PROXY_PORT" "$WORK" <<'PY'
import json, sys
from urllib.parse import urlsplit, parse_qs

link, panel_host, proxy_port, work = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
parts = urlsplit(link)
params = parse_qs(parts.query)
# The UUID is written beside the config so the shell can compare it without
# having to quote a python expression full of brackets, which shellcheck cannot
# parse and therefore cannot check the rest of the file past.
with open(work + "/uuid.txt", "w") as handle:
    handle.write(parts.username or "")
with open(work + "/client.json", "w") as handle:
    handle.write(json.dumps({
    "log": {"loglevel": "warning"},
    "inbounds": [{
        "tag": "proxy-in", "listen": "127.0.0.1", "port": proxy_port,
        "protocol": "http", "settings": {},
    }],
    "outbounds": [{
        "tag": "proxy", "protocol": "vless",
        "settings": {"vnext": [{
            # The credential comes from the link; the ADDRESS comes from the
            # panel, because a disposable panel advertises a name this host may
            # not resolve the same way. The split that matters is that a
            # customer who can reach the host authenticates with what they were
            # given.
            "address": panel_host,
            "port": parts.port,
            "users": [{
                "id": parts.username,
                "encryption": "none",
                "flow": (params.get("flow") or [""])[0],
            }],
        }]},
        "streamSettings": {
            "network": (params.get("type") or ["tcp"])[0],
            "security": (params.get("security") or ["none"])[0],
        },
    }],
    }))
PY

if [ -n "$EXPECT_UUID" ]; then
    GOT=$(cat "$WORK/uuid.txt")
    if [ "$GOT" != "$EXPECT_UUID" ]; then
        echo "FAIL: the served link carries $GOT, not the provisioned $EXPECT_UUID" >&2
        exit 1
    fi
    echo "ok    the link carries the UUID Nexa provisioned"
fi

"$NEXA_ACCEPTANCE_XRAY_BIN" run -c "$WORK/client.json" > "$WORK/xray.log" 2>&1 &
XRAY_PID=$!
sleep 3

# 4. The bytes. Retried, because 3X-UI defers its xray reload to a cron at
#    `@every 30s` (`cadenceXrayRestart` in internal/web/web.go) and an account
#    created moments ago is not in the running config yet. A customer meets the
#    same window.
DEADLINE=$(($(date +%s) + 120))
while :; do
    THROUGH=$(curl -sS --max-time 15 --proxy "http://127.0.0.1:$PROXY_PORT" \
        "http://$ORIGIN_HOST:$ORIGIN_PORT/payload.txt" 2> /dev/null || true)
    if [ "$THROUGH" = "$PAYLOAD" ]; then
        echo "ok    the tunnel carried the payload for this run, end to end"
        exit 0
    fi
    if [ "$(date +%s)" -ge "$DEADLINE" ]; then
        echo "FAIL: the tunnel never carried the payload; last answer: ${THROUGH:-<empty>}" >&2
        tail -20 "$WORK/xray.log" >&2
        exit 1
    fi
    sleep 3
done
