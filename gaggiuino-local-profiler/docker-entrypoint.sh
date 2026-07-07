#!/bin/sh
# Runs as root (default), fixes /data ownership for whatever UID the host
# bind-mount actually has (varies per install — HA Supervisor doesn't
# guarantee it matches our container's non-root user), then drops to the
# unprivileged `node` user before exec'ing the real process. Same pattern
# used by most HA add-ons and images like postgres/grafana that write to a
# host-mounted data dir. See #271.
set -e

if [ -d /data ]; then
    chown -R node:node /data
fi

exec gosu node "$@"
