#!/bin/sh
set -e

# Applies any pending migrations (idempotent — safe to run on every start,
# a no-op if the DB is already up to date). Runs first, before what's
# ultimately exec'd below, so the app (or any ad-hoc command) never runs
# against a stale schema — unless explicitly skipped, see SKIP_MIGRATIONS
# below (useful for a debug shell where the DB may not be reachable yet).
#
# Invoked via its real entry point (node_modules/prisma/build/index.js)
# rather than node_modules/.bin/prisma: that bin file is normally a symlink
# into build/index.js, and Docker COPY dereferences symlinks — copying it
# alone drops the sibling .wasm files index.js loads via a relative path,
# which breaks it.
if [ "$SKIP_MIGRATIONS" = "1" ]; then
  echo "SKIP_MIGRATIONS=1 set — skipping prisma migrate deploy."
elif [ -z "$DATABASE_URL" ]; then
  echo "ERROR: DATABASE_URL is not set. Set it, or set SKIP_MIGRATIONS=1 to bypass migrations (e.g. for a debug shell)." >&2
  exit 1
else
  node node_modules/prisma/build/index.js migrate deploy
fi

# Run whatever command was passed as CMD/args (defaults to `node server.js`
# per the Dockerfile's CMD, but can be overridden at `docker run` time).
exec "$@"
