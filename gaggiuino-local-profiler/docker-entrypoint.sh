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
# copies it (and its -wal/-shm sidecar files, if present) aside before the
# Go server ever opens it, so an install that hits a Go-specific bug on
# first boot can roll back to the Node image and restore the backup
# unchanged. The DB runs in WAL mode (PRAGMA journal_mode = WAL) and Node
# doesn't checkpoint on shutdown, so a committed transaction can live only
# in glp.db-wal at the moment of this snapshot — glp.db alone would silently
# drop it (#977 follow-up code review). -wal/-shm can legitimately be
# absent (no WAL checkpoint currently open); only copy what exists. Guarded
# by the main backup file's own existence, not by a version check, so this
# only ever happens once per install — later restarts (Go or Node) never
# re-copy over it.
set -e

if [ -d /data ]; then
    chown -R glp:glp /data
    if [ -f /data/glp.db ] && [ ! -f /data/glp.db.pre-go-backup ]; then
        cp /data/glp.db /data/glp.db.pre-go-backup
        chown glp:glp /data/glp.db.pre-go-backup
        for sidecar in wal shm; do
            if [ -f "/data/glp.db-$sidecar" ]; then
                cp "/data/glp.db-$sidecar" "/data/glp.db-$sidecar.pre-go-backup"
                chown glp:glp "/data/glp.db-$sidecar.pre-go-backup"
            fi
        done
    fi
fi

exec su-exec glp "$@"
