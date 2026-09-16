#!/bin/sh
# Bring the database up to the running code before serving anything.
#
# migrate is a list of numbered steps that skips the ones already applied, and
# seed only inserts rows that are missing, so both are safe to run on every
# boot -- including the twentieth boot of an existing gym. Neither touches a
# price or an opening hour the owner has edited.
set -e

# Every directory the app writes to, made before it starts. SlipStore would
# create them itself, but on the wrong path that is exactly the failure that
# stays quiet: the upload succeeds into the container and is gone on the next
# rebuild, with no error anywhere and no copy in the backup (Infra).
mkdir -p "$(dirname "${DATABASE_PATH:-./data/gym.sqlite}")" \
  "${SLIP_STORAGE_PATH:-./data/slips}" \
  "${PHOTO_STORAGE_PATH:-./data/photos}" \
  "${LOGO_STORAGE_PATH:-./data/logo}" \
  "${REPORT_STORAGE_PATH:-./data/reports}"   "${MACHINE_STORAGE_PATH:-./data/machines}"

node server/manage.js migrate
node server/manage.js seed

# One address is promoted to admin and given the password the installer asked
# for, so somebody can get in on a fresh install without a terminal. Leave both
# unset after the first boot; neither is needed again.
if [ -n "$ADMIN_EMAIL" ]; then
  node server/manage.js admin
fi

exec "$@"
