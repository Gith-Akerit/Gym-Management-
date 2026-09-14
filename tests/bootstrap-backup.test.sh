#!/bin/bash
# Offline backup orchestration test. Docker and SQLite are stubbed; tar is real.
set -eu
set -o pipefail
mkdir -p artifacts
root=$(mktemp -d "$PWD/artifacts/backup-test-XXXXXXXX")
trap 'rm -rf -- "$root"' EXIT
mkdir -p "$root/repo" "$root/backups" "$root/run" "$root/bin" "$root/source/slips"
printf 'test data\n' > "$root/source/gym.sqlite"
printf 'test slip\n' > "$root/source/slips/receipt"
printf 'fixture only\n' > "$root/repo/.env"
sed -e "s|/srv/gym|$root/repo|g" -e "s|/var/backups/gym|$root/backups|g" -e "s|/run/gym-maintenance.lock|$root/run/lock|g" deploy/backup.sh > "$root/backup.sh"
cat > "$root/bin/docker" <<'MOCK'
#!/bin/bash
echo "$*" >> "$FIXTURE_ROOT/calls"
shift
case "$1" in
ps) echo fixture-container;;
stop|start) exit 0;;
cp) [ "${FAIL_COPY:-0}" = 0 ] || exit 9; cp -r "$FIXTURE_ROOT/source/." "$3";;
*) exit 90;;
esac
MOCK
printf '#!/bin/sh\nexit 0\n' > "$root/bin/python3"
printf '#!/bin/sh\necho fixture-revision\n' > "$root/bin/git"
printf '#!/bin/sh\nexit 0\n' > "$root/bin/flock"
printf '#!/bin/sh\nmkdir -p "$4"\n' > "$root/bin/install"
chmod +x "$root/bin/"*
export PATH="$root/bin:$PATH" FIXTURE_ROOT="$root"
bash "$root/backup.sh"
grep -q 'compose stop -t 60 app' "$root/calls"
grep -q 'compose start app' "$root/calls"
archive=$(find "$root/backups" -name 'gym-*.tar.gz' -type f)
tar -tzf "$archive" | grep -q './data/slips/receipt'
tar -tzf "$archive" | grep -q './environment'
before=$(find "$root/backups" -name 'gym-*.tar.gz' -type f | wc -l)
: > "$root/calls"
if FAIL_COPY=1 bash "$root/backup.sh"; then echo 'Expected copy failure' >&2; exit 1; fi
grep -q 'compose start app' "$root/calls"
[ "$(find "$root/backups" -name 'gym-*.tar.gz' -type f | wc -l)" = "$before" ]
[ -z "$(find "$root/backups" -name '.partial-*')" ]
echo 'PASS: backup archive contains slips/environment; failed copy restarts app and preserves prior archive.'
