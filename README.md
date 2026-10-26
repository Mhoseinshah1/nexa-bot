# Nexa Bot

A tenant-aware Telegram platform for selling and managing VPN/proxy services.

Customers browse, buy, renew and manage services in a Telegram bot or in a
Telegram Mini App. Operators run the business from a Persian right-to-left Web
Admin. Paid orders are provisioned automatically on the operator's own panels.
Nexa is a from-scratch replacement for MirzaBot, a PHP system whose behaviour
was reverse-engineered; the research is in `docs/research/` and the decisions
taken from it are in `docs/adr/`.

Stack: TypeScript, NestJS, PostgreSQL 16, Redis, React. One codebase, several
process roles (`api`, `worker`, `monitor`, `provisioner`, `recovery`).

## Features

- **Telegram bot.** Catalogue, orders, wallet, renewals, extra traffic or time,
  trials, referrals, support tickets, broadcasts. All customer text is Persian
  and comes from editable message templates. See `docs/telegram-runtime.md`.
- **Web Admin.** Customers, catalogue and pricing, discounts and cashback,
  resellers, payments and refunds, panels, templates, settings, feature flags,
  audit log, backups and recovery. Sign-in uses argon2id passwords, server-side
  sessions and per-admin permissions, denied by default.
- **Telegram Mini App.** A customer surface served by the API under `/miniapp`,
  authenticated with Telegram `initData`: store, checkout, wallet, services,
  referral and support.
- **Payment gateways.** TonPays, TonPays (Telegram), TetraPay, NOWPayments,
  CentralPay, Rialit and Telegram Stars, plus card-to-card receipts reviewed by
  an operator. A gateway callback only prompts a check; the provider's own
  inquiry decides whether money is credited. Balances are derived from an
  append-only ledger; money is `bigint` minor units with a currency. TonPays is
  built but not yet accepted against the real provider (`docs/project-status.md`).
- **Panels.** Marzban, 3x-ui (MHSanaei) and RickPanel adapters, encrypted
  credentials, a background health monitor and automatic provisioning of paid
  orders. An order that cannot be delivered is refunded, not queued.
- **Operations group and logs.** A Telegram forum group with one topic per
  concern (payments, panels, errors, backups, security, ...) that receives
  operational events. See `docs/ops-log-topics.md`.
- **Backups and disaster recovery.** Scheduled, encrypted database backups that
  are restore-tested before delivery to Telegram, and a Web Admin recovery lane
  that restores one. See `docs/backup.md`, ADR-0025 and ADR-0028.
- **MirzaBot cutover tooling.** A `.nxpkg` import with balance reconciliation
  and a staged runbook, with rollback, for moving an existing MirzaBot
  installation. See `docs/cutover/` and `docs/legacy-migration/`. The runbook is
  prepared but has not been run in production; read its status page first.

## Requirements

From `docs/deployment.md` and `deploy/install.sh`; the installer checks these
before it changes anything:

- Ubuntu 22.04 LTS or 24.04 LTS, on `x86_64` or `aarch64`.
- At least 8 GB free on `/var`. No CPU or memory minimum is documented.
- Ports 80, 443/tcp and 443/udp free and reachable.
- A DNS name already pointing at the host.
- Docker Engine with Compose v2. The installer adds it from Docker's apt
  repository if missing; an incompatible existing Docker is reported, not
  replaced.
- A Telegram bot token and the numeric Telegram id of the first owner.

## Install

Never pipe a remote script into a shell (`curl | sh`). A release publishes a
container image, pinned by digest, with build provenance and an SBOM. It does
not publish a signature or checksum for `install.sh`: the installer comes from
this repository at the release tag. Check out the tag and compare its commit
with the one in the release workflow's job summary before running it:

```bash
git clone https://github.com/Mhoseinshah1/nexa-bot && cd nexa-bot
git checkout v1.0.0 && git rev-parse HEAD   # compare with the release job summary
sudo ./deploy/install.sh --domain admin.example.com --acme-email ops@example.com --version v1.0.0
```

Use the release you are installing instead of `v1.0.0`. The installer prompts
for the first owner's password and the bot token (hidden input; neither is ever
a command-line argument), generates secrets once, migrates, starts the stack and
registers the Telegram webhook. It is safe to rerun after a failure. Unattended
installs are covered in `docs/deployment.md`, which also lists image signature
verification as outstanding hardening.

## Operating with `botctl`

`botctl` is installed at `/usr/local/bin/botctl`; `botctl --help` lists
everything.

```bash
botctl status            # what is running, and whether it is ready
botctl version           # installed version, source commit, image digest
botctl backup            # a consistent PostgreSQL dump
botctl update v1.0.1     # update to a release, by digest
botctl rollback          # previous release's image (never restores data)
botctl logs [SERVICE]    # follow logs
botctl telegram status   # local and Telegram-side webhook state
botctl cutover preflight # read-only MirzaBot cutover checklist
```

It also has `restore`, `restart`, background `roles`, `secrets` (rewrap,
retire-check, key migration) and `admin` two-step sign-in recovery.

## Development

Requires Node 22 and pnpm 10. PostgreSQL 16 and Redis 7 come from Docker, or
natively if no Docker daemon is available.

```bash
pnpm install
cp .env.example .env     # replace the SECRETS_KEYS placeholder, see the file
bash scripts/dev-services.sh
pnpm db:migrate:dev && pnpm db:seed:dev
pnpm admin:bootstrap:dev               # first owner
pnpm build                             # the start scripts run compiled output
pnpm --filter @nexa/api start:api      # API, health, Telegram webhook
pnpm --filter @nexa/api start:worker   # outbox relay and notifications
pnpm --filter @nexa/web dev            # Web Admin on :5173
```

```bash
pnpm verify              # typecheck, lint, boundary checks, i18n, unit tests, build
pnpm test:integration    # against real PostgreSQL and Redis
pnpm db:check            # schema and migrations agree
```

## Documentation

| Document                   | Covers                                        |
| -------------------------- | --------------------------------------------- |
| `docs/project-status.md`   | Phase status and the standing owner decisions |
| `docs/architecture.md`     | Modules, process roles, the write path        |
| `docs/conventions.md`      | Coding rules and the failures they prevent    |
| `docs/deployment.md`       | Installing, operating, updating, rolling back |
| `docs/vps-acceptance.md`   | Checklist for the first real staging server   |
| `docs/backup.md`           | Backups, restore and retention                |
| `docs/telegram-runtime.md` | How the bot is structured                     |
| `docs/cutover/`            | MirzaBot to Nexa production cutover runbook   |
| `docs/open-questions.md`   | Unresolved product decisions                  |
| `docs/adr/`                | Architecture decisions and rejected options   |

## Licence

Proprietary. All rights reserved.
