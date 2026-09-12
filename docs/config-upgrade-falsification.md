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

| #    | Rule                                                                          | Mutation                                                           | Named test                                                                                             | Result |
| ---- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ------ |
| H-62 | A `$` Compose re-escapes in `config` output is a single `$` before validation | `nexa-lib.sh`: drop the `$$` → `$` replacement                     | `botctl.test.sh` › status: a dollar Compose re-escapes is measured as the application receives it      | KILLED |
| H-64 | A refusal repeats Compose's reason, cut before any value Compose echoed       | `nexa-lib.sh`: `nexa_compose_refusal_reason` prints the line whole | `botctl.test.sh` › status: a refusal reports the reason Compose gave, with the value it echoed cut off | KILLED |
| H-65 | The rewriter's loadability oracle is live, not an undefined command negated   | `nexa-lib.sh`: `nexa_compose_env_unterminated` returns 1 always    | `botctl.test.sh` › harness: the loadability oracle sees an unterminated file                           | KILLED |

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

**H-63 is retired in round thirteen, after surviving twice.** The row was killed on
`3508b74` by the webhook-secret test; `0a9ebd2` moved that measurement to
`nexa_listing_length` and the mutation went green at 212 of 212; round eleven
retargeted it to the backup destination, and round twelve's presence fix moved THAT to
`nexa_listing_present` — green again at 218 of 218, found by the review of `f0a1b62`.
Twice is the answer: `nexa_listing_value` existed to hand a caller a decoded value, and
no caller needs one. The function is gone. Its rule survives, split across the three
readers that each do their own single pass and so cannot lose a trailing newline to a
command substitution — measured by `nexa_listing_length` (H-67), compared by
`nexa_listing_rendered` (H-73), trimmed by `nexa_listing_present` (H-71, H-75). A row
whose mutation keeps going green is a row about nothing, and this file says so rather
than retargeting it a third time.

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

### Round eleven, Codex, on `116cca0`

Four findings. One is the most serious defect this branch has carried, and it was in
the rewriter three rounds of review had already corrected twice.

**P1, CONFIRMED_BLOCKER — an obsolete record whose quote never closes swallowed the
rest of the file.** `BUILD_COMMIT='pending` with no closing quote is a record the
rewriter is asked to drop. It set `skip` on entering the value and, with no closing
quote to clear it, stayed inside the value to EOF: every later line — the keyring, the
backup destination — was deleted, awk exited 0, and because `DATABASE_URL` precedes
the record the post-write validation passed. An update that reported success had
installed a file missing its encryption key. Reproduced through the real rewriter.
The awk program now exits 3 from `END` when the file ends inside a quoted value,
whatever opened it, and the rewriter leaves the original untouched and says to close
the quote (H-69). Compose refuses such a file whole in any case; the point is that
nothing may delete data from it.

**P2, CONFIRMED_NON_BLOCKER — a provenance that could not be computed was read as
"nothing is overridden".** `nexa_container_overridden_obsolete_keys` returned an
empty SUCCESS when there was no running API or any of three lookups failed, and the
per-key classifier then reported every file key as pending, with the sentence that
the running API does not carry it and `/health/info` is correct for now — the very
fact it could not establish. The function exits 1 on an answer it cannot compute,
and `status` says the running state could not be determined and claims nothing
about `/health/info` (H-70).

**P2, CONFIRMED_NON_BLOCKER — presence by the shell's whitespace, not the schema's.**
`configSchema` trims the backup destination with JavaScript's `.trim()`, whose set
includes the no-break space, the Unicode space separators, the line separators and
the byte-order mark; `[[:space:]]` is the ASCII set. A chat id that is only U+00A0
is nothing to the application and was "configured" to `status`. Python's own
`str.isspace()` is a third set (measured: it lacks U+FEFF and includes U+001C..U+001F
and U+0085), so `nexa_listing_present` spells the ECMAScript set out (H-71).

**P2, CONFIRMED on v5.1.1 — a null entry rendered as an empty assignment.** Recorded
first as not reproducible, and corrected by the review of the fix: a bare `KEY` line in
`env_file` with the host variable unset is OMITTED from `config` output, but a bare
`- KEY` in the compose file's OWN `environment:` list with the variable unset is emitted
as `null` — and `nexa_compose_resolved_env` reads exactly that block. So the shape is
reachable on the measured version, not only by contract. A null rendered as `KEY=` would
turn the schema default into an invalid explicit empty value, which is the
absent-versus-empty lie of U-12 again; the resolver skips null entries, and the fake
states one as JSON (H-72).

| #    | Rule                                                                                | Mutation                                                 | Named test                                                                                                   | Result |
| ---- | ----------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------ |
| H-69 | The rewriter refuses a file that ends inside a quoted value and leaves it unchanged | `nexa-lib.sh`: drop the `END { if (inq) exit 3 }` check  | `botctl.test.sh` › update: an obsolete record whose quote never closes is refused, and the file is UNCHANGED | KILLED |
| H-70 | A provenance that cannot be computed is reported as unknown, never as "no override" | `nexa-lib.sh`: the four early returns back to `return 0` | `botctl.test.sh` › status: a provenance it cannot compute makes no claim about the running API               | KILLED |
| H-71 | Destination presence is decided by the schema's trim set, not the shell's           | `botctl`: presence by `[[:space:]]` again                | `botctl.test.sh` › status: a chat id that is only a no-break space is not configured                         | KILLED |
| H-72 | A null entry in Compose's document is an absent variable                            | `nexa-lib.sh`: render a null as an empty string again    | `botctl.test.sh` › status: a null entry Compose resolved is an absent variable, not an empty one             | KILLED |

### Round twelve, Codex, on `f0a1b62`

Two findings, both CONFIRMED, both about a claim being checked against the wrong
thing.

**P2 — a boolean with a trailing newline read `on`.** Compose lets a quoted value
span lines, so `BACKUP_SCHEDULE_ENABLED='true<newline>'` reaches the container as
`true` with the newline and `booleanish` refuses it. The previous round gave the
LENGTH check a rendering-aware reader but left the VOCABULARY check on
`nexa_listing_value`, whose decode passes through a command substitution — which
drops a trailing newline. So the validator saw `true` and reported a working
schedule for a configuration the next start refuses. Reproduced through the real
function. `nexa_listing_boolean` compares the listing's RENDERING now, where that
value is the five characters `true\n`: no accepted spelling contains a backslash
or a newline, so comparing renderings is exact and needs no decode (H-73).

**P2 — the legacy-template gate covered three of seven shapes.** `git log --
deploy/nexa.env.template` has seven distinct blobs, and the assertion was
`toBeGreaterThanOrEqual(3)`. The omitted four are not interchangeable: `126747d` is
the only template that writes `PANEL_HTTP_DENIED_SUBNETS` (the variable the SSRF
policy reads), `48568f7` the first with a canonical keyring AND an explicit
`SECRETS_ACCEPT_V1=true`, `267dcbd` the first that stopped writing the build keys.
A schema change breaking a host installed from any of them left the gate green. All
seven are committed as fixtures and parsed through the current schema by a named
case each, and the count assertion is now the exact set of seven names rather than a
lower bound (H-74).

| #    | Rule                                                                        | Mutation                                                           | Named test                                                                                  | Result |
| ---- | --------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | ------ |
| H-73 | A boolean is validated as the listing RENDERS it, trailing newline included | `nexa-lib.sh`: `nexa_listing_boolean` back to `nexa_listing_value` | `botctl.test.sh` › status: a boolean with a trailing newline is invalid, not on             | KILLED |
| H-74 | Every distinct released template shape is a fixture, not at least three     | `config-upgrade.test.ts`: the exact set back to a lower bound      | `config-upgrade.test.ts` › has a fixture for every distinct template a release ever shipped | KILLED |

### Round thirteen — self-review of `f0a1b62`, and the end of `nexa_listing_value`

Zero blockers, seven non-blockers, two of which this repository treats as defects in
their own right.

**A KILLED row was green under its own mutation, for the second time.** H-63 said a
value is measured by its characters rather than by the listing's rendering, and named
whichever test happened to read a value through `nexa_listing_value`. Round twelve moved
the last such reader — the backup destination — to `nexa_listing_present`, so the
mutation went green at 218 of 218 again. Retargeting it a third time would say nothing.
`nexa_listing_value` existed to hand a caller a DECODED value and no caller needs one:
`nexa_listing_rendered` compares, `nexa_listing_length` measures, `nexa_listing_present`
trims, each in one pass that cannot lose a trailing newline to a command substitution.
The function is deleted and H-63 is retired with it; the rule survives as H-67, H-73,
H-71 and H-75.

**The ECMAScript whitespace set had no test that distinguished it from the
interpreter's.** `nexa_listing_present` spells the set out because Python trims
U+FEFF and U+001C..U+001F while JavaScript trims the first and not the second — and
`value.strip()` passed the whole suite, because the only fixture was U+00A0, which both
trim. Measured on the real function: a byte-order-mark chat id is absent (the schema
trims it, so the destination is HALF configured) and a file-separator chat id is present
(the schema does not). H-75 pins both, and it is the narrower mutation H-71 could not
see.

Three smaller corrections, all of them claims rather than behaviour: two comments still
described the withdrawn "state 2 for a missing container" (the provenance is unknown
there now); a case said it covered an API that is not running at all while its loop ran
only the three lookup failures (the arm is there now); and the unterminated-record case
asserted the file and the reason but never that the update still SUCCEEDS, which is the
one property the new `nexa_die` risked — `BOTCTL_STATUS` is asserted 0.

One reclassification: U-45 was recorded NOT_REPRODUCIBLE because an `env_file` bare key
is omitted from `config` output on v5.1.1. A bare `- KEY` in the compose file's own
`environment:` list, with the variable unset, IS emitted as null — and that block is
exactly what the resolver reads. The fix was right; the record said "contract" where
"measurement" was available, and now says so.

Also read, and left alone: `nexa_listing_present` cannot distinguish a blank value from
a failed interpreter, which is unreachable because the resolver must already have run
python3 to produce the listing at all.

| #    | Rule                                                                          | Mutation                                                      | Named test                                                                                                   | Result |
| ---- | ----------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------ |
| H-75 | Presence trims the SCHEMA's whitespace set, not the interpreter's             | `nexa-lib.sh`: `nexa_listing_present` back to `value.strip()` | `botctl.test.sh` › status: a chat id that is only a no-break space is not configured                         | KILLED |
| H-76 | A refused removal leaves the update itself successful                         | `nexa-lib.sh`: let the rewriter's die escape the subshell     | `botctl.test.sh` › update: an obsolete record whose quote never closes is refused, and the file is UNCHANGED | KILLED |
| H-77 | An API that is not running makes the provenance unknown, like a failed lookup | `nexa-lib.sh`: the missing-container guard back to `return 0` | `botctl.test.sh` › status: a provenance it cannot compute makes no claim about the running API               | KILLED |

### Round thirteen, Codex, on `035ce6c`

One finding, CONFIRMED_NON_BLOCKER, and it is the webhook lie in the secrets section:
`SECRETS_ACCEPT_V1` is `z.enum(['true', 'false'])`, so `yes` — a spelling several other
settings in the very same output accept — and a value with a trailing newline are
configurations the API REFUSES to start on. The wildcard arm sent both to the
keyring-derived default and labelled the source `default`, describing an acceptance
state no container can reach. Absent still gets the derived default; PRESENT but
outside the vocabulary reads `invalid`, with a sentence saying the API will not start
until the value is one of the two and that nothing below it describes what is read. The
value is never printed.

Codex had raised the same shape in round five, against `fd3f441`, and that thread was
closed when the reader moved to Compose resolution rather than when the vocabulary was
applied — the fix answered the reading, not the validating. Recorded here rather than
silently repaired, because a finding that comes back is evidence about the first
response.

| #    | Rule                                                                       | Mutation                                               | Named test                                                                                          | Result |
| ---- | -------------------------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------- | ------ |
| H-78 | A present `SECRETS_ACCEPT_V1` outside the enum is `invalid`, not a default | `botctl`: the wildcard arm back to the derived default | `botctl.test.sh` › status: an explicit SECRETS_ACCEPT_V1 outside the enum is invalid, not a default | KILLED |

### Round fourteen, Codex, on `5e62dfc`

Two findings, both CONFIRMED_NON_BLOCKER, and both are about a claim being wider than
the evidence behind it.

The first is the refusal paragraph H-78 had just introduced. `no acceptance state is in
force, so nothing below describes what is read` is true of a container that has yet to
be created and false of the one already running, which keeps the environment it was
created with and goes on accepting or refusing v1 exactly as before. The same command
prints a readiness row two lines later, so the paragraph contradicted its own output.
It now says no API can be CREATED or RECREATED from this configuration, names the two
commands that would fail, and says the running API keeps the acceptance it was created
with — the same distinction the capabilities refusal already drew.

The second is `bash -x`. Both sections read the Compose-resolved listing into a local,
and that listing holds `DATABASE_URL`, the keyring and the backup bot token. Presence-only
readers keep those values out of the OUTPUT, which is the property the whole section was
built for; under xtrace the assignment that captures the listing, and every later
expansion of it, printed all of them anyway — in a command whose output is deliberately
safe to paste into a ticket, and `bash -x` is exactly what an operator reaches for when
that command misbehaves. Each section is now a wrapper around `( set +x; …_untraced )`.
A subshell rather than a save-and-restore pair: both bodies have several early returns,
and a restore that one of them skipped would leave tracing off for the rest of the run.

The new test traces a real `botctl status` and asserts the keyring, the token and the
database password are absent from the trace. It also asserts the trace contains `+ ` and
the status output contains `capabilities`, because without those two a botctl that
printed nothing at all would pass. That guard earned itself immediately: the first
version of the test invoked the installed copy under a path the harness does not use,
botctl answered `unknown command`, and the three secret assertions were passing
vacuously.

Two unit assertions extracted `status_capabilities` and `status_secrets` by name to
prove each asks Compose, so the split moved their subject out from under them. They
now read the `_untraced` body for that question and the wrapper for the new one, which
means the H-80 mutation is caught at two levels: removing the wrapper fails three
checks in the deploy suite and two assertions in the unit suite.

| #    | Rule                                                                                | Mutation                                                          | Named test                                                                                          | Result |
| ---- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------ |
| H-79 | The invalid-acceptance refusal is about creation, not about the API already running | `botctl`: the paragraph back to "no acceptance state is in force" | `botctl.test.sh` › status: an explicit SECRETS_ACCEPT_V1 outside the enum is invalid, not a default | KILLED |
| H-80 | A traced `botctl status` prints no resolved value                                   | `botctl`: both sections back to running in the traced shell       | `botctl.test.sh` › status: a traced run prints no resolved value                                    | KILLED |

### Round fifteen — self-review of `d9cdc0a`, and Codex on the same head

Two reviews found the same defect independently, which is the strongest evidence on this
branch that it was real: the sentence round fourteen added to the invalid-acceptance
refusal, `the rows below are read by it`, is false in every state in which it prints.

The rows come from `nexa_compose run --rm --no-deps api dist/secrets.cli.js status
--json`. `compose run` creates a ONE-OFF container from the CURRENT configuration, never
from the API already running, so no row can be attributed to a running API. And in the
state where this paragraph prints, no row exists at all: `secrets.cli.ts` calls
`loadConfig()` as the first statement of `main()`, `SECRETS_ACCEPT_V1` is
`z.enum(['true','false'])`, so the one-off exits before it reaches the database and the
only row is `v1 rows unable to determine (the application could not read the database)` —
whose parenthetical is wrong too, because the database was never reached.

Worse if it ever did answer. `$accept` gained a third value in round thirteen and the
branches below it test only `no` and `yes`, so an `invalid` acceptance falls past every
guard to `v1 shutdown complete: no v1 ciphertext, v1 not accepted` — an acceptance state
no container can reach, which is precisely the lie H-78 was written to kill. The previous
wording at least disclaimed the rows; the new wording endorsed them, and two assertions
had been added that locked the endorsement in. **The fix for a lie reintroduced the lie
one layer down.** The section now RETURNS before the rows, which makes the fall-through
unreachable rather than merely unlikely, and says why no row is shown so the absence
cannot be read as a stack that is down.

The wording is corrected in the other direction too: Compose does NOT refuse here — the
listing resolved, which is how the value was read at all — so the container IS created
and then exits on the schema error. `no API can be CREATED` sent an operator away from
`botctl logs api`, where the reason is. It says the API will not START, and names the log.

**Three more, and two of them are the same class as the round-fourteen finding: a secret
in a variable under `bash -x`, in the commands that round did not look at.**

`botctl secrets migrate-config` printed the master key SIX times and then printed that
the key material `was never printed`. It holds the key by necessity — it reads
`SECRETS_KEK` out of the file and writes it back under the canonical name — and every
capture, blank test, `id:key` concatenation, rewrite and read-back traced with the value
in it. It is also the command `botctl status` sends an operator to, and one they run under
`-x` precisely because it rewrites `/etc/nexa/nexa.env`. Measured before the fix, on the
legacy fixture: 6 occurrences of the key, 1 of the database password, and the false claim.
After: 0, 0, and the claim is true.

`nexa_env_rewrite` leaked on EVERY call, including from commands that write nothing
secret: it proves the candidate file would still boot by reading `DATABASE_URL` back out
of it, and under `-x` that expansion printed the database password. `botctl secrets
disable-v1` writes one boolean and leaked the database URL anyway. `botctl update` takes
the same path but captures the subshell's stderr, which is why `disable-v1` and not
`update` is the case that can observe the rule.

Both are fixed by `nexa_untraced`, and it is a save-and-restore rather than the subshell
the two `status` sections use. The difference is `nexa_die`: every refusal in these two
functions must end the COMMAND, and inside a subshell it would end only the subshell while
the caller carried on as though nothing had been refused. `nexa_die` exits the process, so
the restore is reached only on the paths that return — the only paths where it matters.

The last one is the refusal redaction, and it is the second channel by which a value out
of `nexa.env` reaches a paste-safe output. The cut-at-the-first-quote rule handles the
echoed value of an unterminated quote. It does nothing about Compose's required-variable
forms, which put the OPERATOR'S text in the diagnostic — and that text needs no quote.
Measured on v5.1.1 with `SECRETS_KEYS=${KEYRING:?k1:<key material>}` and `KEYRING` unset:

```
failed to read /tmp/cprobe/nexa.env: required variable KEYRING is missing a value: k1:SUPERSECRETKEYMATERIAL
```

Everything from that marker on is withheld now and the marker itself is kept, so Compose's
own prose still reads whole and the variable NAME, which is what an operator needs and is
not a value, survives.

**One test weakness of my own, found by the same review and worth recording because it is
the guard I had just congratulated myself on.** The trace test asserted the output
contained `capabilities` to prove the section had really run. Under `bash -x` the call
itself traces as `+ status_capabilities`, which contains that word — so the guard passed
with `compose_config_fails=1` (both sections print REFUSED and never read the listing) and
passed with both bodies replaced by `return 0`, which is verbatim the failure the guard was
written to prevent. It now asserts `backup delivery    configured` and `configuration
canonical`, two rows that can only be produced by the section's own formatted output (a
trace would echo the format string, carrying `%-8s`, not the value) and only reached
THROUGH the resolved listing.

| #    | Rule                                                                           | Mutation                                                                 | Named test                                                                                             | Result |
| ---- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ------ |
| H-81 | An invalid acceptance prints NO row, rather than falling through to the guards | `botctl`: drop the `return 0` so the row block runs                      | `botctl.test.sh` › status: an explicit SECRETS_ACCEPT_V1 outside the enum is invalid, not a default    | KILLED |
| H-82 | `secrets migrate-config` runs with tracing off                                 | `botctl`: call the body directly instead of through `nexa_untraced`      | `botctl.test.sh` › secrets migrate-config: a traced run prints no key material                         | KILLED |
| H-83 | The env rewriter runs with tracing off                                         | `nexa-lib.sh`: call the body directly instead of through `nexa_untraced` | `botctl.test.sh` › a traced disable-v1 prints no database password                                     | KILLED |
| H-84 | The standing caveat is keyed to container CREATION, not to `botctl restart`    | `botctl`: the caveat back to "since the last `botctl restart`"           | `botctl.test.sh` › status: the section names COMPOSE as its resolver and claims nothing more           | KILLED |
| H-85 | Compose's required-variable error text is redacted like a quoted value         | `nexa-lib.sh`: drop the `is missing a value` cut                         | `botctl.test.sh` › status: a refusal reports the reason Compose gave, with the value it echoed cut off | KILLED |

Counts, each with the restore confirmed by `cmp` against a pre-mutation snapshot: H-81
fails 2 of 223, H-82 1, H-83 1, H-84 3, H-85 1, and H-80 re-run on this tree still fails 3.

**H-84 SURVIVED its first run and is recorded that way.** The batch script applied it
through a `python3 -c` whose nested quoting was a syntax error, so nothing was mutated and
223 checks passed — a survivor that proved only that the mutation had not happened. Re-run
from a script file, with the applied text grepped out of `botctl` before the suite ran, it
fails 3 checks. This is the second time on this branch that a mutation recorded as applied
was not: the discipline that catches it is proving the mutation landed, not trusting the
runner.

### Round sixteen — self-review of `69335e1`

One CONFIRMED_BLOCKER, and it is the same shape as the one round fifteen fixed: a
correction that over-corrected. The fix for U-57 replaced an incomplete claim with a
**universal negative that is false**.

```
  `botctl restart`, `botctl update` and `botctl rollback` each bring the stack up, so a
  successful one of those has already loaded these values; nothing else here does.
```

`botctl secrets disable-v1` brings the stack up too — `nexa_compose up -d
--remove-orphans`, twice, at the apply and at the back-out — and its own header says
that is the point: "the setting is applied rather than merely written". It is also the
one command the v1 shutdown sequence ends with. So an operator who edited `nexa.env`,
ran `disable-v1`, and then ran `status` was told their change was not in force and that
only three other commands could load it. That is U-57 reintroduced one command over,
and the round-fifteen test asserted the sentence verbatim, which is exactly how the
round-fourteen assertions locked in the round-fourteen lie. Enumerated from `main`'s
dispatch rather than from memory this time: `version`, `status`, `backup`, `logs`,
`help` create nothing; `secrets status|rewrap|retire-check|shutdown-check` are
`compose run --rm` one-offs; `secrets migrate-config` writes only; `update`,
`rollback`, `restart` and `secrets disable-v1` bring the stack up. There is no
`enable-v1` in this tree at all, which a previous note had assumed there was.

**And the replacement claim is not establishable, which is the more serious half.**
"a successful one of those has already loaded these values" assumes `compose up -d`
recreates a container when only `env_file` CONTENT changed. Measured on the pinned
client, v5.1.1, with `docker compose config --hash='*'`:

```
baseline                                        api 5fc5df86…
append BACKUP_SCHEDULE_ENABLED=true to env_file api 5fc5df86…   unchanged
change DATABASE_URL's password in env_file      api 5fc5df86…   unchanged
change an inline `environment:` value           api c26660b1…   CHANGED
```

The service config hash is what `up -d` compares against the running container's
`com.docker.compose.config-hash` label, and it does not track `env_file` content.
Whether the daemon recreates anyway cannot be measured here, and it is not measured in
the repository either: the deploy suite runs against a fake docker, and both smoke
scripts write `nexa.env` BEFORE the first `up`.

**This repository has already hit this exact mechanism once.** `cmd_restart` carries
the comment that "a plain `up -d` leaves the edge container alone, because replacing a
bind-mounted file changes no service definition, and the operator would run the command
they were told to run and see no change" — and the fix was to make the edge's
generation an interpolated value so the definition itself changes. `nexa.env` has had
no equivalent. That is strong enough to stop claiming, and not strong enough to claim
the opposite.

So the paragraph now says only what holds under either answer: a container keeps the
configuration it was created with, anything changed since it was created is not in
force in it, only RECREATING it loads the change, `botctl restart` is the command for
that, and these rows do not say whether your last one already did. `UNK-DEPLOY-001` in
`docs/open-questions.md` carries the measurement, the edge precedent, the reason it
cannot be settled here, and the three-command check that settles it on the first real
server — with the remedy named if the answer is no.

Four smaller ones, all CONFIRMED_NON_BLOCKER:

- **The comment justifying the trace blindness handed the reader a command that cannot
  work.** It said `docker compose --env-file /etc/nexa/nexa.env config` reproduces the
  resolution. `--env-file` is the interpolation source for the compose FILE, not the
  services' `env_file`, and pointed at `nexa.env` it fails outright because `nexa.env`
  carries no `NEXA_IMAGE`. It now gives the invocation `nexa_compose` actually uses and
  says why the other one is wrong. `CLAUDE.md` names this class: three separate fixes on
  the deployment branch each told an operator to run a command that could not work.
- **"every row in this section" contradicted the two rows printed immediately above it**
  — the configuration and the acceptance, which come from the resolved listing and not
  from any container. It says `every row BELOW`, and names where the two above came from.
- **The required-variable cut is silent, and it cuts guidance as well as values.**
  `deploy/compose.yml` uses `${VAR:?text}` four times and that text is operator guidance
  (`NEXA_IMAGE must be an image digest reference`), reachable exactly when the
  capabilities section prints `REFUSED by compose`. It is still cut, because this
  function cannot tell guidance from a keyring — but a withheld note is appended, so the
  loss is never silent.

  **The first version of that note was eaten by the very cut it announces.** It was
  appended inside the string, before the quote cut, and contained the apostrophe in
  `Compose's message` — so the redaction removed the notice that a redaction had
  happened, and the new assertion caught it on its first run. The note is added after the
  quote cut and outside the 200-character bound now, because it is this function's own
  words and not Compose's, and the comment says nothing there may contain a quote.

- **`nexa_untraced`'s two locals sat in the dynamic scope of everything the body calls.**
  A callee assigning a bare `status=` and then succeeding would have made the wrapper
  return that value. Nothing does; the names are prefixed now so it stays that way. The
  errexit suppression that `|| status=$?` introduces is documented with the invariant
  that makes it safe — every failure in both bodies is a `nexa_die`, enumerated — because
  the next unguarded command added to the rewriter would fail OPEN.

**One rule had no test, found by mutation rather than by reading.** Deleting
`nexa_untraced`'s restore line left all 223 checks green: every command that uses the
helper has nothing traced after it returns, so no command-level case can see the
restore. A new case calls the helper directly and asserts both directions — tracing on
before stays on after, tracing off before stays off — and the status pass-through for
0, 1 and 7.

| #    | Rule                                                                        | Mutation                                                                               | Named test                                                                                             | Result |
| ---- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------ |
| H-86 | The caveat claims nothing about whether a restart already loaded the values | `botctl`: the caveat back to "has already loaded these values; nothing else here does" | `botctl.test.sh` › status: the section names COMPOSE as its resolver and claims nothing more           | KILLED |
| H-87 | `nexa_untraced` restores tracing exactly as it found it                     | `nexa-lib.sh`: delete the `set -x` restore                                             | `botctl.test.sh` › nexa_untraced turns tracing off and puts it back exactly as it found it             | KILLED |
| H-88 | A required-variable cut is never silent                                     | `nexa-lib.sh`: drop the withheld note from the cut                                     | `botctl.test.sh` › status: a refusal reports the reason Compose gave, with the value it echoed cut off | KILLED |
| H-89 | The no-rows paragraph disowns only the rows BELOW it                        | `botctl`: back to "every row in this section"                                          | `botctl.test.sh` › status: an explicit SECRETS_ACCEPT_V1 outside the enum is invalid, not a default    | KILLED |

Counts, each restore confirmed by `cmp` against a pre-mutation snapshot and each mutation
grepped out of the file before the suite ran: H-86 fails 4 of 224, H-87 1, H-88 2, H-89 2.
H-87's mutation is the one that was missing a test at all — deleting the restore line left
223 green before the new case existed.
