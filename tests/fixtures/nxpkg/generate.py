"""Regenerate the SYNTHETIC cross-language `.nxpkg` fixtures in this directory.

Run with a checkout of Mhoseinshah1/mirza-to-nexa (the converter) that writes content contract
1.4.0 with the source snapshot (0.6.0+, branch claude/nxpkg-source-snapshot at the time of writing):

    PYTHONPATH=<mirza-to-nexa>/src <mirza-to-nexa>/.venv/bin/python -I generate.py <this dir>
    pnpm exec prettier --write tests/fixtures/nxpkg/   # whitespace only; JSON values unchanged

Everything is produced by `mirza2nexa.synth` (a generated, fictional Mirza backup) — no
real backup, customer, key or password is involved. See README.md.
"""

import base64
import hashlib
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

out = Path(sys.argv[1]).resolve()
work = Path(tempfile.mkdtemp(prefix="nxpkg-fixture-"))
os.environ["MIRZA2NEXA_HOME"] = str(work / "apphome")

from mirza2nexa import __version__  # noqa: E402
from mirza2nexa import ownership_review as orv  # noqa: E402
from mirza2nexa.archive import ArchiveLimits  # noqa: E402
from mirza2nexa.nxpkg.canonical import canonical_json  # noqa: E402
from mirza2nexa.nxpkg.crypto import read_header_from  # noqa: E402
from mirza2nexa.nxpkg.reader import PackageReader  # noqa: E402
from mirza2nexa.pipeline import ConvertOptions, convert_archive  # noqa: E402
from mirza2nexa.synth import SynthSpec, write_zip  # noqa: E402

PASSPHRASE = "synthetic-test-passphrase-ŞÉ"  # NFC; the TS test also feeds the NFD form

zp = work / "synthetic-backup.zip"
write_zip(zp, SynthSpec(users=20, seed=7))


def convert(name, **kw):
    ws = work / name
    ws.mkdir()
    return convert_archive(zp, ws, ConvertOptions(kdf_n=2**10, money_unit="toman", limits=ArchiveLimits(),
                                                  created_at="2026-10-10T00:00:00Z", **kw))


res = convert("ws-key")
res_pp = convert("ws-pp", package_passphrase=PASSPHRASE)
shutil.copy(res.package_path, out / "synthetic-keyfile.nxpkg")
shutil.copy(res_pp.package_path, out / "synthetic-passphrase.nxpkg")
(out / "synthetic-keyfile.nxkey").write_text(res.key_text + "\n", encoding="ascii")

# Ownership decisions: approve the attestable services, seal, export, sign (docs/OWNERSHIP_REVIEW.md §6).
stage = res.stage_dir
recs = [json.loads(line) for line in open(stage / "records" / "service_ownership.jsonl", encoding="utf-8")
        if line.strip()]
store = orv.ReviewStore.for_import(work / "reviews", res.report["import_id"], res.report["source_fingerprint"])
store.sync(recs, orv.load_invoice_index(stage))
plan = store.plan("APPROVE", {"mode": "filter", "filter": {"eligibility": "ATTESTABLE"}})
if plan["applicable"]:
    store.commit(plan["plan_id"], confirm_count=plan["applicable"], acknowledge=True)
store.seal(confirm="SEAL", confirm_count=store.summary()["totals"]["items"])


def header_sha(path):
    with open(path, "rb") as fh:
        _, hb = read_header_from(fh)
    return hashlib.sha256(hb).hexdigest()


key = orv.decisions_key(res.package_path, key_text=res.key_text)
doc = orv.sign_export(store.export_document(source_fingerprint=res.report["source_fingerprint"],
                                            package_header_sha256=header_sha(res.package_path)), key)
assert orv.verify_export(doc, key)
# Exactly as the converter's HTTP export writes it (ownership_api._export).
(out / "ownership-decisions.json").write_bytes(
    (json.dumps(doc, ensure_ascii=False, indent=1, sort_keys=True) + "\n").encode("utf-8"))
store.close()


def facts(path, **secret):
    r = PackageReader(path, workdir=work / ("wd-" + path.stem), **secret)
    rep = r.verify()
    record_digests = {}
    for rel, entry in sorted(rep.files.items()):
        if rel.endswith(".jsonl"):
            h = hashlib.sha256()
            for rec in r.iter_jsonl(rel):
                h.update(canonical_json(rec) + b"\n")
            record_digests[rel] = h.hexdigest()
    r.cleanup()
    assert rep.manifest["package_schema_version"] == "1.4.0", rep.manifest["package_schema_version"]
    for rel in ("source/catalog.json", "source/tables/user.jsonl", "source/tables/invoice.jsonl",
                "source/tables/product.jsonl"):
        assert rel in rep.files, rel
    return {
        "header_sha256": header_sha(path),
        "file_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "payload_sha256": rep.payload_sha256,
        "payload_size": rep.payload_size,
        "chunks": rep.chunks,
        "import_id": rep.import_id,
        "source_fingerprint": rep.source_fingerprint,
        "package_schema_version": rep.manifest["package_schema_version"],
        "files": rep.files,
        "jsonl_canonical_digests": record_digests,
    }


pp_key = orv.decisions_key(res_pp.package_path, passphrase=PASSPHRASE)

# Canonical JSON vectors: the TS canonicalJson must reproduce these bytes exactly.
vectors_in = [
    {"b": 1, "a": [True, False, None], "é": "é", "Z": -0, "big": 9007199254740991},
    {"ctl": "\x00\x01\x08\x09\x0a\x0b\x0c\x0d\x1f\x7f", "q": "\"\\/", "ls": "  ", "bom": "﻿"},
    {"\U0001f600": 1, "￿": 2, "": 3, "퟿": 4, "a": {"z": [], "y": {}}},
    ["میرزا", "\U0010ffff", "", -12345678901234],
    "plain",
    0,
]
vectors = [{"input_b64": base64.b64encode(json.dumps(v, ensure_ascii=True).encode()).decode(),
            "canonical_b64": base64.b64encode(canonical_json(v)).decode()} for v in vectors_in]

expected = {
    "synthetic": True,
    "generator": {"converter": "mirza2nexa", "version": __version__, "spec": {"users": 20, "seed": 7},
                  "kdf_n": 2**10, "money_unit": "toman"},
    "passphrase": PASSPHRASE,
    "keyfile": facts(out / "synthetic-keyfile.nxpkg", key=res.key_text),
    "passphrase_package": facts(out / "synthetic-passphrase.nxpkg", passphrase=PASSPHRASE),
    "decisions_key_hex": key.hex(),
    "passphrase_decisions_key_hex": pp_key.hex(),
    "decisions_summary": doc["summary"],
    "canonical_vectors": vectors,
}
(out / "expected.json").write_text(json.dumps(expected, ensure_ascii=True, indent=1, sort_keys=True) + "\n",
                                   encoding="ascii")
shutil.rmtree(work)
print("ok", out)
