# Hostinger pilot bootstrap

Run `deploy/bootstrap.sh` as root in **hPanel → VPS → Manage → Overview → Web Console / Browser Terminal** for `srv1979069.hstgr.cloud`. It requires a dedicated Ubuntu 22.04, 24.04 or 26.04 VPS. See [Hostinger's console instructions](https://www.hostinger.com/support/how-to-use-the-web-console-in-hostinger/).

Use the full commit SHA from the delivery comment in both places:

```bash
curl -fsSL https://raw.githubusercontent.com/Gith-Akerit/Gym-Management-/COMMIT_SHA/deploy/bootstrap.sh | bash -s -- --revision COMMIT_SHA
```

The installer body only executes once the complete function and final invocation have downloaded. It clones `release/pilot` then checks out that exact commit; rerunning preserves the installed revision. A different installed revision or an unmanaged `/srv/gym` requires a reviewed migration, not an overwrite.

Prepare the reporter's administrator email, PromptPay ID, and either:

- Gmail address and a **Gmail App Password**, with the sender set to that same address. [Google requires 2-Step Verification and App Password availability depends on account policy](https://support.google.com/accounts/answer/185833). SMTP uses STARTTLS on port 587. Do not promise a fixed daily sending allowance; account limits and throttling apply.
- Brevo SMTP login, **SMTP key**, and verified sender email (not the Brevo REST API key).

Every input is hidden, read through `/dev/tty` rather than the curl pipe. No passwords are passed as command arguments. SMTP STARTTLS and authentication must pass before `.env` is atomically written with mode 0600. Successful authentication does not prove sender authorization or inbox delivery: test an actual OTP after deployment. Reruns reuse the saved environment and OTP secret; they do not ask for credentials again. To correct saved settings use the existing `env:set` workflow, then rerun. Bootstrap-owned `.env` supports single-line values without apostrophes; unsupported values are rejected rather than silently changed.

The installer adds the Infrastructure Engineer's dedicated public key to root's `authorized_keys` without replacing existing keys; updates OS packages without rebooting; installs Docker from its [official Ubuntu repository](https://docs.docker.com/engine/install/ubuntu/); builds and validates Node `>=24.15 <25`; and starts the existing Compose app + Caddy. The app runs as the image's `node` user, with persistent SQLite and slips in the named `/data` volume and secrets outside `dist`. `ADMIN_EMAIL` is cleared after the first healthy boot so future restarts do not promote that account repeatedly.

**Impact:** on this dedicated VPS UFW rules are replaced with TCP 22/80/443, denying other incoming connections. Existing nonstandard SSH ports, public listeners or containers cause first-install preflight to stop for review. Docker-published ports bypass UFW; this project's Compose publishes only 80/443, with port 3000 internal. Do not deploy unrelated containers with published ports. Caddy needs correct public A/AAAA DNS and reachable 80/443. OS package updates may require a later reboot.

Daily backups run at **02:17 server time**, and slip pruning at **03:17 on the first day of each month**, using one maintenance lock. Backups briefly stop the app (Caddy may return 502), copy the complete `/data` directory including WAL/SHM and slips, then restart the app even if copying fails. Each root-only archive includes `.env` and the deployed revision; the copied SQLite database passes `PRAGMA integrity_check` before an archive is accepted. Keep archives private. Seven days are retained, and failed jobs are recorded in `/var/log/gym-backup.log` or `/var/log/gym-prune.log`.

These are **local backups only**: copy archives to a separate protected system to survive VPS/disk loss. The nominal daily backup RPO is up to 24 hours when jobs succeed; RTO requires a real restore drill. This installer checks SQLite integrity and archive readability but does not claim a full application restore test.

Recovery: run `docker compose stop app` from `/srv/gym`, preserve the current data first, extract a chosen archive to a private staging directory, restore **all** archived `data/` to the app volume (remove stale WAL/SHM from the target before restoring), restore `environment` as `.env` mode 0600, restore the recorded code revision, rebuild, and start Compose. Verify HTTPS, admin OTP, memberships and slip access before reopening. Do not use `docker compose down -v`: that deletes persistent volumes. A failed new installation can be resumed with the same pinned command after correcting the reported cause; a failed update must restore its matching data snapshot if migrations changed the schema.

Local checks: `sh -n deploy/bootstrap.sh`, `sh -n deploy/backup.sh`, `bash deploy/bootstrap.sh --dry-run`, `python3 -B tests/bootstrap-env.test.py`, and `bash tests/bootstrap-backup.test.sh`. Dry-run has no side effects or networking. The backup harness checks archive contents and restart-on-copy-failure with Docker/SQLite/locking/permissions stubbed. Docker build, real SMTP, firewall enforcement, certificate issuance and a full restore remain VPS acceptance checks. Final HTTPS health failure exits nonzero and must not be interpreted as a working pilot URL.
