#!/usr/bin/env bash
# Stand-in for `drizzle-kit generate --name <name>` (RENUMBER_GENERATE_CMD).
# Writes the next-numbered SQL (the bytes of $FAKE_SQL_SRC/*_<name>.sql, plus
# $FAKE_SQL_EXTRA when set), a snapshot and a journal entry, like the real tool.
set -euo pipefail
name="$1"
d=apps/api/drizzle
src="$(find "$FAKE_SQL_SRC" -name "*_${name}.sql" -print -quit)"
[ -n "$src" ] || { echo "fake-generate: no source SQL for $name" >&2; exit 1; }
node -e '
const fs = require("fs");
const [d, name, src, extra] = process.argv.slice(1);
const f = d + "/meta/_journal.json";
const raw = fs.readFileSync(f, "utf8");
const j = JSON.parse(raw);
const last = j.entries[j.entries.length - 1];
const idx = last.idx + 1;
const num = String(idx).padStart(4, "0");
const tag = num + "_" + name;
fs.writeFileSync(d + "/" + tag + ".sql", Buffer.concat([fs.readFileSync(src), Buffer.from(extra)]));
const prev = JSON.parse(fs.readFileSync(d + "/meta/" + String(last.idx).padStart(4, "0") + "_snapshot.json", "utf8"));
fs.writeFileSync(d + "/meta/" + num + "_snapshot.json",
  JSON.stringify({ id: "11111111-1111-4111-8111-" + num.padStart(12, "0"), prevId: prev.id, version: "7", dialect: "postgresql", tables: {} }, null, 2));
j.entries.push({ idx, version: "7", when: Math.max(Date.now(), last.when + 1), tag, breakpoints: true });
fs.writeFileSync(f, JSON.stringify(j, null, 2) + (raw.endsWith("\n") ? "\n" : ""));
' "$d" "$name" "$src" "${FAKE_SQL_EXTRA:-}"
