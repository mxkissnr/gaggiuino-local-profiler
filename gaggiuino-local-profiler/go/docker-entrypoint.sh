#!/bin/sh
# Go rewrite's entrypoint (#901 Phase 4) — mirrors the repo-root Node
# image's docker-entrypoint.sh/#271 pattern exactly, just for the `glp` user
# baked into go/Dockerfile instead of the `node:22-slim` base image's `node`
# user. Still needed despite embed.FS removing any runtime asset directory:
# /data (the SQLite DB) is still a host bind mount whose UID HA Supervisor
# doesn't guarantee matches this container's non-root user.
set -e

if [ -d /data ]; then
    chown -R glp:glp /data
fi

exec su-exec glp "$@"
