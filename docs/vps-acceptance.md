# First real VPS acceptance

The checklist to run on a **fresh Ubuntu staging VPS** before this deployment
model is trusted with a customer. CI proves the pieces work; this proves the
whole thing works on a real host with real DNS and a real certificate — the two
things CI cannot have.

**Nothing in this repository has been run against a real server.** No code in
this checkpoint accesses one, and none should be run against a production
installation until this checklist has passed on staging.

## Before you start

- A VPS running Ubuntu 22.04 or 24.04, x86_64 or arm64, ≥ 8 GB free on `/var`.
- A DNS `A`/`AAAA` record for the panel hostname pointing at it, already
  propagated. Check with `dig +short admin.staging.example.com`.
- Ports 80 and 443 open to the internet at the provider's firewall.
- If the release package is private: a GHCR token with `read:packages`.
- A second terminal, so a failed step can be diagnosed without losing the first.

Record the answers as you go. A checklist with no recorded output is a
checklist somebody remembers passing.

## 1. Install from zero

```bash
git clone https://github.com/Mhoseinshah1/nexa-bot && cd nexa-bot/deploy
sudo ./install.sh --domain admin.staging.example.com \
                  --acme-email ops@example.com \
                  --version v1.0.0
```

- [ ] Preflight passes and names the OS, architecture and free space.
- [ ] Docker Engine and the Compose plugin are installed (or already present).
- [ ] The installer never asks to open a firewall port.
- [ ] The first owner prompt hides the password and asks for confirmation.
- [ ] A password shorter than twelve characters is refused with one sentence
      that says how long it must be — not a stack trace.
- [ ] **The owner step returns.** The first attempt at this checkpoint printed
      `Owner "..." created` and then hung: the CLI held stdin open, so
      `docker compose run --rm` never returned and the install stopped one step
      before recording the release. The install must reach its summary on its
      own, without a Ctrl+C.
- [ ] It finishes with the panel URL and the `botctl` summary.
- [ ] `sudo botctl version` names the installed version, commit and digest —
      not "no current release is recorded".

## 2. Nothing secret was printed

- [ ] Scroll back through the entire installer output. No database password, no
      Redis password, no KEK, no owner password appears.
- [ ] `sudo ls -la /etc/nexa` — the directory is `0700`, every file `0600`,
      all owned by `root`.
- [ ] `history | grep -i pass` finds nothing from the install.

## 2b. A rerun finishes an interrupted install

- [ ] Rerun the exact same `install.sh` command line. It reports that the first
      owner already exists from an earlier run, asks for no password, and
      completes.
- [ ] `sudo botctl version` and `sudo botctl status` agree with each other and
      with the version installed.
- [ ] Exactly one administrator can log in — the rerun created no second owner.

## 3. HTTPS and the panel

- [ ] `curl -I https://admin.staging.example.com` returns 200 with a valid
      certificate (no `-k` needed). The first request may take a few seconds
      while the certificate is issued.
- [ ] `curl -I http://admin.staging.example.com` redirects to HTTPS.
- [ ] The panel loads in a browser with no certificate warning.
- [ ] Logging in as the first owner succeeds, and the session persists across
      a reload. (If login appears to succeed and then immediately logs out, the
      `__Host-` cookie is not being stored — check the origin is exactly the
      configured domain.)
- [ ] `curl -s -o /dev/null -w '%{http_code}' https://admin.staging.example.com/health/info`
      returns **401** when signed out.

## 4. The services

- [ ] `sudo botctl status` shows `caddy`, `api`, `worker`, `postgres` and
      `redis` running, and readiness `ready`.
- [ ] `sudo botctl version` prints a version, a commit and a digest.
- [ ] The digest matches the one in the release job's summary for that version.

## 5. The database and Redis are not public

From **another machine**, not the VPS:

- [ ] `nc -zv <vps-ip> 5432` is refused or times out.
- [ ] `nc -zv <vps-ip> 6379` is refused or times out.

On the VPS:

- [ ] `sudo ss -ltnp | grep -E ':(5432|6379)'` prints nothing.

## 6. Reboot

```bash
sudo reboot
```

- [ ] The host comes back.
- [ ] Without any manual action, `sudo botctl status` reports ready again
      (allow a minute or two).
- [ ] The panel loads and the existing session or a fresh login works.

## 7. Backup

```bash
sudo botctl backup
```

- [ ] It reports a path and a size in bytes of SQL.
- [ ] `sudo ls -la /var/backups/nexa` — the file is `0600`.
- [ ] `sudo gzip -dc <file> | head -20` shows real SQL.
- [ ] `sudo gzip -dc <file> | tail -3` ends with the pg_dump completion marker.

## 8. Update

Publish a second release (a trivial change is enough), then:

```bash
sudo botctl update v1.0.1
```

- [ ] A backup is taken before the migration, and its filename names **both**
      releases — `nexa-v1.0.0-before-v1.0.1-<stamp>.sql.gz`. It sits between two
      schemas, so a name claiming one of them would be a claim nobody can check.
- [ ] The migration runs and reports success.
- [ ] `botctl version` reports the new version, commit and digest, and prints
      no `unknown` and no `DIVERGENCE`.
- [ ] `/var/lib/nexa/releases/v1.0.1.json` exists. Without it, `botctl version`
      goes blank and the NEXT update leaves the installation unable to roll
      back at all.
- [ ] The panel still works and you are still logged in.
- [ ] **The browser receives the NEW Web Admin**, not the old one. This is the
      CONFIRMED staging defect of v0.1.0-staging.9 → .11: everything above
      passed, `botctl update` reported SUCCESS, and Caddy stayed the old
      long-running container serving the previous release's asset root. A
      container being HEALTHY is not evidence. Force-reload the panel (Ctrl+F5)
      and check that a hashed asset from the NEW release is what loads —
      `curl -sI https://<host>/` plus the `<script src>` in the HTML is enough.
- [ ] `sudo botctl status` reports the same value for `edge configuration:` and
      `edge container:`. A difference means the running edge is on another
      release's config, and status names the command that fixes it.
- [ ] `/var/lib/nexa/previous` names `v1.0.0`.
- [ ] The `v1.0.0` release manifest still exists.

### While the update runs

In the second terminal, during the update:

- [ ] `sudo botctl update v1.0.1` (again) or `sudo botctl rollback` refuses
      with "already running".

## 9. Rollback

```bash
sudo botctl rollback
```

- [ ] It reports returning to `v1.0.0` and says the database was not touched.
- [ ] `botctl version` reports `v1.0.0` and its digest.
- [ ] The panel works.
- [ ] **The browser receives v1.0.0's Web Admin again**, and
      `botctl status` agrees about the edge. The edge transition has to be
      symmetric: an update that moves it forward and a rollback that does not
      move it back leaves the operator on a UI the running release did not
      ship.
- [ ] **Data written under v1.0.1 is still present.** Create something
      identifiable before the rollback — change a setting, send a test
      notification — and confirm it survives.

## 10. Update again

```bash
sudo botctl update v1.0.1
```

- [ ] It succeeds, proving the installation is not stuck after a rollback.

## 11. Reinstall safety

```bash
sudo ./install.sh --domain admin.staging.example.com \
                  --acme-email ops@example.com --version v1.0.1 --skip-owner
```

- [ ] It completes without regenerating secrets.
- [ ] The existing owner can still log in — proof the KEK and the database
      password were not replaced.
- [ ] No data was lost.

## 12. Failure behaviour

Worth doing once, on staging, so the behaviour is known rather than assumed:

- [ ] `sudo botctl update v99.0.0` (a version that does not exist) fails,
      names the problem, and leaves the installation running.
- [ ] `sudo docker stop nexa-postgres-1` then `sudo botctl status` reports NOT
      READY rather than claiming health. Start it again and confirm recovery.
- [ ] `sudo ./install.sh --domain … --acme-email … --version v1.0.1` on the
      host now running v1.0.0 **refuses** and points at `botctl update`. The
      installer takes no backup and records no rollback target, so accepting a
      version change would silently destroy the ability to roll back.
- [ ] Edit `NEXA_IMAGE` in `/etc/nexa/deploy.env` to any other digest, then run
      `sudo botctl version`. It reports `DIVERGENCE`, names what would actually
      start, and exits non-zero. This is the state an interrupted update leaves,
      and it used to be undetectable. Put the value back afterwards.

## 12b. Restore from the Web Admin, on the real box

This is the part no test can do for you, and it is the reason the rest of this
document exists: a restore that works in CI and not on your server is a restore
you do not have. Do it on a box with nothing on it you mind losing, and do it
BEFORE you need it.

The `recovery` process role has to be running for any of this to complete — it is
the only thing that performs a restore. Check it first:

```bash
sudo botctl status            # the recovery container is up
sudo docker compose -f /opt/nexa/deploy/docker-compose.yml logs --tail=20 recovery
```

Then, signed in as the owner, open **بکاپ و بازیابی** under **سامانه و عملیات**:

- [ ] The page lists the backups `botctl backup` and the scheduler have taken.
- [ ] «تهیه بکاپ جدید» produces a new row that reaches `SUCCEEDED` with
      «بازگردانی واقعی انجام شد» — the run verified itself by restoring.
- [ ] Pressing it a second time while the first is running reports
      «یک بکاپ همین حالا در حال اجراست.» and does NOT start a second.
- [ ] «دریافت آرشیو رمزشده» downloads a file. `file <downloaded>` says `data`,
      not SQL, and `head -c 8 <downloaded> | xxd` is not readable text. If it
      reads as SQL, stop: that is a plaintext dump leaving the server.

Now write something you can recognise, so "it restored" is a statement about
CONTENT rather than about an exit code. A template body is a good choice — it is
visible in the Web Admin and belongs to no customer:

- [ ] Edit any template, note the exact text, and take a backup AFTER the edit.
- [ ] Change the same template again to something different.
- [ ] Upload the archive from the step before, verify it, and read the result:
      the decrypted manifest's database name, its time, and a restore test
      reporting tables restored and a migration verdict. Nothing on this screen
      should contain a key, a connection string or a password.
- [ ] Type `RESTORE NEXA` exactly. Check that a lower-case `restore nexa` leaves
      the button disabled.
- [ ] Confirm. Watch the request's stage advance: the pre-restore backup, the
      quiesce, the candidate, the cutover, then readiness.
- [ ] While it is restoring, try to save a setting in another tab. It must be
      REFUSED, not silently ignored.
- [ ] When it reports success, the template holds the text from the FIRST edit.
      That is the only proof that matters.
- [ ] `sudo -u postgres psql -c "SELECT datname FROM pg_database"` shows a
      `nexa_pre_restore_*` database. It is your rollback and nothing will remove
      it. Note its name; drop it only once you are satisfied.
- [ ] `sudo botctl status` is healthy and `/health/ready` is ready afterwards.
- [ ] The report group received the recovery's own event, and that message
      contains identifiers and a code — no stack trace, no file path, no secret.

Then the refusals, because a restore you cannot trust to REFUSE is worse than one
that does not work:

- [ ] Upload a file that is not a Nexa archive — make one with
      `head -c 1000 /dev/urandom > junk.nxb`. It must fail with a code and leave
      nothing behind in the recovery work directory.
- [ ] Flip one byte in the middle of a real archive and upload it. It must fail
      authentication — not "succeed with a warning".
- [ ] `sudo ls -la <RECOVERY_WORK_DIR>` after all of the above: no world-readable
      files, and no leftover directory for a recovery that failed.

## 12c. Does a `nexa.env` edit actually reach a container?

Everything `botctl status` tells an operator to do ends "set it in
`/etc/nexa/nexa.env` and run `botctl restart`". That advice has never been watched
against a real daemon. `UNK-DEPLOY-001` in `docs/open-questions.md` establishes from the
Compose binary that `up -d` resolves `env_file` into the service environment before
hashing, and that the hash is what decides recreation — a deduction, not an observation.
This is the observation, in three numbered steps.

One key, not a dump: `.Config.Env` holds `DATABASE_URL`, `SECRETS_KEYS` and the backup
bot token, and this whole checklist is about a box you are pasting output from.

The key is `LOG_LEVEL`, and the choice matters. It is written by
`deploy/nexa.env.template`, so the installer puts it in every `nexa.env` — which means
the `sed` below has something to match. A key the template does NOT write (an optional
one like `BACKUP_SCHEDULE_ENABLED`, say) would make the `sed` a silent no-op, and a
no-op's empty output is indistinguishable from the propagation failure this step exists
to detect: the step would read as refuting the deduction whenever it was run, on a host
where nothing was wrong. That is why step 1 exists — it proves the key is there before
anything is deduced from the absence of a value.

```bash
# 1. The key this step edits must already be in the file. If this prints
#    nothing, STOP: nothing below proves anything either way.
grep -n '^LOG_LEVEL=' /etc/nexa/nexa.env

# 2. Change it, and confirm the change landed in the FILE before restarting.
sudo sed -i 's/^LOG_LEVEL=.*/LOG_LEVEL=debug/' /etc/nexa/nexa.env
grep -n '^LOG_LEVEL=' /etc/nexa/nexa.env

# 3. Restart, and read the value back out of the container.
sudo botctl restart
sudo docker inspect nexa-api-1 \
  --format '{{range .Config.Env}}{{println .}}{{end}}' | grep '^LOG_LEVEL='
```

Step 1 must print `LOG_LEVEL=info`, step 2 `LOG_LEVEL=debug`, and step 3 `LOG_LEVEL=debug`.
Then put it back, because `debug` logs every request this installation serves:

```bash
sudo sed -i 's/^LOG_LEVEL=.*/LOG_LEVEL=info/' /etc/nexa/nexa.env
sudo botctl restart
```

**If step 1 printed nothing:** this installation's `nexa.env` does not set `LOG_LEVEL` at
all, which the installer would not produce. Find a key the file does set and use that
one; do not record a result from an edit that changed nothing.

**If steps 1 and 2 printed what they should and step 3 prints `LOG_LEVEL=info` or
nothing:** the deduction is wrong, every `run botctl restart` remedy in `botctl status`
is advice that cannot work, and `botctl secrets disable-v1` reports «v1 ciphertext is no
longer accepted» for a container that still accepts it. The fix is the one the edge
already uses: fingerprint `nexa.env` and interpolate that fingerprint into the service
definitions, so a content change becomes a definition change. Reopen `UNK-DEPLOY-001`
with what you saw.

## 13. Delegation, if you delegate

Only if `botctl` is reachable through `sudo` for a non-root operator:

- [ ] `sudo env NEXA_LIB=/tmp/anything botctl status` refuses and names the
      variable. Honouring it would let whoever ran sudo choose the code this
      host executes as root.
- [ ] Note the `env` in that command. Written as `NEXA_LIB=… sudo botctl
status`, the variable is set in **sudo's** own environment, where `env_reset`
      strips it before botctl ever sees it — so that spelling proves nothing either
      way, whichever result you get.
- [ ] The sudoers rule keeps `env_reset` (it is the default; check for an
      `env_keep` or `SETENV` that turns it off). botctl's own refusal is a
      backstop: `BASH_ENV` is read by bash **before** the script runs, so no
      check inside it can be reached in time.

## Sign-off

| Item                                   | Result | Notes |
| -------------------------------------- | ------ | ----- |
| Installed from zero                    |        |       |
| No secret printed or world-readable    |        |       |
| HTTPS certificate issued               |        |       |
| Owner login works                      |        |       |
| Database/Redis not publicly reachable  |        |       |
| Survives reboot unattended             |        |       |
| Backup verified                        |        |       |
| Update succeeded                       |        |       |
| Update lock refused a second writer    |        |       |
| Rollback succeeded, data intact        |        |       |
| Update after rollback succeeded        |        |       |
| Reinstall preserved secrets and data   |        |       |
| Installer refused a version change     |        |       |
| A divergent deploy.env was reported    |        |       |
| Web Admin restore: content came back   |        |       |
| Writes were refused during the restore |        |       |
| The displaced database is still there  |        |       |
| A corrupt archive was refused          |        |       |
| A nexa.env edit reached a container    |        |       |

Only when every row passes should this deployment model carry a customer.
