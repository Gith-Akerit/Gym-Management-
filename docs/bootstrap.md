# Hostinger pilot bootstrap

Run `deploy/bootstrap.sh` as root in **hPanel → VPS → Manage → Overview → Web Console / Browser Terminal** for `srv1979069.hstgr.cloud`. It requires a dedicated Ubuntu 22.04, 24.04 or 26.04 VPS. See [Hostinger's console instructions](https://www.hostinger.com/support/how-to-use-the-web-console-in-hostinger/).

Use the full commit SHA from the delivery comment in both places.

**Pilot: nothing to prepare but an email address and a password.** `--pilot` sets
`PILOT_MODE=1`, asks only for the administrator email and the password they will
sign in with, generates `OTP_SECRET` itself, and skips PromptPay entirely.
Members never sign in: what they hold is a picture of a card, and packages are
sold across the counter.

```bash
curl -fsSL https://raw.githubusercontent.com/Gith-Akerit/Gym-Management-/COMMIT_SHA/deploy/bootstrap.sh | bash -s -- --pilot --revision COMMIT_SHA
```

**Taking PromptPay transfers later: the same line without `--pilot`.** It asks for
the PromptPay ID the pilot never collected, then clears `PILOT_MODE` and restarts.
If the value is rejected, `.env` is untouched and the gym stays as it was.

```bash
curl -fsSL https://raw.githubusercontent.com/Gith-Akerit/Gym-Management-/COMMIT_SHA/deploy/bootstrap.sh | bash -s -- --revision COMMIT_SHA
```

The install ends by printing the administrator's email. The password is the one
typed during the install and is never echoed back. Every account after that is
created and given a password on the "ผู้ใช้และสิทธิ์" screen inside the app, so
nobody needs a terminal again. An account with no password set cannot sign in,
and that screen says so.

Everything created during the pilot -- members, packages, granted memberships,
check-in history -- keeps working across that switch. Rerunning with `--pilot`
puts a live installation back into pilot mode without touching the saved
credentials.

The installer body only executes once the complete function and final invocation have downloaded. It clones `release/pilot` then checks out that exact commit; rerunning preserves the installed revision. A different installed revision or an unmanaged `/srv/gym` requires a reviewed migration, not an overwrite.

For a live install (no `--pilot`), prepare the administrator email, a password of at least 12 characters, and the PromptPay ID.

Every input is hidden, read through `/dev/tty` rather than the curl pipe. No passwords are passed as command arguments. The administrator password is asked for twice and must match; it is written to `.env` mode 0600, hashed into the database with bcrypt on the first boot, and both `ADMIN_EMAIL` and `ADMIN_PASSWORD` are cleared from the file immediately afterwards. Reruns reuse the saved environment and OTP secret; they do not ask for credentials again. To correct saved settings use the existing `env:set` workflow, then rerun. Bootstrap-owned `.env` supports single-line values without apostrophes; unsupported values are rejected rather than silently changed.

The installer adds the Infrastructure Engineer's dedicated public key to root's `authorized_keys` without replacing existing keys; updates OS packages without rebooting; installs Docker from its [official Ubuntu repository](https://docs.docker.com/engine/install/ubuntu/); builds and validates Node `>=24.15 <25`; and starts the existing Compose app + Caddy. The app runs as the image's `node` user, with persistent SQLite and slips in the named `/data` volume and secrets outside `dist`. `ADMIN_EMAIL` and `ADMIN_PASSWORD` are cleared after the first healthy boot, so a password never sits in a file on the server and future restarts do not reset that account; that step leaves `PILOT_MODE` as it found it. The `/data` volume also holds member photographs, which the backup archives with everything else.

**Impact:** on this dedicated VPS UFW rules are replaced with TCP 22/80/443, denying other incoming connections. Existing nonstandard SSH ports, public listeners or containers cause first-install preflight to stop for review. Docker-published ports bypass UFW; this project's Compose publishes only 80/443, with port 3000 internal. Do not deploy unrelated containers with published ports. Caddy needs correct public A/AAAA DNS and reachable 80/443. OS package updates may require a later reboot.

Daily backups run at **02:17 server time**, and slip pruning at **03:17 on the first day of each month**, using one maintenance lock. Backups briefly stop the app (Caddy may return 502), copy the complete `/data` directory including WAL/SHM and slips, then restart the app even if copying fails. Each root-only archive includes `.env` and the deployed revision; the copied SQLite database passes `PRAGMA integrity_check` before an archive is accepted. Keep archives private. Seven days are retained, and failed jobs are recorded in `/var/log/gym-backup.log` or `/var/log/gym-prune.log`.

These are **local backups only**: copy archives to a separate protected system to survive VPS/disk loss. The nominal daily backup RPO is up to 24 hours when jobs succeed; RTO requires a real restore drill. This installer checks SQLite integrity and archive readability but does not claim a full application restore test.

Recovery: run `docker compose stop app` from `/srv/gym`, preserve the current data first, extract a chosen archive to a private staging directory, restore **all** archived `data/` to the app volume (remove stale WAL/SHM from the target before restoring), restore `environment` as `.env` mode 0600, restore the recorded code revision, rebuild, and start Compose. Verify HTTPS, the administrator sign-in, memberships, member photographs and card rendering before reopening. Do not use `docker compose down -v`: that deletes persistent volumes. A failed new installation can be resumed with the same pinned command after correcting the reported cause; a failed update must restore its matching data snapshot if migrations changed the schema.

Local checks: `sh -n deploy/bootstrap.sh`, `sh -n deploy/backup.sh`, `bash deploy/bootstrap.sh --dry-run`, `python3 -B tests/bootstrap-env.test.py`, and `bash tests/bootstrap-backup.test.sh`. Dry-run has no side effects or networking. The backup harness checks archive contents and restart-on-copy-failure with Docker/SQLite/locking/permissions stubbed. Docker build, firewall enforcement, certificate issuance, scanning a card from a real phone screen and a full restore remain VPS acceptance checks. Final HTTPS health failure exits nonzero and must not be interpreted as a working pilot URL.
