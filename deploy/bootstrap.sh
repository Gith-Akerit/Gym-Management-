#!/bin/bash
# Ubuntu Hostinger pilot installer. Secrets are read from /dev/tty, never stdin.
# Entire body is a function so a truncated curl download cannot start installation.
bootstrap() {
set +x
set -eu
set -o pipefail
umask 077
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
case "${1:-}" in
  --dry-run)
    printf '%s\n' 'DRY RUN: no writes, network calls or secret prompts.' \
      'Check Ubuntu/root, existing services and SSH port; lock installer.' \
      'Add dedicated SSH public key; upgrade OS without automatic reboot.' \
      'Install official Docker + Compose; clone release/pilot into /srv/gym.' \
      'Prompt hidden credentials via /dev/tty; verify STARTTLS SMTP auth before saving.' \
      'Preserve existing OTP_SECRET, credentials and persistent volume on rerun.' \
      'Build app; allow only TCP 22/80/443 on a dedicated host; start Caddy/app.' \
      'Install daily consistent backup and monthly prune; check HTTPS health.'
    return 0 ;;
  --revision)
    revision=${2:-}
    [[ "$revision" =~ ^[a-f0-9]{40}$ ]] || { echo 'A full commit SHA is required.' >&2; return 2; } ;;
  *) echo 'Usage: bootstrap.sh --revision COMMIT_SHA | --dry-run' >&2; return 2 ;;
esac
[ "$(id -u)" = 0 ] || { echo 'Run as root in hPanel Web Console.' >&2; return 1; }
. /etc/os-release
[ "$ID" = ubuntu ] || { echo 'Ubuntu is required.' >&2; return 1; }
case "$VERSION_ID" in 22.04|24.04|26.04) ;; *) echo 'Unsupported Ubuntu release.' >&2; return 1;; esac
exec 9>/run/gym-bootstrap.lock
flock -n 9 || { echo 'Another bootstrap is running.' >&2; return 1; }
trap 'echo "Bootstrap stopped. Fix the reported error and rerun; existing data is retained." >&2' ERR
[ -c /dev/tty ] && test -r /dev/tty || { echo 'An interactive terminal is required.' >&2; return 1; }
# Do not take over an unrelated installation or lock out a nonstandard SSH port.
if [ -e /srv/gym ] && [ ! -f /srv/gym/.gym-bootstrap-managed ]; then
  echo '/srv/gym already exists and is not bootstrap-managed. Manual review required.' >&2; return 1
fi
if /usr/sbin/sshd -T 2>/dev/null | grep '^port ' | grep -qv '^port 22$'; then
  echo 'SSH uses a nonstandard port. Review firewall manually first.' >&2; return 1
fi
if [ ! -e /srv/gym/.gym-bootstrap-managed ]; then
  if ss -H -lntup | grep -Ev '(:22 |:68 |:546 |127\.0\.0\.|\[::1\]|127\.0\.0\.53|127\.0\.0\.54)' | grep -q .; then
    echo 'Other public listeners exist; this installer requires a dedicated VPS.' >&2; return 1
  fi
  if command -v docker >/dev/null && [ -n "$(docker ps -aq)" ]; then
    echo 'Existing Docker containers require manual review.' >&2; return 1
  fi
fi
install -d -m 700 /root/.ssh
touch /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
key='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBQFyDyG6mT6/ydBsoS7hFJ3pZ9CC67k5Wz/jLDRAPaE multica-gym-pilot-srv1979069'
grep -qF 'AAAAC3NzaC1lZDI1NTE5AAAAIBQFyDyG6mT6/ydBsoS7hFJ3pZ9CC67k5Wz/jLDRAPaE' /root/.ssh/authorized_keys || printf '\n%s\n' "$key" >> /root/.ssh/authorized_keys
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l
apt-get update
apt-get -y -o Dpkg::Options::=--force-confold upgrade
apt-get install -y ca-certificates curl git python3 ufw cron
systemctl enable --now cron
if ! command -v docker >/dev/null; then
  for package in docker.io docker-compose docker-compose-v2 podman-docker containerd runc; do
    if dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q 'install ok installed'; then
      echo 'Conflicting container packages found. Manual review required.' >&2; return 1
    fi
  done
  install -m 0755 -d /etc/apt/keyrings
  curl --fail --silent --show-error --location --max-time 60 https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu %s stable\n' "$(dpkg --print-architecture)" "$VERSION_CODENAME" > /etc/apt/sources.list.d/gym-docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
docker compose version >/dev/null || { echo 'Docker Compose plugin missing; install from Docker official repository.' >&2; return 1; }
systemctl enable --now docker
if [ ! -d /srv/gym/.git ]; then
  git clone --branch release/pilot --single-branch https://github.com/Gith-Akerit/Gym-Management-.git /srv/gym
  git -C /srv/gym checkout --detach "$revision"
  touch /srv/gym/.gym-bootstrap-managed
fi
cd /srv/gym
# Do not git pull on reruns: preserve the installed revision and local settings.
[ "$(git rev-parse HEAD)" = "$revision" ] || { echo 'Installed revision differs. Use its bootstrap command or perform a reviewed upgrade.' >&2; return 1; }
chmod 700 /srv/gym
python3 deploy/bootstrap-env.py
docker compose config --quiet
docker compose build --pull app
docker compose run --rm --no-deps --entrypoint node app -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a!==24||b<15)process.exit(1)'
# Existing data is backed up before another entrypoint/migration can run.
if [ -n "$(docker compose ps -aq app)" ]; then bash deploy/backup.sh; fi
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
# Docker published ports bypass UFW. This project's only published ports are 80/443.
docker compose up -d --wait --wait-timeout 180
python3 deploy/bootstrap-env.py --clear-admin
docker compose up -d --wait --wait-timeout 120 app
install -d -m 700 /var/backups/gym
cat > /etc/cron.d/gym-pilot <<'CRON'
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
17 2 * * * root /bin/bash /srv/gym/deploy/backup.sh >> /var/log/gym-backup.log 2>&1
17 3 1 * * root /usr/bin/flock -n /run/gym-maintenance.lock /bin/bash -c 'cd /srv/gym && docker compose exec -T app npm run slips:prune' >> /var/log/gym-prune.log 2>&1
CRON
chmod 644 /etc/cron.d/gym-pilot
bash deploy/backup.sh
echo 'Checking public HTTPS (certificate issuance may take a few minutes)...'
healthy=0
for attempt in $(seq 1 24); do
  if curl --fail --silent --show-error --connect-timeout 5 --max-time 10 https://srv1979069.hstgr.cloud/api/health | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("status")=="ok" else 1)' 2>/dev/null; then healthy=1; break; fi
  sleep 5
done
[ "$healthy" = 1 ] || { echo 'HTTPS health failed. Check DNS A/AAAA, ports 80/443 and docker compose logs caddy.' >&2; return 1; }
echo 'HTTPS health: OK'
echo 'URL: https://srv1979069.hstgr.cloud'
echo 'Sign in with the reporter admin email and the OTP delivered by email.'
echo 'Daily local backup: /var/backups/gym (7 days). Copy off-server for disaster recovery.'
echo 'SSH host fingerprint (safe to share):'
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
[ ! -f /var/run/reboot-required ] || echo 'OS reboot required; arrange a reboot after verification.'
}
bootstrap "$@"
