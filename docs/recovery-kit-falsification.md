# Recovery Kit — falsification record

Every production rule ADR-0032 added that a test claims to hold, reverted one at
a time against the working tree, with the test that dies named. Mutations were
applied by hand-scripted replacement of the exact text named below, the cited
test run, and the file restored with `git checkout` before the next row.

| #     | Rule                                                                 | Mutation                                                                      | Named test                                                                                                         | Result |
| ----- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------ |
| RK-01 | A kit with two keys under one id is malformed, even authenticated    | the `seen.has(entry.keyId)` refusal in `openRecoveryKit` deleted              | `recovery-kit.test.ts` › refuses DUPLICATE KEY IDS, even in a kit that authenticates                               | KILLED |
| RK-02 | A different format version is refused by name, before deriving       | `format !== RECOVERY_KIT_FORMAT_VERSION` → `false`                            | `recovery-kit.test.ts` › refuses a WRONG VERSION by name, before deriving anything                                 | KILLED |
| RK-03 | A configured key id always wins over an imported one                 | the configured-id refusal in `InstallationKeyring.replaceImported` deleted    | `recovery-kit.test.ts` › refuses an imported key that claims the ACTIVE key id, and keeps the configured bytes     | KILLED |
| RK-04 | Same id, different bytes refuses the whole import (active key too)   | `sameKey(...) ? alreadyHeld : collisions` → always `alreadyHeld`              | `recovery-kit.test.ts` › REFUSES an attempt to replace the active key, and writes nothing                          | KILLED |
| RK-05 | A key is removed only when nothing retained depends on it            | `totalOf(counts) > 0` → `false`                                               | `recovery-kit.test.ts` › refuses while a stored SECRET still needs the key                                         | KILLED |
| RK-06 | (same rule, the archive dependency)                                  | as RK-05                                                                      | `recovery-kit.test.ts` › refuses while a RETAINED ARCHIVE on disk is sealed under the key                          | KILLED |
| RK-07 | (same rule, the wrapped-key dependency)                              | as RK-05                                                                      | `recovery-kit.test.ts` › refuses while another imported key is stored WRAPPED under it                             | KILLED |
| RK-08 | An import is one transaction: all keys or none                       | `this.deps.uow.run(scope, …)` → the same callback run outside any transaction | `recovery-kit.test.ts` › rolls back a PARTIAL import: a failure on one key leaves none written                     | KILLED |
| RK-09 | The executor carries imported keys into the candidate before cutover | `await this.deps.keys.carryInto(candidate)` → removed                         | `recovery-kit-restore.test.ts` › restores .nxb + kit + passphrase on a fresh install, and keeps the new key active | KILLED |
| RK-10 | The restore-test refuses a database whose secrets need an unheld key | `missing.length > 0` → `false` in `RecoveryService.restoreTest`               | `recovery-kit-restore.test.ts` › refuses before confirmation when the restored secrets need a key the kit lacks    | KILLED |

## Not separately falsified, and why

- **The executor's own missing-key check** (`recovery-executor.ts`, after the
  carry). With RK-10 in place no archive reaches it with a missing key, because
  the restore-test refuses first — the same shape as the executor's own cutover
  refusal in `disaster-recovery-falsification.md`. It stays as the authoritative
  re-check for a key removed between confirmation and execution.
- **Decrypt-only is structural**, not a predicate: `InstallationKeyring.activeKeyId`
  has no setter. There is nothing to revert; the property is asserted by
  `recovery-kit.test.ts` › encrypts under the configured key and decrypts under the imported one
  and by the restore test's final assertions.
