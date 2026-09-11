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

| #    | Rule                                                                          | Mutation                                                                                | Named test                                                                                           | Result |
| ---- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------ |
| H-01 | `botctl` reads the application's boolean spellings, not a narrower set        | `nexa-lib.sh`: drop `yes` from `nexa_env_boolean`'s truthy arm                          | `config-upgrade.test.ts` › accepts exactly the same spellings in the shell                           | KILLED |
| H-02 | The obsolete-key list is exactly the three build-identity keys                | `nexa-lib.sh`: add `WEB_ADMIN_ORIGINS` to `NEXA_OBSOLETE_APP_ENV_KEYS`                  | `config-upgrade.test.ts` › names the same obsolete keys the upgrade audit does                       | KILLED |
| H-03 | `.env.example` names every variable the application reads                     | `.env.example`: delete the `RECOVERY_UPLOAD_ENABLED` line                               | `config-upgrade.test.ts` › names every one of them, as an assignment or a commented alternative      | KILLED |
| H-04 | Only the retired keyring spelling may be commented out                        | `.env.example`: comment out `RECOVERY_TICK_MS`                                          | `config-upgrade.test.ts` › leaves exactly the retired keyring spelling commented out                 | KILLED |
| H-05 | The canonical keyring is offered before the legacy pair                       | `.env.example`: swap them, so `SECRETS_KEK` is the live assignment                      | `config-upgrade.test.ts` › leads with the canonical keyring, above the legacy pair                   | KILLED |
| H-06 | compose and the installer agree on the default edge subnet                    | `compose.yml`: `172.29.0.0/24` → `172.30.0.0/24`                                        | `config-upgrade.test.ts` › agrees on the edge subnet between compose and the installer               | KILLED |
| H-07 | compose and the installer agree on the default data subnet                    | `install.sh`: `172.29.1.0/24` → `172.31.1.0/24`                                         | `config-upgrade.test.ts` › agrees on the data subnet, in every place compose spells it               | KILLED |
| H-08 | The two networks do not overlap at their defaults                             | BOTH files: move the data subnet onto the edge subnet, so agreement still holds         | `config-upgrade.test.ts` › keeps the two networks from overlapping at their defaults                 | KILLED |
| H-09 | `botctl update` removes configuration the application no longer reads         | `botctl`: replace the `nexa_reconcile_app_env` call with `:`                            | `botctl.test.sh` › update: removes the build identity the first template wrote, and nothing else     | KILLED |
| H-10 | `botctl status` reports the capabilities whose default is off                 | `botctl`: replace the `status_capabilities` call with `:`                               | `botctl.test.sh` › status: an installation that never configured backups is told so                  | KILLED |
| H-11 | The delivery destination is reported by presence, never by value              | `botctl`: print `$chat` and `$token` beside the verdict                                 | `botctl.test.sh` › status: a configured schedule and destination stop the advice, and print no token | KILLED |
| H-12 | A template a real installation was created with still boots on today's schema | `config.schema.ts`: drop `.default(15_000)` from `RECOVERY_TICK_MS`, making it required | `config-upgrade.test.ts` › boots from the 150d8c4.env template through the current schema            | KILLED |

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
