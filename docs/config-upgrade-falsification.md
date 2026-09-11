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

## The Codex rounds

Three rounds, thirteen findings, and every one of them real — each checked against
the code rather than accepted from its description. Two of the three rounds found
their defect inside the fix written for the round before, which is the pattern this
repository has already paid for and written down: _"a fix is reviewed as hard as the
bug"_, after four rounds on the deployment branch each did the same.

### Round one, on `64906e7`

Six findings. Three were defects in the fixes above; two were tests that could pass
for the wrong reason, which this repository treats as the same class of defect.

| #    | Rule                                                           | Mutation                                                          | Named test                                                                                         | Result |
| ---- | -------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------ |
| H-13 | Each key is read in the vocabulary its OWN validator allows    | `botctl`: give `PANEL_MONITOR_ENABLED` the `loose` vocabulary     | `config-upgrade.test.ts` › gives each key the vocabulary its own validator allows                  | KILLED |
| H-14 | A removal on a path that recreates nothing says so             | `botctl`: drop the restart advice from the already-current branch | `botctl.test.sh` › update: repairs the file even when the target version is already current        | KILLED |
| H-15 | The overlap check compares address RANGES, not strings         | the test's own comparator always answers `false`                  | `config-upgrade.test.ts` › can tell an overlap from a difference, so the case above is not vacuous | KILLED |
| H-16 | EVERY spelling of a subnet default is collected, not the first | the test's collector keeps only the first match                   | `config-upgrade.test.ts` › agrees on the edge subnet across every place it is spelled              | KILLED |

The other two findings of that round were `.env.example`'s `SECRETS_ACCEPT_V1=false`
contradicting its own offer of the legacy pair — a documentation fix with no rule to
mutate — and the P1 below.

### The P1, and what happened to it over two more rounds

**Round one's P1 was correct and its fix was wrong three times.** The capabilities
section read `nexa.env` while its own comment claimed it reported "what the running
processes do". So the first fix compared each value against the worker's created
environment. Round two then found that an absent key in an existing container is the
schema DEFAULT rather than unknown — so the comparison skipped exactly the legacy
shape it existed for. Round three found three more: the Telegram destination was not
compared at all, the advice paragraph could contradict the line above it, and the
worker is not the process that owns `PANEL_MONITOR_ENABLED`, `TELEGRAM_WEBHOOK_ENABLED`
or `RECOVERY_UPLOAD_ENABLED` — nor does it serve `/health/info`.

Each of those was a true statement about a design that was wrong in a new way at
every field. The review asked for the alternative in its own first sentence —
_"distinguish pending configuration from runtime state"_ — and that is what the
section does now: it reports the FILE, the heading says so, each line names the
process that reads the value, and a standing sentence says a container keeps the
configuration it was created with. No per-setting runtime claim remains to be wrong.

Two mutations that killed the withdrawn mechanism's tests are recorded here as
history rather than as live rows, because the tests they killed no longer exist and a
table row citing a deleted test is the precise dishonesty this file exists to
prevent: reverting the per-setting comparison killed `status: a file the running
worker has not adopted is reported as pending`, and restoring the absent-key
conflation killed `status: a key the running container never had is compared against
its DEFAULT`. Both were real at the time. Both are gone with the mechanism.

### Round three's rules, which are the ones in force

| #    | Rule                                                                       | Mutation                                                                   | Named test                                                                                      | Result |
| ---- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------ |
| H-17 | The section reports the FILE and says so, claiming no runtime state        | `botctl`: drop the heading's source and the standing caveat                | `botctl.test.sh` › status: the section names the FILE as its source and claims nothing more     | KILLED |
| H-18 | Each setting is attributed to the entrypoint that actually reads it        | `botctl`: attribute `PANEL_MONITOR_ENABLED` to the worker                  | `config-upgrade.test.ts` › attributes each setting to the entrypoint that actually reads it     | KILLED |
| H-19 | An EMPTY assignment is invalid, because zod defaults only an ABSENT value  | `nexa-lib.sh`: infer absence from an empty value, as the first version did | `botctl.test.sh` › status: an EMPTY assignment is invalid, not the default                      | KILLED |
| H-20 | The stale build identity is read from the API, which serves `/health/info` | `botctl`: stop asking the running container                                | `botctl.test.sh` › status: a clean file whose API still carries the stale identity is reported  | KILLED |
| H-21 | A malformed CIDR is refused rather than coerced                            | the test's parser back to `Number()` without a decimal check               | `config-upgrade.test.ts` › refuses a malformed CIDR instead of coercing its empty parts to zero | KILLED |

**H-19 is the sharpest of the three rounds.** `PANEL_MONITOR_ENABLED=` — an empty
assignment — is not an absent key. Zod applies `.default()` to an UNDEFINED value,
and an environment variable is a string, so `''` reaches the enum and is refused. The
reader mapped it to the default and reported a healthy `on` for a file the next start
rejects. Verified against the schema in the test rather than argued: absent parses,
empty does not, for the enum and for `booleanish` alike.

**H-21 is the same shape one level down.** `Number('')` is `0`, so `172.29.0./24`
parsed as `172.29.0.0/24` and `172.29.0.0/` as a `/0`. A malformed literal changed
consistently at every occurrence would have passed both the agreement and the overlap
cases while Docker refused the subnet.
