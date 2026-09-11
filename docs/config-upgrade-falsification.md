# Falsification — the configuration upgrade audit

Every rule this audit added, the mutation that removes it, and the test that dies.
The method is the repository's: revert the rule, run the focused suite, restore
the file byte-for-byte, re-run it green. A rule whose test survives its own
mutation is not a rule.

Seven of the twelve mutations live in a shell script, a YAML file, a `.env`
example or a migration-adjacent template — files `scripts/falsify.sh` does not
reach — so each was applied by hand, and each restore was confirmed with `cmp`.

The audit itself, with the classification of every variable, is
`docs/config-upgrade-audit.md`.

| #    | Rule                                                                          | Mutation                                                                                | Named test                                                                                                 | Result |
| ---- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------ |
| H-01 | `botctl` reads the application's boolean spellings, not a narrower set        | `nexa-lib.sh`: drop `yes` from `nexa_env_boolean`'s truthy arm                          | `config-upgrade.test.ts` › accepts exactly the schema spellings in each of the shell reader's two arms     | KILLED |
| H-02 | The obsolete-key list is exactly the three build-identity keys                | `nexa-lib.sh`: add `WEB_ADMIN_ORIGINS` to `NEXA_OBSOLETE_APP_ENV_KEYS`                  | `config-upgrade.test.ts` › names the same obsolete keys the upgrade audit does                             | KILLED |
| H-03 | `.env.example` names every variable the application reads                     | `.env.example`: delete the `RECOVERY_UPLOAD_ENABLED` line                               | `config-upgrade.test.ts` › names every one of them, as an assignment or a commented alternative            | KILLED |
| H-04 | Only the retired keyring spelling may be commented out                        | `.env.example`: comment out `RECOVERY_TICK_MS`                                          | `config-upgrade.test.ts` › leaves exactly the retired keyring spelling commented out                       | KILLED |
| H-05 | The canonical keyring is offered before the legacy pair                       | `.env.example`: swap them, so `SECRETS_KEK` is the live assignment                      | `config-upgrade.test.ts` › leads with the canonical keyring, above the legacy pair                         | KILLED |
| H-06 | compose and the installer agree on the default edge subnet                    | `compose.yml`: `172.29.0.0/24` → `172.30.0.0/24`                                        | `config-upgrade.test.ts` › agrees on the edge subnet across every place it is spelled                      | KILLED |
| H-07 | compose and the installer agree on the default data subnet                    | `install.sh`: `172.29.1.0/24` → `172.31.1.0/24`                                         | `config-upgrade.test.ts` › agrees on the data subnet across every place it is spelled                      | KILLED |
| H-08 | The two networks do not overlap at their defaults                             | BOTH files: move the data subnet onto the edge subnet, so agreement still holds         | `config-upgrade.test.ts` › keeps the two networks from OVERLAPPING at their defaults, not merely differing | KILLED |
| H-09 | `botctl update` removes configuration the application no longer reads         | `botctl`: replace the `nexa_reconcile_app_env` call with `:`                            | `botctl.test.sh` › update: removes the build identity the first template wrote, and nothing else           | KILLED |
| H-10 | `botctl status` reports the capabilities whose default is off                 | `botctl`: replace the `status_capabilities` call with `:`                               | `botctl.test.sh` › status: an installation that never configured backups is told so                        | KILLED |
| H-11 | The delivery destination is reported by presence, never by value              | `botctl`: print `$chat` and `$token` beside the verdict                                 | `botctl.test.sh` › status: a configured schedule and destination stop the advice, and print no token       | KILLED |
| H-12 | A template a real installation was created with still boots on today's schema | `config.schema.ts`: drop `.default(15_000)` from `RECOVERY_TICK_MS`, making it required | `config-upgrade.test.ts` › boots from the 150d8c4.env template through the current schema                  | KILLED |

## Notes on two of them

**H-08 needed a second attempt, and that is the finding.** The first mutation
changed only compose's data subnet to the edge value. The overlap case did fail —
but so did H-07's agreement case, so the overlap rule had not been shown to carry
anything of its own. Moving BOTH defaults onto the edge subnet keeps agreement
true and leaves overlap as the only broken rule, and only then does the case die
for its own reason. A mutation that trips several assertions proves the weakest of
them, not the one it was aimed at.

**H-12 kills nineteen cases, including five in `deployment-config.test.ts`.** That
breadth is the point rather than noise: the existing suite already refused a
newly-required variable against the CURRENT template, and what these fixtures add
is the same refusal against the templates of releases that are actually installed.
The three fixture cases are the new coverage; the rest were already there.

## What was NOT falsifiable, and is said so rather than dressed up

The claim that `/health/info` on the deployed staging host currently reports the
installer's `pending` is an INFERENCE from three facts in this repository — the
first production template wrote the three build keys, `env_file` beats an image's
ENV, and nothing rewrote `nexa.env` — and from the owner's statement that the host
has been upgraded since. It was not observed: this session does not touch staging.
`config-upgrade.test.ts` proves the first and third by parsing that template
through the current schema and showing `BUILD_COMMIT` resolving to `pending`, and
showing the schema's own `unknown` once the lines are gone. The second is
`docker`'s documented precedence, not ours.

## The Codex round

Six findings on `64906e7`, and all six were real — checked against the code rather
than taken from the description. Three of them are defects in the fixes above, and
two are tests that could pass for the wrong reason, which this repository treats as
the same class of defect as a broken rule.

| #    | Rule                                                                | Mutation                                                               | Named test                                                                                                  | Result |
| ---- | ------------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------ |
| H-13 | `status` compares the file against what the worker was STARTED with | `botctl`: set `applied=""` instead of reading the running container    | `botctl.test.sh` › status: a file the running worker has not adopted is reported as pending, not as working | KILLED |
| H-14 | Each key is read in the vocabulary its OWN validator allows         | `botctl`: give `PANEL_MONITOR_ENABLED` the `loose` vocabulary          | `config-upgrade.test.ts` › gives each key the vocabulary its own validator allows                           | KILLED |
| H-15 | A removal on a path that recreates nothing says so                  | `botctl`: drop the restart advice from the already-current branch      | `botctl.test.sh` › update: repairs the file even when the target version is already current                 | KILLED |
| H-16 | The overlap check compares address RANGES, not strings              | the test's own comparator always answers `false`                       | `config-upgrade.test.ts` › can tell an overlap from a difference, so the case above is not vacuous          | KILLED |
| H-17 | EVERY spelling of a subnet default is collected, not the first      | the test's collector keeps only the first match                        | `config-upgrade.test.ts` › agrees on the edge subnet across every place it is spelled                       | KILLED |
| H-18 | The fake answers the container id of the service that was ASKED for | `harness.sh`: answer the edge's id for every service, as it did before | `botctl.test.sh` › status: a file the running worker has not adopted is reported as pending, not as working | KILLED |

### What each of the six was

**H-13 — the P1, and correct.** `status_capabilities` read `nexa.env` and the
section's own comment claimed it said "what the running processes do". It did not:
an operator who sets `BACKUP_SCHEDULE_ENABLED=true` and has not restarted was told
the schedule was on while the worker still held `false`. The file is intent; the
container keeps what it was created with. It now reports both and names the
disagreement — which is the distinction `status_secrets` beside it already makes
between configuration and rows, and the same failure the `edge configuration`
lines were added for after a staging update left the previous release's Caddy
serving while every other output named the new one.

**H-14 — the vocabulary is not uniform, and assuming it was went the wrong way.**
`booleanish` accepts `true/false/1/0/yes/no`, but `PANEL_MONITOR_ENABLED` is
`z.enum(['true', 'false'])`. The generic reader reported `PANEL_MONITOR_ENABLED=yes`
as `on` for a value the next start REFUSES — a working monitor claimed where a boot
failure waits. The first drift test bound one global vocabulary and so proved only
the half that was already true.

**H-15 — the repair that announced itself before taking effect.** On the
already-current path the keys are removed and no container is recreated, so the
running processes keep the values just taken out of the file — while `status`,
reading the cleaned file, stops warning. The operator is told a repair happened
that has not. The note now says so, and only when something was actually removed:
the flag is set by observing the keys gone rather than by reading
`nexa_reconcile_app_env`'s status, which answers 0 both for "removed" and for
"nothing to remove".

**H-16 — string inequality is not disjointness.** `172.29.0.0/16` and
`172.29.1.0/24` are different strings and the second is inside the first. The check
now parses both CIDRs and compares ranges, and the comparator has its own case —
otherwise a predicate that always answered `false` would make the assertion pass
for ever.

**H-17 — the installer spells the edge default TWICE**, once deriving
`TRUSTED_PROXY_IPS` and once writing `deploy.env`. The collector took `exec()`'s
single match, so a change to the second alone would leave a fresh installation
putting Caddy on one subnet and trusting the other, with the test still green — the
exact lockout it exists to prevent, surviving its own guard. It now collects every
occurrence, asserts how many there are in each file, and requires one distinct
value across all of them.

**H-18 — found while fixing H-13, and the reason it is listed.** The fake docker's
`compose ps -q` answered the EDGE container's id whatever service was asked for.
`status_capabilities` inspects the worker, so against that fake it read the edge's
environment, found none of its keys, and reported "cannot say" — passing for the
wrong reason. The fake now dispatches on the service, and the mutation restoring
its old behaviour kills the pending-restart case.
