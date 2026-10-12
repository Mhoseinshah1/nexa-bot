# `.nxpkg` cross-language fixtures — SYNTHETIC ONLY

Everything in this directory was produced by the Mirza2Nexa converter
(`Mhoseinshah1/mirza-to-nexa`, Python, version 0.6.0 from branch
`claude/nxpkg-source-snapshot`: content contract **1.4.0**, with the source snapshot
`source/catalog.json` + `source/tables/{user,invoice,product}.jsonl`) from `mirza2nexa.synth` — a generated, fictional
Mirza backup of 20 users (seed 7). **No real backup, customer, Telegram id, panel, key or
password is in any of these files.** The key and passphrase below exist only to open these
fixtures and protect nothing.

| File                         | What it is                                                                                                                                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `synthetic-keyfile.nxpkg`    | package encrypted with a random key file (`kdf: raw-key`)                                                                                                                                                                       |
| `synthetic-keyfile.nxkey`    | that key file's text (`nxkey1:…`)                                                                                                                                                                                               |
| `synthetic-passphrase.nxpkg` | the same conversion encrypted with a passphrase (`scrypt`, N = 2^10 for speed)                                                                                                                                                  |
| `ownership-decisions.json`   | a sealed, HMAC-signed ownership-decisions export for `synthetic-keyfile.nxpkg` (`ownership_review.sign_export`)                                                                                                                 |
| `expected.json`              | what the Python reader saw: header/file/payload SHA-256, chunk count, every checksum entry, a digest of every JSONL file's records re-encoded canonically, both decisions keys, the passphrase, and canonical-JSON test vectors |
| `generate.py`                | the script that wrote all of the above                                                                                                                                                                                          |

`tests/unit/nxpkg-reader.test.ts` proves the TypeScript reader (`apps/api/src/infrastructure/nxpkg`)
opens both Python packages, derives the same decisions keys and verifies the Python
signature, and that `canonicalJson` reproduces the Python bytes for every vector.

The JSON files were passed through `prettier --write` after generation (whitespace only;
the HMAC is over canonical JSON of the parsed values, so it still verifies).

## The other direction (TS writer → Python reader)

CI has no Python, so that check was run once by hand when the writer was written
(2026-10-10, converter `0.4.x` and again with `0.6.0`, `PackageReader.verify()` + `iter_jsonl()` + `read_json()` on
packages from `tests/support/nxpkg/writer.ts`, raw-key and passphrase, plain and
`zip64: 'full'`): all opened and verified. Re-run it after changing the writer or the
reader's crypto.

## Regenerating

With a converter checkout that writes contract 1.4.0 (`generate.py` asserts the version and the
snapshot files):

```
PYTHONPATH=<mirza-to-nexa>/src <mirza-to-nexa>/.venv/bin/python -I generate.py tests/fixtures/nxpkg
pnpm exec prettier --write tests/fixtures/nxpkg/
```

Salts, nonces and keys are random, so every regeneration changes every byte; commit the
whole directory together.
