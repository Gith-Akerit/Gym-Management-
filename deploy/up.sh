#!/bin/sh
# Brings the stack up, with the revision that is being deployed baked in.
#
#   ./deploy/up.sh              same as docker compose up -d --build
#   ./deploy/up.sh --no-build   skip the rebuild
#
# The only thing this adds over `docker compose up -d --build` is APP_REVISION,
# which travels with every problem report a member of staff sends. Half of any
# report arrives after the next deploy, and without it nobody can tell which
# version of the screen the person was describing. Asking whoever is deploying
# to remember an environment variable is the same as not having the field, so
# it is read from git here instead.
set -eu
cd "$(dirname "$0")/.."

if APP_REVISION="$(git rev-parse --short HEAD 2>/dev/null)"; then
  # A checkout with uncommitted changes is not the commit it says it is.
  if ! git diff --quiet HEAD 2>/dev/null; then APP_REVISION="${APP_REVISION}-dirty"; fi
else
  # Deployed from a tarball rather than a clone: unknown is honest.
  APP_REVISION=''
fi
export APP_REVISION

echo "{\"event\":\"deploy_build\",\"app_revision\":\"${APP_REVISION}\"}"
exec docker compose up -d --build "$@"
