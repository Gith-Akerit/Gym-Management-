#!/bin/sh
# Bring the database up to the running code before serving anything.
#
# migrate is a list of numbered steps that skips the ones already applied, and
# seed only inserts rows that are missing, so both are safe to run on every
# boot -- including the twentieth boot of an existing gym. Neither touches a
# price or an opening hour the owner has edited.
set -e

mkdir -p "$(dirname "${DATABASE_PATH:-./data/gym.sqlite}")" "${SLIP_STORAGE_PATH:-./data/slips}"

node server/manage.js migrate
node server/manage.js seed

# One address is promoted to admin so somebody can get in on a fresh install.
# Leave ADMIN_EMAIL unset after the first boot; it is not needed again.
if [ -n "$ADMIN_EMAIL" ]; then
  node server/manage.js admin
fi

exec "$@"
