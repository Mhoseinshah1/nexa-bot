#!/usr/bin/env bash
# Does suspending a Marzban account actually stop it carrying traffic, and does
# the account beside it keep carrying traffic?
#
# `tests/acceptance/real-panel-marzban.test.ts` A3-A5 prove the panel's OWN
# record changes: A goes `disabled`, B stays `active`, A is deleted and B is
# still there. That is the control plane, and it is not the question a customer
# asks. A panel can report `disabled` and keep serving the account — the status
# is a database row, and removing the user from the running Xray core is a
# separate background task that can fail silently.
#
# So this connects. It builds an xray-core client from the two accounts' own
# UUIDs plus a third UUID the panel has never held, moves bytes through each to
# an origin that only exists for the run, and prints what was served at every
# step of the lifecycle.
#
# ## The control is the point
#
# The third outbound is the whole reason to trust the other two. This check was
# written twice before it measured anything:
#
#   1. `no_proxy` in the environment covers 127.0.0.0/8, so `curl -x ...`
#      ignored the proxy and fetched the origin directly. EVERY account read as
#      served, including the one that never existed. `--noproxy ''` is what
#      makes `-x` authoritative, and it is why this script passes it everywhere.
#   2. Xray 26.x's `freedom` outbound blocks private destinations by default, so
#      once the first bug was fixed every account read as NOT served —
#      `proxy/freedom: blocked target: ..., blackholing connection` in the
#      panel's xray error log. The panel's DIRECT outbound needs
#      `settings.finalRules: [{"action":"allow","ip":["127.0.0.0/8"]}]` for a
#      loopback origin. `docs/real-panel-acceptance.md` says so.
#
# A checker with its own bug reports the subject as broken, or worse, as fine.
# If the control line ever reads SERVED, this script is measuring nothing and
# its other two lines mean nothing.
#
# Usage:
#   scripts/marzban-lifecycle-check.sh
#
# Environment (the acceptance suite's own names, plus three for the tunnel):
#   NEXA_ACCEPTANCE_MARZBAN_URL          the panel, e.g. http://127.0.0.1:8000/
#   NEXA_ACCEPTANCE_MARZBAN_USERNAME     a disposable sudo admin
#   NEXA_ACCEPTANCE_MARZBAN_PASSWORD
#   NEXA_ACCEPTANCE_MARZBAN_PROTOCOL     e.g. vless
#   NEXA_ACCEPTANCE_MARZBAN_INBOUND_TAG  e.g. "VLESS TCP"
#   NEXA_ACCEPTANCE_MARZBAN_INBOUND      host:port the inbound listens on
#   NEXA_ACCEPTANCE_XRAY_BIN             a real xray-core binary
#   NEXA_ACCEPTANCE_ORIGIN               host:port for the throwaway origin
#                                        (default 127.0.0.4:9111)
set -euo pipefail

: "${NEXA_ACCEPTANCE_MARZBAN_URL:?the panel URL is required}"
: "${NEXA_ACCEPTANCE_MARZBAN_USERNAME:?a disposable admin username is required}"
: "${NEXA_ACCEPTANCE_MARZBAN_PASSWORD:?the disposable admin password is required}"
: "${NEXA_ACCEPTANCE_MARZBAN_PROTOCOL:?the proxy protocol is required}"
: "${NEXA_ACCEPTANCE_MARZBAN_INBOUND_TAG:?the inbound tag is required}"
: "${NEXA_ACCEPTANCE_MARZBAN_INBOUND:?host:port of the inbound is required}"
: "${NEXA_ACCEPTANCE_XRAY_BIN:?a real xray-core binary is required}"
ORIGIN="${NEXA_ACCEPTANCE_ORIGIN:-127.0.0.4:9111}"

PANEL="${NEXA_ACCEPTANCE_MARZBAN_URL%/}"
PROTOCOL="$NEXA_ACCEPTANCE_MARZBAN_PROTOCOL"
TAG="$NEXA_ACCEPTANCE_MARZBAN_INBOUND_TAG"
INBOUND_HOST="${NEXA_ACCEPTANCE_MARZBAN_INBOUND%%:*}"
INBOUND_PORT="${NEXA_ACCEPTANCE_MARZBAN_INBOUND##*:}"
ORIGIN_HOST="${ORIGIN%%:*}"
ORIGIN_PORT="${ORIGIN##*:}"

WORK="$(mktemp -d)"
RUN="lc$(date +%s)"
A="nxlc_${RUN}_a"
B="nxlc_${RUN}_b"
PORT_A=10811
PORT_B=10812
PORT_CONTROL=10813

cleanup() {
    local status=$?
    if [ -n "${CLIENT_PID:-}" ]; then kill "$CLIENT_PID" 2>/dev/null || true; fi
    if [ -n "${ORIGIN_PID:-}" ]; then kill "$ORIGIN_PID" 2>/dev/null || true; fi
    if [ -n "${TOKEN:-}" ]; then
        for name in "$A" "$B"; do
            curl -sS --noproxy '*' -o /dev/null -X DELETE \
                "$PANEL/api/user/$name" -H "Authorization: Bearer $TOKEN" || true
        done
    fi
    rm -rf "$WORK"
    exit "$status"
}
trap cleanup EXIT

# A token, on its own, never in argv.
TOKEN="$(
    curl -sS --noproxy '*' -X POST "$PANEL/api/admin/token" \
        -H 'Content-Type: application/x-www-form-urlencoded' \
        --data-urlencode "username=$NEXA_ACCEPTANCE_MARZBAN_USERNAME" \
        --data-urlencode "password=$NEXA_ACCEPTANCE_MARZBAN_PASSWORD" \
        --data-urlencode 'grant_type=password' |
        python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])'
)"
[ -n "$TOKEN" ] || { echo "could not authenticate against $PANEL" >&2; exit 1; }

api() { # method path [json-body]
    local method="$1" path="$2" body="${3:-}"
    if [ -n "$body" ]; then
        curl -sS --noproxy '*' -o "$WORK/out" -w '%{http_code}' -X "$method" \
            "$PANEL/$path" -H "Authorization: Bearer $TOKEN" \
            -H 'Content-Type: application/json' -d "$body"
    else
        curl -sS --noproxy '*' -o "$WORK/out" -w '%{http_code}' -X "$method" \
            "$PANEL/$path" -H "Authorization: Bearer $TOKEN"
    fi
}

create() { # username -> prints the proxy uuid
    local name="$1" payload
    payload="$(
        PROTOCOL="$PROTOCOL" TAG="$TAG" NAME="$name" python3 - <<'PY'
import json, os
protocol = os.environ['PROTOCOL']
print(json.dumps({
    'username': os.environ['NAME'],
    'proxies': {protocol: {}},
    'inbounds': {protocol: [os.environ['TAG']]},
    'expire': 0,
    'data_limit': 0,
    'data_limit_reset_strategy': 'no_reset',
    'status': 'active',
}))
PY
    )"
    [ "$(api POST api/user "$payload")" = "200" ] ||
        { echo "creating $name failed: $(cat "$WORK/out")" >&2; exit 1; }
    PROTOCOL="$PROTOCOL" python3 -c \
        'import json,os,sys; print(json.load(open(sys.argv[1]))["proxies"][os.environ["PROTOCOL"]]["id"])' \
        "$WORK/out"
}

UUID_A="$(create "$A")"
UUID_B="$(create "$B")"
UUID_CONTROL="$(python3 -c 'import uuid; print(uuid.uuid4())')"

# The origin. Its own process, so nothing about the tunnel shares a runtime with it.
mkdir -p "$WORK/origin"
printf 'nexa-marzban-origin-ok\n' > "$WORK/origin/probe.txt"
(cd "$WORK/origin" && exec python3 -m http.server "$ORIGIN_PORT" --bind "$ORIGIN_HOST") \
    > "$WORK/origin.log" 2>&1 &
ORIGIN_PID=$!

# The client: one HTTP inbound per identity, routed to its own outbound, so the
# three are never confused for one another.
UUID_A="$UUID_A" UUID_B="$UUID_B" UUID_CONTROL="$UUID_CONTROL" \
PROTOCOL="$PROTOCOL" INBOUND_HOST="$INBOUND_HOST" INBOUND_PORT="$INBOUND_PORT" \
PORT_A="$PORT_A" PORT_B="$PORT_B" PORT_CONTROL="$PORT_CONTROL" \
    python3 - > "$WORK/client.json" <<'PY'
import json, os
identities = [('a', os.environ['UUID_A'], int(os.environ['PORT_A'])),
              ('b', os.environ['UUID_B'], int(os.environ['PORT_B'])),
              ('control', os.environ['UUID_CONTROL'], int(os.environ['PORT_CONTROL']))]
config = {'log': {'loglevel': 'warning'}, 'inbounds': [], 'outbounds': [], 'routing': {'rules': []}}
for name, identity, port in identities:
    config['inbounds'].append(
        {'tag': f'in-{name}', 'listen': '127.0.0.1', 'port': port, 'protocol': 'http', 'settings': {}})
    config['outbounds'].append({
        'tag': f'out-{name}', 'protocol': os.environ['PROTOCOL'],
        'settings': {'vnext': [{'address': os.environ['INBOUND_HOST'],
                                'port': int(os.environ['INBOUND_PORT']),
                                'users': [{'id': identity, 'encryption': 'none'}]}]},
        'streamSettings': {'network': 'tcp', 'security': 'none'}})
    config['routing']['rules'].append(
        {'type': 'field', 'inboundTag': [f'in-{name}'], 'outboundTag': f'out-{name}'})
print(json.dumps(config, indent=2))
PY

"$NEXA_ACCEPTANCE_XRAY_BIN" run -c "$WORK/client.json" > "$WORK/client.log" 2>&1 &
CLIENT_PID=$!
sleep 4

probe() { # port -> SERVED | NOT-SERVED
    local out
    # `--noproxy ''` overrides the environment's no_proxy, which otherwise covers
    # loopback and makes -x a no-op. See the header.
    out="$(curl -sS --max-time 10 --noproxy '' -x "http://127.0.0.1:$1" \
        "http://$ORIGIN/probe.txt" 2>/dev/null || true)"
    if [ "$out" = "nexa-marzban-origin-ok" ]; then echo -n "SERVED"; else echo -n "NOT-SERVED"; fi
}

state() { # username -> the panel's own word, or ABSENT
    api GET "api/user/$1" > /dev/null
    python3 -c 'import json,sys
try: print(json.load(open(sys.argv[1]))["status"])
except Exception: print("ABSENT")' "$WORK/out"
}

row() {
    printf '   panel A=%-8s B=%-8s | traffic A=%-10s B=%-10s control=%s\n' \
        "$(state "$A")" "$(state "$B")" \
        "$(probe "$PORT_A")" "$(probe "$PORT_B")" "$(probe "$PORT_CONTROL")"
}

echo "L0 baseline"; row
echo "L1 suspend A  -> HTTP $(api PUT "api/user/$A" '{"status":"disabled"}')"; sleep 3; row
echo "L2 resume  A  -> HTTP $(api PUT "api/user/$A" '{"status":"active"}')"; sleep 3; row
echo "L3 delete  A  -> HTTP $(api DELETE "api/user/$A")"; sleep 3; row
echo "L4 delete  A again -> HTTP $(api DELETE "api/user/$A") $(cat "$WORK/out")"

echo
echo "Read it as a table, not as four lines:"
echo "  control must be NOT-SERVED on every row, or nothing above was measured;"
echo "  B must be SERVED on every row, because nothing was ever asked of B;"
echo "  A must be SERVED, NOT-SERVED, SERVED, NOT-SERVED down the four rows."
