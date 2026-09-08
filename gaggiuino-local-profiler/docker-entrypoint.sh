#!/bin/sh
# Runs as root (default), fixes /data ownership for whatever UID the host
# bind-mount actually has (varies per install — HA Supervisor doesn't
# guarantee it matches our container's non-root user), then drops to the
# unprivileged `glp` user before exec'ing the real process. Same pattern
# used by most HA add-ons and images like postgres/grafana that write to a
# host-mounted data dir. See #271.
#
# #977: one-time pre-cutover DB snapshot. The first time this entrypoint
# runs after the cutover, and only then, it copies any existing
# /data/glp.db (and its -wal/-shm sidecar files, if present) aside before
# the Go server ever opens it, so an install that hits a Go-specific bug on
# first boot can roll back to the Node image and restore the backup
# unchanged. The DB runs in WAL mode (PRAGMA journal_mode = WAL) and Node
# doesn't checkpoint on shutdown, so a committed transaction can live only
# in glp.db-wal at the moment of this snapshot — glp.db alone would silently
# drop it (#977 follow-up code review).
#
# Gated on /data/.go-cutover-done, a dedicated marker, NOT on the backup
# file's own existence (#977 follow-up code review, round 3): a fresh
# install has no glp.db at all on its very first boot, so the backup step
# is a no-op there -- but the Go server then creates glp.db during that
# same boot, and a from-existence guard would wrongly snapshot THAT
# Go-created database on the second boot under the misleading
# "pre-go-backup" name, unable to tell "predates the Go backend" apart
# from "the Go backend already made this". The marker is written exactly
# once, right after this one-shot attempt, whether or not a backup was
# actually taken (no glp.db yet) or the attempt failed -- this is a single
# opportunity by design, not a queue retried until it succeeds.
#
# The copy itself is atomic: cp to a .tmp name in the same directory, only
# `mv` (atomic rename on the same filesystem) it onto the final
# .pre-go-backup name once cp has fully succeeded. Without this, a copy
# interrupted partway (OOM, power loss, a slow SD card on a multi-hundred-
# MB database) would leave a truncated file already sitting under the
# final name -- with a from-existence guard that reads as "already backed
# up, never try again", silently breaking the rollback path forever. A
# failed cp/mv (the `|| rm -f ...tmp` branch) must not fail the whole
# container boot -- the marker still gets set (see above), and `set -e`
# below only sees the recovery branch's own successful exit status, not
# the failed cp/mv.
#
# backup_data_file() covers all three files (db, wal, shm) with one
# implementation. Note the chown happens *after* the mv, so a chown failure
# can't be caught by the `|| rm -f ...tmp` cleanup (the file's no longer at
# the .tmp path by then) -- it's checked and handled explicitly instead, by
# removing the now-misowned final file rather than leaving a silent
# root-owned backup sitting there unreported (#977 follow-up code review,
# round 4).
#
# The marker touch/chown gets the same non-fatal treatment (#977 follow-up
# code review, round 5): if the disk fills or goes read-only right after the
# chown -R above but before the marker is written, `set -e` must not kill
# the entrypoint before it reaches exec -- that would mean total outage on
# every boot until the disk issue clears. A missing/misowned marker just
# means the backup-check above runs again next boot, which is safe and
# idempotent by design (see the marker-gating note further up), so a failure
# here is logged as a warning and boot continues.
set -e

backup_data_file() {
    src="/data/$1"
    tmp="/data/$1.pre-go-backup.tmp"
    final="/data/$1.pre-go-backup"
    if [ -f "$src" ]; then
        if cp "$src" "$tmp" && mv "$tmp" "$final"; then
            if ! chown glp:glp "$final"; then
                echo "WARNING: chown glp:glp failed on $final, removing to avoid a root-owned backup" >&2
                rm -f "$final"
            fi
        else
            rm -f "$tmp"
        fi
    fi
}

if [ -d /data ]; then
    chown -R glp:glp /data
    if [ ! -f /data/.go-cutover-done ]; then
        for f in glp.db glp.db-wal glp.db-shm; do
            backup_data_file "$f"
        done
        if touch /data/.go-cutover-done; then
            if ! chown glp:glp /data/.go-cutover-done; then
                echo "WARNING: chown glp:glp failed on /data/.go-cutover-done, removing it so the backup-check re-runs next boot" >&2
                rm -f /data/.go-cutover-done
            fi
        else
            echo "WARNING: failed to write /data/.go-cutover-done, continuing anyway (backup-check will re-run next boot)" >&2
        fi
    fi
fi

exec su-exec glp "$@"
