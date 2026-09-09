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
# The marker is never cleared by any code path here (#977 follow-up code
# review, round 6): if an operator does the documented rollback -- restore
# the Node image and glp.db.pre-go-backup -- and later retries the Go
# cutover, the stale marker skips taking a *fresh* backup, since as far as
# this script can tell the one-shot backup already happened. A second
# Go-side failure on that retry then forces rollback to the old, stale
# first backup, losing everything written during the Node interim. The
# entrypoint has no way to detect a rollback that happened outside of it,
# so this can't be auto-handled: anyone doing that manual rollback must
# also `rm -f /data/.go-cutover-done` so the retry takes a fresh backup.
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
# Each of glp.db/-wal/-shm is backed up as its own independent atomic
# cp+mv, not as one atomic group covering all three -- a torn snapshot
# across the three (e.g. glp.db and glp.db-wal from two different moments)
# is only safe to accept because the old (Node) container is already fully
# stopped by the time this entrypoint runs: nothing is writing to any of
# the three files during this boot-time backup window, so "per-file atomic,
# taken one after another" and "all three atomic together" describe the
# same on-disk result here. This ordering would NOT be safe against a
# concurrent writer (#977 follow-up code review, round 7 -- doc-only, no
# code change).
#
# backup_data_file() also refuses to ever overwrite an existing
# .pre-go-backup file for a given source (round 7): see its own check
# below, and the marker-vs-backup-existence note in run_pre_go_backup().
#
# The marker touch/chown gets the same non-fatal treatment (#977 follow-up
# code review, round 5): if the disk fills or goes read-only right after the
# chown -R above but before the marker is written, `set -e` must not kill
# the entrypoint before it reaches exec -- that would mean total outage on
# every boot until the disk issue clears. A missing/misowned marker just
# means the backup-check above runs again next boot, which is safe and
# idempotent by design (see the marker-gating note further up), so a failure
# here is logged as a warning and boot continues.
#
# backup_data_file()/run_pre_go_backup() are split into named functions, and
# the block that calls them is guarded below (#977 follow-up code review,
# round 7), so test/docker-entrypoint.test.sh can `. docker-entrypoint.sh`
# and call them directly against a throwaway DATA_DIR -- these were only
# ever manually re-verified via ad-hoc scenario scripts across rounds 3-6
# before this. DATA_DIR/DOCKER_ENTRYPOINT_TEST are both no-ops in the real
# container (default to /data, unset respectively); nothing about a normal
# boot changes.
set -e

DATA_DIR="${GLP_DATA_DIR:-/data}"

backup_data_file() {
    src="$DATA_DIR/$1"
    tmp="$DATA_DIR/$1.pre-go-backup.tmp"
    final="$DATA_DIR/$1.pre-go-backup"
    if [ -f "$final" ]; then
        # Round 7 fix: never overwrite a backup that's already there. This
        # is what makes a missing/misowned .go-cutover-done marker harmless
        # rather than dangerous -- run_pre_go_backup() only gates the whole
        # loop on the marker, so a marker that failed to stick (see its own
        # WARNING branches below) makes this function run again on the next
        # boot; without this check, that re-run would cp the by-then
        # Go-modified glp.db over the real pre-cutover Node backup, silently
        # destroying the one thing the whole feature exists to preserve.
        return 0
    fi
    if [ -f "$src" ]; then
        if cp "$src" "$tmp" && mv "$tmp" "$final"; then
            if ! chown glp:glp "$final"; then
                echo "WARNING: chown glp:glp failed on $final, removing to avoid a root-owned backup" >&2
                rm -f "$final"
            fi
        else
            echo "WARNING: backup of $src failed (cp/mv error), continuing without a pre-go-backup for this file" >&2
            rm -f "$tmp"
        fi
    fi
}

run_pre_go_backup() {
    if [ -d "$DATA_DIR" ]; then
        # Round 7 fix: hardened like the three chown calls below it (warn +
        # continue) instead of letting `set -e` abort the whole boot -- this
        # one previously ran unguarded, inconsistently with the rest of this
        # function.
        if ! chown -R glp:glp "$DATA_DIR"; then
            echo "WARNING: chown -R glp:glp failed on $DATA_DIR, continuing anyway" >&2
        fi
        if [ ! -f "$DATA_DIR/.go-cutover-done" ]; then
            for f in glp.db glp.db-wal glp.db-shm; do
                backup_data_file "$f"
            done
            if touch "$DATA_DIR/.go-cutover-done"; then
                if ! chown glp:glp "$DATA_DIR/.go-cutover-done"; then
                    echo "WARNING: chown glp:glp failed on $DATA_DIR/.go-cutover-done, removing it so the backup-check re-runs next boot" >&2
                    rm -f "$DATA_DIR/.go-cutover-done"
                fi
            else
                echo "WARNING: failed to write $DATA_DIR/.go-cutover-done, continuing anyway (backup-check will re-run next boot)" >&2
            fi
        fi
    fi
}

# Round 7 fix: checked against the exact sentinel "1", not just "any value
# set", and logged loudly when active -- test/docker-entrypoint.test.sh is
# the only thing that should ever set this. A stray/misconfigured
# DOCKER_ENTRYPOINT_TEST in a real container would otherwise make it skip
# run_pre_go_backup and exec, i.e. silently exit without starting the
# server at all; this makes that failure mode visible in the logs instead
# of a silent, unexplained container exit.
if [ "${DOCKER_ENTRYPOINT_TEST:-}" = "1" ]; then
    echo "DOCKER_ENTRYPOINT_TEST=1: test mode, NOT starting the server (this must never be set in a real container)" >&2
else
    run_pre_go_backup
    exec su-exec glp "$@"
fi
