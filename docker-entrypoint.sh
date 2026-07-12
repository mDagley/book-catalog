#!/bin/sh
set -e

# Applies any pending migrations (idempotent — safe to run on every start,
# a no-op if the DB is already up to date). Runs before the server starts so
# the app never serves against a stale schema.
#
# Invoked via its real entry point (node_modules/prisma/build/index.js)
# rather than node_modules/.bin/prisma: that bin file is normally a symlink
# into build/index.js, and Docker COPY dereferences symlinks — copying it
# alone drops the sibling .wasm files index.js loads via a relative path,
# which breaks it.
node node_modules/prisma/build/index.js migrate deploy

exec node server.js
