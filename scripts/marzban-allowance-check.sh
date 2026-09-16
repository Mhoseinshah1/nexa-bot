#!/usr/bin/env bash
# What does Marzban's modify route actually do to `expire` and `data_limit`?
#
# Phase 4F buys three things against an existing account — a renewal, extra
# traffic, extra time — and all three are the SAME upstream call: one
# `PUT /api/user/{username}` carrying an allowance. Every rule the phase rests
# on is a claim about what that call does, and `docs/real-panel-acceptance.md`
# records what a claim about a wire contract is worth when only a fake this
# repository wrote has ever agreed with it.
#
# So this measures. It is not the acceptance suite — it drives the panel with
# plain `curl`, sharing no code with the adapter, which is the point: the
# adapter is written FROM this table and must not be the thing that produces it.
#
# ## The two rows that decide the design
#
# Row 4 and row 6 are why this exists rather than a paragraph of reasoning.
#
#   - Raising `data_limit` on a `limited` account re-activates it AND keeps
#     `used_traffic`. So "extra traffic" is a larger total, never a cleared
#     counter, and `POST /api/user/{name}/reset` is not used anywhere in Nexa:
#     replayed after the customer has consumed more, it would destroy real
#     evidence of consumption.
#   - Neither field re-enables a `disabled` account. A commercial action on a
#     SUSPENDED service tops up an allowance and leaves it suspended, so nothing
#     may report the service as ACTIVE afterwards.
#
# Rows 5 and 7 are the pair that makes a renewal one call rather than two: time
# alone does not revive a `limited` account, so a renewal that buys both a
# period and an allowance has to send both or the customer pays and stays cut
# off.
#
# ## Forcing `limited` and `expired`
#
# Marzban puts an account into those states from its own background job, on its
# own schedule, which is not a thing a check can wait for. Rows 4, 5 and 7 write
# `used_traffic` and `status` straight into the panel's SQLite file to reach the
# starting state, and then measure the panel's OWN response to an ordinary API
# call from there. The write is the fixture; the measurement is the HTTP
# exchange. A panel whose database this script may write to is by definition the
# disposable one — `NEXA_ACCEPTANCE_MARZBAN_DB` has no default and the script
# refuses without it.
#
# Usage:
#   scripts/marzban-allowance-check.sh
#
# Environment (the acceptance suite's own names, plus the SQLite path):
#   NEXA_ACCEPTANCE_MARZBAN_URL          the panel, e.g. http://127.0.0.1:8000/
#   NEXA_ACCEPTANCE_MARZBAN_USERNAME     a disposable sudo admin
#   NEXA_ACCEPTANCE_MARZBAN_PASSWORD
#   NEXA_ACCEPTANCE_MARZBAN_PROTOCOL     e.g. vless
#   NEXA_ACCEPTANCE_MARZBAN_INBOUND_TAG  e.g. "VLESS TCP"
#   NEXA_ACCEPTANCE_MARZBAN_DB           the panel's SQLite file. DISPOSABLE.
set -euo pipefail

for var in NEXA_ACCEPTANCE_MARZBAN_URL NEXA_ACCEPTANCE_MARZBAN_USERNAME \
    NEXA_ACCEPTANCE_MARZBAN_PASSWORD NEXA_ACCEPTANCE_MARZBAN_PROTOCOL \
    NEXA_ACCEPTANCE_MARZBAN_INBOUND_TAG NEXA_ACCEPTANCE_MARZBAN_DB; do
    if [ -z "${!var:-}" ]; then
        echo "$var is required. This script measures a DISPOSABLE panel." >&2
        exit 2
    fi
done

BASE="${NEXA_ACCEPTANCE_MARZBAN_URL%/}/"
DB="$NEXA_ACCEPTANCE_MARZBAN_DB"
[ -f "$DB" ] || { echo "no such panel database: $DB" >&2; exit 2; }

# The password reaches curl through a file, never through argv: a process list
# is readable by every user on the host, and `docs/conventions.md` forbids it.
CREDS="$(mktemp)"
trap 'rm -f "$CREDS"' EXIT
printf 'username=%s&password=%s&grant_type=password' \
    "$NEXA_ACCEPTANCE_MARZBAN_USERNAME" "$NEXA_ACCEPTANCE_MARZBAN_PASSWORD" > "$CREDS"

TOKEN="$(curl -sS --noproxy '' -X POST "${BASE}api/admin/token" \
    --data-binary "@$CREDS" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])')"

STAMP="$(date -u +%s)"

# One line per exchange: the status, and the three fields every row is about.
say() {
    local label="$1" body="$2"
    LABEL="$label" python3 -c '
import json, os, sys
raw = sys.stdin.read()
try:
    b = json.loads(raw)
except Exception:
    b = None
if isinstance(b, dict) and "status" in b:
    print("  %-34s status=%-8s expire=%-12s data_limit=%-12s used=%s" % (
        os.environ["LABEL"], b.get("status"), b.get("expire"),
        b.get("data_limit"), b.get("used_traffic")))
else:
    print("  %-34s %s" % (os.environ["LABEL"], (raw or "")[:80]))
' <<< "$body"
}

api() {
    local method="$1" path="$2" payload="${3:-}"
    if [ -n "$payload" ]; then
        curl -sS --noproxy '' -X "$method" "${BASE}${path}" \
            -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
            -d "$payload"
    else
        curl -sS --noproxy '' -X "$method" "${BASE}${path}" \
            -H "Authorization: Bearer $TOKEN"
    fi
}

create() {
    local name="$1" expire="$2" limit="$3"
    NAME="$name" EXPIRE="$expire" LIMIT="$limit" \
    PROTOCOL="$NEXA_ACCEPTANCE_MARZBAN_PROTOCOL" TAG="$NEXA_ACCEPTANCE_MARZBAN_INBOUND_TAG" \
    python3 -c '
import json, os
print(json.dumps({
    "username": os.environ["NAME"],
    "proxies": {os.environ["PROTOCOL"]: {}},
    "inbounds": {os.environ["PROTOCOL"]: [os.environ["TAG"]]},
    "expire": int(os.environ["EXPIRE"]),
    "data_limit": int(os.environ["LIMIT"]),
    "status": "active",
}))'
}

# The fixture, not the measurement. See the header.
#
# Through python3's own `sqlite3` module rather than the `sqlite3` CLI, which is
# not installed on every host this is run from — and parameterised, so a name
# never reaches SQL as text.
force() {
    DB="$DB" NAME="$1" USED="$2" STATE="$3" python3 -c '
import os, sqlite3
db = sqlite3.connect(os.environ["DB"])
db.execute("UPDATE users SET used_traffic = ?, status = ? WHERE username = ?",
           (int(os.environ["USED"]), os.environ["STATE"], os.environ["NAME"]))
db.commit()
db.close()
'
}

A="alw1$STAMP"; B="alw2$STAMP"; C="alw3$STAMP"; D="alw4$STAMP"; E="alw5$STAMP"

echo "1  expire is set ABSOLUTELY, and an identical replay is a no-op"
say 'create'             "$(api POST api/user "$(create "$A" "$((STAMP + 3600))" 1000000000)")"
say 'PUT expire=+30d'    "$(api PUT "api/user/$A" "{\"expire\": $((STAMP + 2592000))}")"
say 'PUT expire=+30d again' "$(api PUT "api/user/$A" "{\"expire\": $((STAMP + 2592000))}")"

echo "2  data_limit is set ABSOLUTELY, and an identical replay is a no-op"
say 'PUT data_limit=5GB' "$(api PUT "api/user/$A" '{"data_limit": 5000000000}')"
say 'PUT data_limit=5GB again' "$(api PUT "api/user/$A" '{"data_limit": 5000000000}')"

echo "3  an omitted key is NO CHANGE, not a reset"
say 'PUT note only'      "$(api PUT "api/user/$A" '{"note": "x"}')"

echo "4  raising data_limit on a LIMITED account re-activates it and KEEPS used_traffic"
say 'create'             "$(api POST api/user "$(create "$B" "$((STAMP + 3600))" 1000000000)")"
force "$B" 1000000000 limited
say 'GET (forced limited)' "$(api GET "api/user/$B")"
say 'PUT data_limit=3GB' "$(api PUT "api/user/$B" '{"data_limit": 3000000000}')"

echo "5  extending expire ALONE does not revive a LIMITED account"
say 'create'             "$(api POST api/user "$(create "$C" "$((STAMP + 3600))" 1000000000)")"
force "$C" 1000000000 limited
say 'PUT expire=+30d'    "$(api PUT "api/user/$C" "{\"expire\": $((STAMP + 2592000))}")"

echo "6  neither field re-enables a DISABLED account"
say 'create'             "$(api POST api/user "$(create "$D" "$((STAMP + 3600))" 1000000000)")"
say 'PUT status=disabled' "$(api PUT "api/user/$D" '{"status": "disabled"}')"
say 'PUT expire=+30d'    "$(api PUT "api/user/$D" "{\"expire\": $((STAMP + 2592000))}")"
say 'PUT data_limit=9GB' "$(api PUT "api/user/$D" '{"data_limit": 9000000000}')"

echo "7  a renewal sending BOTH revives a LIMITED account"
say 'create'             "$(api POST api/user "$(create "$E" "$((STAMP + 3600))" 1000000000)")"
force "$E" 1000000000 limited
say 'PUT expire + data_limit' \
    "$(api PUT "api/user/$E" "{\"expire\": $((STAMP + 2592000)), \"data_limit\": 4000000000}")"

echo "8  zero means unlimited on a modify, exactly as on a create"
say 'PUT expire=0 limit=0' "$(api PUT "api/user/$A" '{"expire": 0, "data_limit": 0}')"

echo "9  a modify against an account the panel does not have is 404"
say 'PUT absent' "$(curl -sS --noproxy '' -o /dev/null -w 'HTTP %{http_code}' \
    -X PUT "${BASE}api/user/definitely-not-here" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d '{"expire": 0}')"

for name in "$A" "$B" "$C" "$D" "$E"; do
    curl -sS --noproxy '' -o /dev/null -X DELETE "${BASE}api/user/$name" \
        -H "Authorization: Bearer $TOKEN" || true
done
echo "done. accounts removed."
