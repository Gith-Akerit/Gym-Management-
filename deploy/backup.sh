#!/bin/bash
# Consistent snapshot of SQLite + slips. Briefly stops the app, always restarts it.
set -eu
set -o pipefail
umask 077
cd /srv/gym
exec 8>/run/gym-maintenance.lock
flock -n 8 || { echo 'Another maintenance job is running.' >&2; exit 1; }
install -d -m 700 /var/backups/gym
stage=$(mktemp -d /var/backups/gym/.partial-XXXXXXXX)
restart=0
cleanup() {
  result=$?
  if [ "$restart" = 1 ]; then docker compose start app || result=1; fi
  # Only remove our verified private staging directory.
  case "$stage" in /var/backups/gym/.partial-*) rm -rf -- "$stage";; esac
  exit "$result"
}
trap cleanup EXIT
if [ -n "$(docker compose ps --status running -q app)" ]; then
  restart=1
  docker compose stop -t 60 app
fi
mkdir "$stage/data"
docker compose cp app:/data/. "$stage/data/"
cp .env "$stage/environment"
git rev-parse HEAD > "$stage/revision"
if [ "$restart" = 1 ]; then docker compose start app; restart=0; fi
python3 - "$stage/data/gym.sqlite" <<'PY'
import sqlite3, sys
with sqlite3.connect(sys.argv[1]) as db:
    if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
        raise SystemExit('Backup SQLite integrity check failed')
PY
archive="/var/backups/gym/gym-$(date -u +%Y%m%dT%H%M%S)-$$.tar.gz"
tar -czf "$archive.partial" -C "$stage" .
tar -tzf "$archive.partial" >/dev/null
mv "$archive.partial" "$archive"
find /var/backups/gym -maxdepth 1 -type f -name 'gym-*.tar.gz' -mtime +7 -delete
echo "Backup OK: $archive"
