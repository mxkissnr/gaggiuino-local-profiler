#!/bin/sh
# Runs as root (default), fixes /data ownership for whatever UID the host
# bind-mount actually has (varies per install — HA Supervisor doesn't
# guarantee it matches our container's non-root user), then drops to the
# unprivileged `glp` user before exec'ing the real process. Same pattern
# used by most HA add-ons and images like postgres/grafana that write to a
# host-mounted data dir. See #271.
#
# #977: one-time pre-cutover DB snapshot. The first time this entrypoint
# runs against an existing /data/glp.db that predates the Go backend, it
# copies it aside before the Go server ever opens it, so an install that
# hits a Go-specific bug on first boot can roll back to the Node image and
# restore glp.db.pre-go-backup unchanged. Guarded by the backup file's own
# existence, not by a version check, so it only ever happens once per
# install — later restarts (Go or Node) never re-copy over it.
set -e

if [ -d /data ]; then
    chown -R glp:glp /data
    if [ -f /data/glp.db ] && [ ! -f /data/glp.db.pre-go-backup ]; then
        cp /data/glp.db /data/glp.db.pre-go-backup
        chown glp:glp /data/glp.db.pre-go-backup
    fi
fi

exec su-exec glp "$@"
