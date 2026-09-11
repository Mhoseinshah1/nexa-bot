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

### Round four, on `d47573a`

Four findings, all four CONFIRMED, and the P2 on the remaining container inspection
is the most useful finding of the four rounds: **it was wrong about every healthy
installation, not about an edge case.**

`Dockerfile` lines 89-92 stamp `BUILD_VERSION`, `BUILD_COMMIT` and `BUILD_TIME` into
the runtime image's own ENV — that is where a release's identity is SUPPOSED to come
from. So `.Config.Env` on a correctly built API container always carries all three,
and a check keyed on their PRESENCE told every operator their build identity was
masked and to restart; the restart recreated the same image environment and the
warning could never clear. The empty-value finding beside it is the same error from
the other side: `BUILD_COMMIT=` is not an absent key, and a check asking whether the
value was non-empty reported nothing wrong about a container whose `/health/info`
answers the empty string.

Both are one error — **inferring a value's provenance from its presence** — which is
the same error the three withdrawn versions of the runtime comparison made about
absence, ownership and intent. The replacement asks provenance directly: the
container's value is compared against its IMAGE's value, because `env_file` beats an
image's own ENV, so a difference IS the override and an agreement is the image
reporting itself. There is no inference step left to get wrong, and the empty
assignment is covered by construction rather than by a special case.

**The fake docker could not express the ordinary case, which is why the presence
check passed its own tests.** It gave the API container no `BUILD_*` at all — a
container no release produces. That is the same class of harness lie as `compose ps -q`
answering the edge's id for every service (H-18's mutation, round one), and it is
recorded as a rule below: H-23 mutates the fake to stamp nothing and the case that
asserts the fake's own contents dies.

| #    | Rule                                                                         | Mutation                                                                | Named test                                                                                                    | Result |
| ---- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------ |
| H-22 | A container's build identity is judged by comparison with its IMAGE's        | `nexa-lib.sh`: back to "the value is present", as the first version did | `botctl.test.sh` › status: an API answering its own image says nothing about them                             | KILLED |
| H-23 | The fake API container carries the identity every real image stamps          | `harness.sh`: `fake_image_env` stamps nothing                           | `botctl.test.sh` › status: an API answering its own image says nothing about them                             | KILLED |
| H-24 | An EMPTY override of the image's identity is still an override               | `nexa-lib.sh`: back to "the value is present"                           | `botctl.test.sh` › status: an EMPTY override of the image identity is still an override                       | KILLED |
| H-25 | An image that cannot be inspected produces no warning                        | `nexa-lib.sh`: drop the `[ -n "$image" ]` guard                         | `botctl.test.sh` › status: an image it cannot inspect produces no warning                                     | KILLED |
| H-26 | The runtime image stamps every obsolete key, which is the premise of H-22    | `Dockerfile`: stop stamping `BUILD_VERSION` in the runtime stage        | `config-upgrade.test.ts` › stamps every obsolete key into the RUNTIME image, which is the premise             | KILLED |
| H-27 | The decision is a comparison of two reads, not one read                      | `nexa-lib.sh`: delete the image half and test the container's value     | `config-upgrade.test.ts` › compares the container against its image rather than asking whether a value exists | KILLED |
| H-28 | A boolean with whitespace ANYWHERE is refused, because the schema refuses it | `nexa-lib.sh`: restore `raw="${raw//[[:space:]]/}"`                     | `botctl.test.sh` › status: whitespace is never normalised away                                                | KILLED |
| H-29 | Whitespace strictness is the SCHEMA's, not the reader's opinion              | `nexa-lib.sh`: restore the whitespace substitution                      | `config-upgrade.test.ts` › refuses a boolean with whitespace, which is what the schema does                   | KILLED |
| H-30 | The delivery destination names every process that delivers                   | `botctl`: the delivery line names `worker` alone                        | `botctl.test.sh` › status: the delivery destination names every process that delivers                         | KILLED |
| H-31 | …bound to the call sites rather than to a belief about them                  | `botctl`: the delivery line names `worker` alone                        | `config-upgrade.test.ts` › names every process that delivers a backup, not the worker alone                   | KILLED |
| H-32 | `nexa.env` is the ONLY thing that can override the image's identity          | `compose.yml`: add a `BUILD_COMMIT` line to the shared environment      | `config-upgrade.test.ts` › stamps every obsolete key into the RUNTIME image, which is the premise             | KILLED |

**H-28 is the whitespace finding, and it is narrower than it looks.** `loadConfig`
hands `process.env` to the schema untouched and `booleanish` is a bare enum with no
`.trim()`, so `t rue`, ` true` and `true ` are all values the application REFUSES.
The reader removed whitespace before matching, so `BACKUP_SCHEDULE_ENABLED="t rue"`
read as `on` and suppressed the no-backup guidance for a file the next start rejects.
The correct reading is to normalise NOTHING and let the accepted spellings be the
whole validator — which is also why the fix is a deletion rather than a narrower trim.

**H-32 closes the one way the provenance check could still cry wolf.** It reports a
difference between a container and its image, so anything else that sets a `BUILD_*`
key would make it report every container as overridden — truthfully, and for a reason
no restart could fix. `deploy/compose.yml` sets none of them today, which is what
makes `nexa.env` the only source; the assertion is what keeps it that way.

**H-30 was a truthfulness finding about a label, and the label was wrong.** The
backup destination is not the worker's: `createContainer` builds one `BackupService`
with these credentials and every role gets it, so the worker schedules,
`RecoveryController.runBackup` serves the Web Admin's manual run, and the recovery
executor takes the `PRE_RESTORE` backup. After a service-specific recreation those
three can hold different destinations, and naming only the worker would send a
targeted restart to the wrong process. `BACKUP_SCHEDULE_ENABLED` beside it is
genuinely the worker's — it gates the scheduler in `main.worker.ts` and nothing else —
which is why H-31 pins both halves: a label that named everything would carry no
information at all.
