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
| H-17 | The section names its RESOLVER and says so, claiming no runtime state      | `botctl`: drop the heading's source and the standing caveat                | `botctl.test.sh` › status: the section names COMPOSE as its resolver and claims nothing more    | KILLED |
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

| #    | Rule                                                                      | Mutation                                                                | Named test                                                                                                    | Result |
| ---- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------ |
| H-22 | A container's build identity is judged by comparison with its IMAGE's     | `nexa-lib.sh`: back to "the value is present", as the first version did | `botctl.test.sh` › status: an API answering its own image says nothing about them                             | KILLED |
| H-23 | The fake API container carries the identity every real image stamps       | `harness.sh`: `fake_image_env` stamps nothing                           | `botctl.test.sh` › status: an API answering its own image says nothing about them                             | KILLED |
| H-24 | An EMPTY override of the image's identity is still an override            | `nexa-lib.sh`: back to "the value is present"                           | `botctl.test.sh` › status: an EMPTY override of the image identity is still an override                       | KILLED |
| H-25 | An image that cannot be inspected produces no warning                     | `nexa-lib.sh`: drop the `[ -n "$image" ]` guard                         | `botctl.test.sh` › status: a provenance it cannot compute produces no warning, at any of three lookups        | KILLED |
| H-26 | The runtime image stamps every obsolete key, which is the premise of H-22 | `Dockerfile`: stop stamping `BUILD_VERSION` in the runtime stage        | `config-upgrade.test.ts` › stamps every obsolete key into the RUNTIME image, which is the premise             | KILLED |
| H-27 | The decision is a comparison of two reads, not one read                   | `nexa-lib.sh`: delete the image half and test the container's value     | `config-upgrade.test.ts` › compares the container against its image rather than asking whether a value exists | KILLED |
| H-30 | The delivery destination names every process that delivers                | `botctl`: the delivery line names `worker` alone                        | `botctl.test.sh` › status: the delivery destination names every process that delivers                         | KILLED |
| H-31 | …bound to the call sites rather than to a belief about them               | `botctl`: the delivery line names `worker` alone                        | `config-upgrade.test.ts` › names every process that delivers a backup, not the worker alone                   | KILLED |
| H-32 | `nexa.env` is the ONLY thing that can override the image's identity       | `compose.yml`: add a `BUILD_COMMIT` line to the shared environment      | `config-upgrade.test.ts` › stamps every obsolete key into the RUNTIME image, which is the premise             | KILLED |

**The whitespace finding of this round was right, and the fix for it was wrong —
which round five established by measurement.** The reader had been removing whitespace
before matching, so `BACKUP_SCHEDULE_ENABLED="t rue"` read as `on` for a file the next
start rejects; that much was correct. The fix normalised NOTHING, on the reasoning that
`loadConfig` hands `process.env` to the schema untouched and `booleanish` has no
`.trim()`. True of the schema, and beside the point: the application does not read this
file, Compose does, and Compose TRIMS an unquoted value at both ends. So the new reader
refused `true`, which the application accepts. Two rows stood here claiming that rule;
they have been removed rather than corrected in place, because the rule they named is
not the rule, and the live statements are `H-33`…`H-36` below. This is the same
treatment the withdrawn runtime mechanism got, for the same reason.

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

### Round five, on `b6f3467`

Two findings, both CONFIRMED, and between them they settle a question this file had
been answering from reasoning rather than from evidence.

**The first is a defect in round four's own fix**, which is now the fourth time that
has happened on this branch. `nexa_image_env_value` returned an empty string both
when a key was not stamped and when `docker image inspect` FAILED, and the caller's
`|| true` swallowed the difference — so a failed image inspect made every stamped
value read as empty, every key look overridden, and every operator be told to
restart. The guard added in round four only covered the first of the three lookups,
and the test only simulated that one. All three are checked now, each with its own
case, and M5/M6 below are the mutations that restore each hole.

**The second established that the reader had been wrong about whitespace in BOTH
directions, one round apart.** The application does not read `nexa.env`; Compose
does, and hands the result to the container. So the rule is a two-stage pipeline and
neither stage alone is it. Rather than reason about Compose's documented behaviour —
which is how the previous two versions went wrong — 18 shapes were run through
`docker compose config --format json` on **Compose v5.1.1** and the resolved
environment read back:

```
line in nexa.env            what the container receives   so status says
KEY=false # disabled        false                         off
KEY=false# notcomment       false# notcomment             invalid
KEY=true<TAB># tabbefore    true<TAB># tabbefore          invalid
KEY=__true__                true                          on       (leading/trailing spaces)
KEY=_# onlycomment          # onlycomment                 invalid
KEY=t rue                   t rue                         invalid
KEY="false # inquotes"      false # inquotes              invalid
KEY="true" # after          true                          on
KEY=_"true"_                true                          on
```

Three of those contradict what the documentation alone suggests: a TAB before `#` is
not a comment separator, an unquoted value IS trimmed at both ends, and a value that
is only a comment survives as a value because the trimming happens first. The
trimming one is the one that matters: round four made the reader refuse
`BACKUP_SCHEDULE_ENABLED= true `, which Compose trims and the application accepts —
crying wolf about a working file — immediately after a version that accepted `t rue`,
which Compose preserves and the application refuses. `nexa_compose_env_value` was
then cross-checked against the real parser on all 18 shapes and agrees on every one.

**And the rule generalised past the finding.** If a reader of `nexa.env` has to agree
with what the container receives, then every reader of it does — including the two in
`botctl secrets migrate-config` that carry `SECRETS_KEK_ID` and `SECRETS_KEK` INTO
the file it rewrites. `SECRETS_KEK_ID=install-1 # original` would have become an
active key id with a comment in it, and a commented `SECRETS_KEK` a `SECRETS_KEYS`
entry the base64 refinement refuses at boot: a conversion that leaves an installation
unable to decrypt anything. That was not reported by either review; it follows from
the finding, and an inline comment beside one's own key is a thing an operator writes.
`/etc/os-release` keeps the raw reader, because it is not a Compose file.

| #    | Rule                                                                | Mutation                                               | Named test                                                                                             | Result |
| ---- | ------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ------ |
| H-37 | A failed IMAGE-environment lookup stops the report                  | `nexa-lib.sh`: swallow its status, as round four did   | `botctl.test.sh` › status: a provenance it cannot compute produces no warning, at any of three lookups | KILLED |
| H-38 | A failed CONTAINER-environment lookup stops the report              | `nexa-lib.sh`: swallow its status                      | `botctl.test.sh` › status: a provenance it cannot compute produces no warning, at any of three lookups | KILLED |
| H-39 | The reader's first stage is the Compose resolver, not the raw line  | `nexa-lib.sh`: `nexa_env_boolean` back to the raw line | `config-upgrade.test.ts` › validates what COMPOSE produces, not what the file literally says           | KILLED |
| H-40 | EVERY read of `nexa.env` goes through it, `migrate-config` included | `botctl`: the key-id read back to the raw line         | `config-upgrade.test.ts` › reads what the application receives, and refuses to freeze a substitution   | KILLED |

**On H-37 and H-38 passing for the right reason.** A test asserting that nothing is
warned about is satisfied by a check that never warns, so the case also drives the
working path and asserts the override IS reported — the three failure states are
cleared first. The same reason the fake now carries three separate failure states
instead of one: a single `image_absent` could not express the two holes the finding
named.

### Round six, on `fd3f441`

One finding, CONFIRMED, and it is a defect in the reader round five built — the
fifth consecutive round in which the previous round's fix carried the next round's
bug. Worth stating plainly rather than filed away: on this branch a fix has been
**as likely to be wrong as the code it replaced**, and the only thing that has
caught that every time is somebody reviewing the fix as hard as the bug.

Compose lets a quoted value span lines. The reader is line-based, so
`PANEL_MONITOR_ENABLED='true` followed by `'` on the next line gave it `'true`, and
stripping the unmatched opening quote manufactured the scalar `true` — a monitor
reported `on`. Measured on Compose v5.1.1, the two ways that happens are:

```
KEY='true\n'          the container receives `true` WITH the newline, which the
                      strict enum and booleanish both refuse
KEY='unterminated     Compose refuses the WHOLE FILE — "unterminated quoted
                      value" — so no container starts at all
```

Neither is `on`. A quote is now only stripped when its partner is on the same line;
otherwise the value is returned as it stands, leading quote included, and the
per-key validator refuses it. `invalid` is the honest answer to both — in the second
case it understates the problem, and understating beats reporting health.

The 18-shape cross-check against `docker compose config` was re-run after the change
and still agrees on every shape, which is the point of having it: a narrowing fix
that broke an ordinary quoted value would have shown up there rather than in review.

| #    | Rule                                                                    | Mutation                                                             | Named test                                                                | Result |
| ---- | ----------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------ |
| H-43 | The detector and the rewriter agree about what an assignment looks like | `nexa-lib.sh`: leave the rewriter on `^KEY=` while the reader widens | `botctl.test.sh` › update: removes an obsolete line however it is spelled | KILLED |

**And the case that keeps it honest** is the third assertion beside it: a value whose
quote DOES close on its line is still resolved to `on`. Without it, a reader that
refused every quoted value would pass.

**H-42 and H-43 were not reported by either review.** After five rounds of a fix
carrying the next round's bug, the shapes were re-run against `docker compose config`
looking for more — the same probe that produced the table above, asked a second time
and harder. Two divergences came out of it, both in the direction of reporting a
DEFAULT for a key the operator had set:

```
export PANEL_MONITOR_ENABLED=false    reaches the container as `false`
  PANEL_MONITOR_ENABLED=false         reaches the container as `false`  (indented key)
```

Compose accepts leading whitespace before a key and an `export ` prefix; a matcher
anchored on `^KEY=` read both as absent and reported the schema default — which for a
key whose default is ON means `status` says the monitor is running while the next
start turns it off.

**H-43 is why that fix had to be one definition rather than one regex per function.**
`nexa_obsolete_app_env_keys` finds lines and `nexa_env_rewrite` removes them, and if
they disagree about the shape of an assignment then `botctl update` reports a line
removed, leaves it in the file, and reports it again on the next run — an operator
told a repair happened twice. `nexa_env_key_pattern` is that definition, used by the
reader, the boolean's presence test, the detector and the rewriter, and the mutation
that desynchronises just two of them is killed.

The cross-check now covers **22** shapes and the reader agrees with Compose on every
one.

### Round seven, on `e482337`

Two findings, both CONFIRMED, and the first says something the previous two rounds
had been patching around: **a line-based reader cannot be correct about this file
format.** Compose reads a quoted value across lines, so a line that looks like an
assignment may be text inside another variable's value. Measured on v5.1.1:

```
IGNORED_NOTE='first
BACKUP_SCHEDULE_ENABLED=true
last'
```

defines ONE variable. `BACKUP_SCHEDULE_ENABLED` is not set at all, and the
application runs on its `false` default — while a grep for the key found the middle
line and reported `on`. No amount of care about the SELECTED line fixes that, which
is why rounds five and six kept finding the same shape from different angles.

The reader is a scanner now: it walks the file tracking quoted regions and answers
only about top-level assignments. Presence comes from the same pass rather than a
separate grep, for the same reason — a grep would call that interior line an
assignment and then report a key Compose never sets as set.

**And the finding generalised into a corruption risk neither review reported.** If
the DETECTOR must scan, so must the REWRITER: `nexa_env_rewrite` dropped lines by
pattern, so a `BUILD_COMMIT=` line inside an operator's multiline value would have
been deleted out of the middle of it — and a removed obsolete key that OPENED a
multiline value would have left its continuation lines behind as a dangling fragment
with a quote that now closes somewhere else. Both are silent corruption of
`/etc/nexa/nexa.env`, performed by an update that reported success.

**The first mutation of that rule SURVIVED**, and that is the most useful thing in
this round. Removing the rewriter's quoted-region tracking left all 197 checks green:
the rule had no test, exactly as this repository's own note predicts — _"a rule with
no test is a rule that will be silently reverted"_. Two cases were written, the
mutation re-run, and both died. It is recorded here as M13-survived-then-killed
rather than as a clean row, because a falsification pass whose first result is
"nothing failed" is information, and hiding it would make this table a record of
tests that happened to exist.

The second finding is about the build-identity warning claiming `/health/info` IS
masked whenever the FILE carries the lines. False when the container predates them —
a line added since the API was created is not in force — and false again when the API
is not running. Three states now, and the middle one says the lines take effect at
the next start rather than describing an endpoint nobody is serving.

One condition was added that is not per setting: a file ending inside a quoted value
is refused by Compose OUTRIGHT, so `status` says so before printing a column of
values no container will ever receive.

| #    | Rule                                                                   | Mutation                                                   | Named test                                                                                         | Result |
| ---- | ---------------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------ |
| H-45 | The REWRITER never deletes a line from inside another variable's value | `nexa-lib.sh`: drop the rewriter's quoted-region tracking  | `botctl.test.sh` › update: the removal never reaches inside another variable value                 | KILLED |
| H-46 | A removed key's continuation lines go with it                          | `nexa-lib.sh`: drop the rewriter's quoted-region tracking  | `botctl.test.sh` › update: removing a multiline obsolete value takes its continuation lines        | KILLED |
| H-48 | The file and the running API are three states, not two                 | `botctl`: collapse the first branch back to the file alone | `botctl.test.sh` › status: the file and the running API are two facts, reported as three states    | KILLED |
| H-49 | Detection and removal use the scanner, never a pattern                 | `nexa-lib.sh`: the detector greps again                    | `config-upgrade.test.ts` › finds and removes assignments with the same scanner, not with a pattern | KILLED |
| H-50 | Presence is settled by the pass that reads the value                   | `nexa-lib.sh`: a separate presence grep, as before         | `config-upgrade.test.ts` › treats an EMPTY assignment as invalid, which is what the schema does    | KILLED |

The cross-check now covers **23 keys** in one file, including a multiline value whose
interior looks like an assignment, and the reader agrees with `docker compose config`
on every one — including that the interior key is NOT set.

### Round eight, on `5b58c7f`

Three findings — two of them P1 — and both P1s are defects in the scanner written for
round seven. That makes seven consecutive rounds in which the previous round's fix
carried the next round's bug, and the honest summary of this branch is that on it a
**fix has been about as likely to be wrong as the code it replaced.** What has caught
it every time is somebody reviewing the fix as hard as the bug.

**P1 one: the suppression flag was not reset, and the result was corruption.**
`skip` means "suppress the continuation lines of the value being dropped". It was set
when a key was dropped and cleared only when a quoted value CLOSED — so dropping a
SINGLE-line assignment left it set, and the next multiline value lost its continuation
lines including its closing quote. Reproduced directly before fixing:

```
DATABASE_URL=…            removing BUILD_COMMIT gave:   DATABASE_URL=…
BUILD_COMMIT=pending                                    NOTE='first
NOTE='first                                             OTHER=ok
second'
OTHER=ok                  ← `second'` gone; the file is now unterminated,
                            which Compose refuses WHOLE, and update said ok
```

**P1 two: escaped delimiters.** Compose honours an escaped delimiter inside a quoted
value, and the rule is the usual odd/even one. Measured on v5.1.1:

```
KEY='it\'s fine'   ->  it's fine      one backslash: escaped
KEY='ends\\'       ->  ends\\         two: not escaped, the value ends here
KEY="ends\\"       ->  ends\          same in double quotes
KEY='a\\\'b'       ->  a\\'b          three: escaped again
```

The scanner took the first matching character, so `'it\'s fine` ended at the escaped
quote and the lines after it were classified top-level — which the rewriter then
deletes out of the operator's value. The rule now lives in ONE awk function prepended
to all three programs (the reader, the loadability check, the rewriter), because this
is precisely the rule that must not drift between the thing that reads a value and the
thing that removes a line.

**The P2 was about the report, and it was right.** `obsolete` and `running_obsolete`
need not hold the same keys: a file newly setting `BUILD_VERSION` while the container
retains a stale `BUILD_COMMIT` is both states at once, and a conjunction over the lists
named the wrong key in the wrong sentence. The sets are intersected and differenced
now, and each sentence names only the keys it is true of.

**A test of mine was wrong in a way worth recording.** The first version of the
escaped-delimiter fixture used `printf FORMAT` with `\'` in it; printf drops unknown
escapes, so the file written was `NOTE='it's fine` — a quote that is NOT escaped, where
deleting the interior line is the CORRECT answer. The case therefore failed against
correct code. It is written with `printf '%s\n' ARG…` now and asserts that the fixture
contains the backslash it is about, because a fixture that does not contain what the
case claims is the same defect as a test that cannot fail — it just fails loudly
instead of passing quietly.

| #    | Rule                                                            | Mutation                                                  | Named test                                                                                  | Result |
| ---- | --------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------ |
| H-51 | Dropping a single-line key does not swallow the NEXT value      | `nexa-lib.sh`: stop resetting `skip` per top-level record | `botctl.test.sh` › update: dropping a single-line key does not swallow the NEXT value       | KILLED |
| H-52 | A delimiter preceded by an ODD number of backslashes is escaped | `nexa-lib.sh`: `unescaped_index` returns the first match  | `botctl.test.sh` › update: an ESCAPED delimiter does not end a value early                  | KILLED |
| H-53 | The build states are classified per KEY, not over the lists     | `botctl`: drop the pending branch                         | `botctl.test.sh` › status: a mixed pending/stale pair is reported per key, not as one state | KILLED |
| H-54 | The fixture contains the escaping it is about                   | the fixture's backslash is eaten by `printf FORMAT`       | `botctl.test.sh` › update: an ESCAPED delimiter does not end a value early                  | KILLED |

**H-54 is the fixture assertion**, and it is in the table because it is a rule like any
other: the case asserts its own input before acting on it, and the mutation that
reintroduces the format-string fixture kills it.

**H-47 is retired in round ten**, not corrected: its mutation — "remove the
unterminated-file notice" — names a notice round nine removed, so the mutation can no
longer be performed, and the rule it protected is H-56's now (Compose reports the
refusal; `status` repeats it). A row whose mutation cannot be applied is a row that
cannot be falsified.

### Round nine, on `0977fce` — and the end of the reimplementation

Three findings. One of them ends an argument that had run for five rounds, so this
section retires rules rather than only adding them.

**Compose INTERPOLATES env_file values.** Measured on v5.1.1:

```
KEY=${UNSET_VAR:-true}   the container receives  true
KEY=${UNSET_VAR:-}       the container receives  (empty)
KEY=${HOME}              the container receives  /root      ← the AMBIENT environment
```

So a reader in this repository cannot be right about these values without reproducing
Compose variable precedence — the shell environment, `--env-file`, and the rest. One
that tries reports `invalid` for a file the application accepts, which is the same
false alarm the whitespace rule produced two rounds earlier, and `${UNSET:-}` makes an
unset backup destination look present.

Rounds five to nine were all one mistake: **resolving and validating in the same
place.** Comments, trimming, escapes, values spanning lines, interior assignments,
escaped delimiters, and now interpolation — seven distinct ways the outside view of
`env_file` differed from Compose's own. The answer is not an eighth correction. It is
that resolution belongs to Compose and validation belongs here:

```
docker compose config --format json   →  the resolved environment, by construction
nexa_listing_boolean                  →  the per-key vocabulary the SCHEMA applies
```

`docker compose config` is client-side, needs no daemon, and reports exactly what a
container started now would receive — including the compose file's own `environment:`
entries, which a reader of `nexa.env` never saw at all. It also reports the one
condition that matters more than any value: a configuration Compose REFUSES, where
nothing starts and no individual setting is in force.

**Seven rows are retired here, not corrected.** `H-33`, `H-34`, `H-35`, `H-36`,
`H-41`, `H-42` and `H-44` each named a rule about how this repository resolved
`env_file` semantics for reporting. That code is gone, so the rules are not wrong — they
are about nothing. Keeping them would leave a table that cites tests no longer in the
suite, which is what this file exists to prevent. The same treatment the withdrawn
runtime comparison got in round three, for the same reason.

The scanner SURVIVES, and only there: `nexa_obsolete_app_env_keys` and
`nexa_env_rewrite` operate on the file as TEXT — one finds assignments to remove, the
other removes them — and that is a question about lines, which interpolation does not
touch. `H-45`, `H-46`, `H-51` and `H-52` are its live rules.

**The fake docker no longer parses anything**, which removes a standing hazard. It
serves a resolved environment a test states outright, so a shape case can no longer
pass because the fake's parser agreed with this repository's — they were the same
parser. What the suite now checks is that `status` reports what Compose told it; that
Compose's answer is right is Compose's business.

| #    | Rule                                                                        | Mutation                                                               | Named test                                                                                        | Result                |
| ---- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------- |
| H-55 | Capability values come from `docker compose config`, not from the file      | `botctl`: read the file with the old scanner instead                   | `botctl.test.sh` › status: the capabilities section reports what COMPOSE resolved                 | KILLED                |
| H-56 | A configuration Compose REFUSES is reported, never summarised               | `botctl`: carry on and print values when `compose config` fails        | `botctl.test.sh` › status: a configuration Compose REFUSES is reported as refused, not summarised | KILLED                |
| H-57 | An enabled webhook with a secret under 16 characters is `invalid`           | `botctl`: drop the dependency check                                    | `botctl.test.sh` › status: an enabled webhook with a short secret is invalid, not on              | KILLED                |
| H-58 | A multiline environment entry cannot be truncated into a false match        | `nexa-lib.sh`: render the inspect output with `println` again          | `botctl.test.sh` › status: a stale multiline override is not mistaken for a match                 | SURVIVED, then KILLED |
| H-59 | `migrate-config` refuses to freeze a substitution into the file it rewrites | `botctl`: drop the refusal and write the literal                       | `botctl.test.sh` › secrets migrate-config: a substitution is refused, not frozen                  | KILLED                |
| H-60 | The fake `docker inspect` renders the `--format` template it was asked for  | `harness.sh`: render `%q` whatever the template says                   | `botctl.test.sh` › harness: the fake docker renders the --format template it was asked for        | KILLED                |
| H-61 | Every test root seeds the environment Compose resolves, not only the first  | `harness.sh`: create the fake's directory in `setup_fake_docker` again | `botctl.test.sh` › harness: a second root seeds the resolved environment too                      | KILLED                |

**H-58 is the second finding of this round.** `docker inspect --format '{{println .}}'`
put a value containing a newline on two lines, so a line-based comparison saw only its
first part — and `BUILD_COMMIT='cafebabe\npending'` over an image stamped `cafebabe`
compared EQUAL, leaving a stale override unreported. Both sides are rendered with Go
`%q` now: one entry is one line, and two entries are equal only when they are.

**H-58 SURVIVED its first mutation, and the table said KILLED.** Reverting both
`nexa_inspect_env` templates to `println` left all 204 checks green, including the test
named for the difference. The reason was the fake, not the rule: the fake `docker
inspect` ignored the `--format` argument and rendered `%q`-shaped lines whatever it was
asked, so under the mutation the production code requested `println` and received
`%q` anyway. That is the fourth harness lie on this branch, after `compose ps -q`, the
container carrying no stamped `BUILD_*`, and the single failure state for the image's
environment — each a fake that answered one way regardless of the question, and each
let a production rule be removed under a green suite. A test that cannot observe the
mutation is not evidence, so the row above was wrong when it was first written, and
this paragraph replaces the claim rather than editing it away.

The correction is to the harness: `fake_render_config_env` inspects the template it
was actually passed and renders `{{println .}}` as Go's println would — each entry's
raw text, a multiline value spanning lines — and `{{printf "%q" .}}` as one quoted,
escaped line per entry; any other template is refused loudly rather than rendered as
something the caller did not ask for. The fixture data is the same for both shapes;
only the rendering follows the request. Two mutations were then re-run:

```
M24   println on both nexa_inspect_env lines, quoted reader unchanged
      → 7 of 204 fail: the named test and six provenance tests, because the reader
        finds no quoted entry in println output and every lookup goes silent.
M24b  println on both lines AND the reader made to match (an unquoted ^KEY= match),
      which is the whole previous design, not half of it
      → exactly 1 of 204 fails: status: a stale multiline override is not mistaken
        for a match — the multiline rule alone, for the intended reason.
```

Restore was confirmed with `cmp` after each, and the suite is green on the restored
file. H-60 pins the harness rule itself, because it participated in this proof.

While fixing the fake, a second harness defect surfaced: `setup_root` seeded the
default `nexa.env` BEFORE `setup_fake_docker` created the fake's state directory, so
every root after the first wrote its resolved environment into the previous root's
deleted directory — a `No such file` warning on stderr, 57 times, under a green suite,
and a `status` in those tests that resolved nothing. The directory is created by
`setup_root` now, and H-61 asserts it on a second root.

**H-59 is not from either review.** It follows from the resolution split: `status` must
read what the application RECEIVES, but `migrate-config` REWRITES the file, so it must
read the file — and writing a resolved value there would freeze an interpolation meant
to be evaluated at every start. Neither reading is safe when the value IS a
substitution, so it refuses. The cost of choosing wrong is an installation that cannot
decrypt anything.

### Round ten — self-review of `898224b`, before Codex

The adversarial pass on the head that ended the reimplementation found one blocker in
the thing that replaced it, and it is the same class of defect as everything before:
believing a description of a tool instead of measuring the tool.

**`docker compose config` re-escapes `$`.** Measured on v5.1.1:

```
S='abcdefghijklmn$'   in nexa.env        15 characters to the application
                       in config JSON     "abcdefghijklmn$$"     16
M='$'                                     "$$"
D='$$'  (single-quoted: no escape)        "$$$$"
N='line1<newline>line2'                   "line1\nline2"  — the newline itself, intact
B='a\\b'                                  "a\\b"        — backslashes intact
```

`config` prints a RE-LOADABLE document, so every literal dollar is doubled and nothing
else is. The listing `nexa_compose_resolved_env` produced was therefore "what the
container receives" for every value except one containing `$` — and the new webhook
check measured that listing, so a 15-character secret ending in `$` was reported `on`
for an API the schema refuses to start. That is the exact lie H-57 claims to kill, and
H-57's test could not see it because its fixture had no dollar. The doubling is undone
once, in the resolver; H-62 pins it with a 15-character `$`-terminated secret that
must read `invalid` and a 16-character one that must read `on`.

The second finding is the same mistake in this repository's own rendering. The
listing carries `\\` and `\n` so that one entry is one line, and the length check
measured the rendering: eight backslashes counted sixteen. `nexa_listing_value`
decodes exactly those two escapes now (`printf %b`, which is total on this alphabet
because every real backslash is doubled), and H-63 measures a secret of backslashes
and one spanning a line. The fake `compose config` gained `compose_env_json` for the
values its line-based fixture cannot spell.

Third: the refusal discarded Compose's reason and guessed at "common causes", so a
missing env file was reported as a possibly unclosed quote. Compose says why, and
`status` repeats it — cut at the first quote character, because an unterminated-quote
refusal echoes the offending VALUE, and in this file that value can be the bot token.
Measured: `unterminated quoted value '7777:AAAsecretvalue`. H-64 asserts the reason
is printed, the echoed token is not, and a document defining no `api` is a refusal
rather than a column of defaults.

Fourth, and the one that says something about the method: three deploy cases asserted
"the rewritten file does not end inside a quoted value" through
`nexa_compose_env_unterminated` — called inside a `bash -c` that had never sourced the
library. `! undefined-command` exits 0. All three passed against any rewriter at all,
across the very rounds whose corruption they were written to catch. They call the
function directly now, and H-65 asks the oracle about a file that IS unterminated
first, so a green answer below it means something.

| #    | Rule                                                                           | Mutation                                                           | Named test                                                                                             | Result                             |
| ---- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| H-62 | A `$` Compose re-escapes in `config` output is a single `$` before validation  | `nexa-lib.sh`: drop the `$$` → `$` replacement                     | `botctl.test.sh` › status: a dollar Compose re-escapes is measured as the application receives it      | KILLED                             |
| H-63 | A value is measured by its characters, not by the listing's one-line rendering | `nexa-lib.sh`: `nexa_listing_value` returns the rendering          | `botctl.test.sh` › status: a destination that resolves to only a newline is not configured             | KILLED, then SURVIVED, then KILLED |
| H-64 | A refusal repeats Compose's reason, cut before any value Compose echoed        | `nexa-lib.sh`: `nexa_compose_refusal_reason` prints the line whole | `botctl.test.sh` › status: a refusal reports the reason Compose gave, with the value it echoed cut off | KILLED                             |
| H-65 | The rewriter's loadability oracle is live, not an undefined command negated    | `nexa-lib.sh`: `nexa_compose_env_unterminated` returns 1 always    | `botctl.test.sh` › harness: the loadability oracle sees an unterminated file                           | KILLED                             |

**Two more from the review of `3508b74` itself**, before Codex saw it. Compose logs
warnings to stderr BEFORE its error — `The "X" variable is not set. Defaulting to a
blank string.`, one per unset substitution — and the refusal is a plain line after
them; taking the first line and cutting it at its first quote printed `Compose said:
time=` for exactly the interpolation shape that ended the reimplementation. The
resolver reports the first line that is not a logged warning (H-66). And the length
check inherited a regression from its own fix: command substitution drops a trailing
newline, so a quoted value ending its line — 16 characters to the schema, accepted —
measured 15 and read `invalid`; at `898224b` the same value measured 17 and read `on`,
right by accident. `${#}` is also characters under a UTF-8 locale and bytes under
C/POSIX, and `botctl` sets neither, while the schema counts UTF-16 code units.
`nexa_listing_length` counts what the schema counts (H-67).

**H-63 SURVIVED its own follow-up.** The row above was killed on `3508b74` by the
webhook-secret test, and `0a9ebd2` moved that measurement to `nexa_listing_length` —
so on `0a9ebd2` the mutation (`nexa_listing_value` returns the rendering) is green at
212 of 212, found by the review of that head. The rule was still real: every boolean,
the backup destination and the keyring fields read through `nexa_listing_value`. The
row is retargeted to the one consumer that can observe the decode — a chat id that
resolves to only a newline is two non-blank characters in the rendering and nothing to
the application, which `.trim()`s it — and re-run against the current tree. Recorded
as killed, then survived, then killed, because a KILLED row whose mutation is green
is the thing this file exists to prevent.

**H-67's kill count depends on the locale.** The deploy suite runs under POSIX here
and in CI (nothing sets `LANG` or `LC_ALL`), where `${#}` counts bytes: the `${#}`
mutation fails only the trailing-newline assertion (1 of 212), because eight astral
characters are 32 bytes. Under a UTF-8 locale the astral assertion fails too (2 of
212). The astral assertion is not dead — a mutation counting code points instead of
code units dies only there — but the count recorded is the POSIX one.

The fallback branch of the refusal line — used when the filter leaves nothing, which
an error line that itself contains `level=warning` produces (`TOKEN="level=warning`,
measured) — had no test, and its first spelling depended on being called from an
`if`: under errexit and pipefail a `grep` that matched nothing aborted the group
before the fallback ran. It is written as two plain assignments now and H-68 names
the branch.

Two findings from the same review are recorded as accepted rather than fixed. The cut
at the first quote character also shortens a template error — `X=${` produces `Invalid
template: "${"` and reads `Invalid template:` after the cut — because a template can
carry a value as easily as an unterminated quote can, and the class of the error still
names itself. And Compose's warnings on a SUCCESSFUL resolution — one per unset
substitution, each meaning a value was silently blanked — are not surfaced by `status`;
its stderr is kept apart from the JSON so that a warning is not mistaken for a
refusal, and nothing more is claimed for it.

| #    | Rule                                                                                        | Mutation                                                | Named test                                                                                              | Result |
| ---- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------ |
| H-66 | The reported refusal is Compose's error line, not a warning it logged before it             | `nexa-lib.sh`: report the first stderr line again       | `botctl.test.sh` › status: a refusal is the error line Compose printed, not the warning it logged first | KILLED |
| H-67 | The secret is measured in UTF-16 code units, trailing newline included                      | `botctl`: measure `${#}` of the substituted value again | `botctl.test.sh` › status: the secret is measured as the schema measures it, trailing newline and all   | KILLED |
| H-68 | A refusal whose error line the warning filter removes is still reported, from the last line | `nexa-lib.sh`: drop the last-line fallback              | `botctl.test.sh` › status: a refusal whose error line itself says level=warning is still reported       | KILLED |

### Round ten, Codex, on `0a9ebd2`

One finding, P2, CONFIRMED_NON_BLOCKER: the refusal text said "no container will start
and no individual value is in force", which contradicts the readiness rows the same
command prints below it — a container already running keeps the environment it was
created with and may be perfectly healthy. The claim is about creation now: no
container can be created or recreated from the refused configuration, the next
`botctl restart` or `botctl update` will fail, and the running containers are not
described. The named test for H-56 asserts the new wording and the caveat, and
asserts the old claim is gone.
