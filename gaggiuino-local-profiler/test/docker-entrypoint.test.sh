#!/bin/sh
# Automated regression test for docker-entrypoint.sh's #977 pre-cutover
# backup + one-shot marker logic (backup_data_file()/run_pre_go_backup()).
#
# Rounds 3-6 of the #977 follow-up code review only ever re-verified this
# logic by hand, with throwaway ad-hoc scenario scripts, across seven
# scenarios: fresh install, normal path, leftover .tmp cleanup,
# chown-failure-on-backup, chown-failure-on-marker, touch-failure-on-marker,
# and ENOSPC-style cp-failure-on-backup. This script automates all seven,
# plus an eighth added in round 7 (marker missing but a backup already
# exists -- the marker-loop race that round's fix closes), so a future
# change can't silently regress any of them.
#
# It sources the real docker-entrypoint.sh (DOCKER_ENTRYPOINT_TEST=1 stops
# it from also running run_pre_go_backup/exec su-exec on source -- see that
# script's own comment) to get the actual backup_data_file/run_pre_go_backup
# functions under test, rather than reimplementing their logic here. Each
# scenario runs in its own throwaway DATA_DIR (via the GLP_DATA_DIR override
# docker-entrypoint.sh reads) with a PATH prepended with fake chown/cp/touch
# stubs (fake-bin/), so root privileges and a real `glp` user are never
# required to exercise the chown/marker paths -- chown is a pure no-op stub
# (never actually attempts a real chown, which would fail as this unpriv-
# ileged test process anyway), while cp/touch delegate to the real binary
# so file content/existence can still be asserted on. Each stub can be told
# to fail on demand: cp/touch via a $WORK/fail-<name> flag file, chown via
# FAKE_CHOWN_FAIL_SUBSTR (fails only the call whose last argument contains
# that substring) -- needed because the top-level `chown -R ... "$DATA_DIR"`
# call must keep succeeding even in the chown-failure scenarios below, or
# `set -e` inside the sourced script would abort before ever reaching the
# specific backup-file/marker chown under test.
#
# Run directly: sh test/docker-entrypoint.test.sh (from the repo's
# gaggiuino-local-profiler/ directory, or any cwd -- paths are resolved
# relative to this script's own location). Wired into CI as a step in
# .github/workflows/test.yaml's `test` job.

set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
ENTRYPOINT="$REPO_ROOT/docker-entrypoint.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT INT TERM

FAKE_BIN="$WORK/fake-bin"
mkdir -p "$FAKE_BIN"

FAILURES=0
CURRENT=""

pass() {
    echo "ok   - $CURRENT: $1"
}

fail() {
    echo "FAIL - $CURRENT: $1"
    FAILURES=$((FAILURES + 1))
}

assert_file_exists() {
    if [ -f "$1" ]; then pass "$2"; else fail "$2 (missing: $1)"; fi
}

assert_file_absent() {
    if [ ! -f "$1" ]; then pass "$2"; else fail "$2 (unexpectedly present: $1)"; fi
}

assert_file_contains() {
    if grep -qF "$2" "$1" 2>/dev/null; then
        pass "$3"
    else
        fail "$3 (expected '$2' in $1)"
    fi
}

assert_not_contains() {
    if grep -qF "$2" "$1" 2>/dev/null; then
        fail "$3 (unexpectedly found '$2' in $1)"
    else
        pass "$3"
    fi
}

# fake_real_bin writes a stub named "$1" into FAKE_BIN that logs its
# invocation to $WORK/calls.log, then either fails (exit 1, when
# $WORK/fail-$1 exists) or delegates to the real "$2" binary.
fake_real_bin() {
    name="$1"
    real="$2"
    cat > "$FAKE_BIN/$name" <<EOF
#!/bin/sh
echo "$name \$*" >> "$WORK/calls.log"
if [ -f "$WORK/fail-$name" ]; then
    exit 1
fi
exec "$real" "\$@"
EOF
    chmod +x "$FAKE_BIN/$name"
}

# fake_chown writes a chown stub that logs its invocation and always
# succeeds WITHOUT ever calling the real chown (this test process is
# unprivileged and there is no real `glp` user, so a real chown would just
# fail unconditionally) -- unless FAKE_CHOWN_FAIL_SUBSTR is set and the
# call's last argument contains it, in which case it fails instead.
fake_chown() {
    cat > "$FAKE_BIN/chown" <<EOF
#!/bin/sh
echo "chown \$*" >> "$WORK/calls.log"
last=""
for a in "\$@"; do last="\$a"; done
if [ -n "\${FAKE_CHOWN_FAIL_SUBSTR:-}" ]; then
    case "\$last" in
        *"\$FAKE_CHOWN_FAIL_SUBSTR"*) exit 1 ;;
    esac
fi
exit 0
EOF
    chmod +x "$FAKE_BIN/chown"
}

# reset_scenario wipes DATA_DIR + fail flags + call log so each scenario
# below starts from a clean slate, and (re-)installs the stub binaries.
reset_scenario() {
    CURRENT="$1"
    DATA_DIR="$WORK/data"
    rm -rf "$DATA_DIR"
    mkdir -p "$DATA_DIR"
    rm -f "$WORK"/fail-* "$WORK/calls.log"
    FAKE_CHOWN_FAIL_SUBSTR=""
    fake_chown
    fake_real_bin cp /usr/bin/cp
    fake_real_bin touch /usr/bin/touch
}

# run_entrypoint sources the real script (functions only, per
# DOCKER_ENTRYPOINT_TEST) and calls run_pre_go_backup against the DATA_DIR/
# fake-bin PATH/FAKE_CHOWN_FAIL_SUBSTR set up by reset_scenario (and any
# scenario-specific override made after it).
run_entrypoint() {
    (
        PATH="$FAKE_BIN:$PATH"
        export PATH
        DOCKER_ENTRYPOINT_TEST=1
        export DOCKER_ENTRYPOINT_TEST
        GLP_DATA_DIR="$DATA_DIR"
        export GLP_DATA_DIR
        export FAKE_CHOWN_FAIL_SUBSTR
        # shellcheck disable=SC1090
        . "$ENTRYPOINT"
        run_pre_go_backup
    )
}

# ── Scenario 1: fresh install -- no glp.db at all yet ──────────────────────
reset_scenario "fresh install"
run_entrypoint
assert_file_exists "$DATA_DIR/.go-cutover-done" "marker gets set"
assert_file_absent "$DATA_DIR/glp.db.pre-go-backup" "no backup file created (nothing to back up)"

# ── Scenario 2: normal path -- glp.db (+ one sidecar) present ──────────────
reset_scenario "normal path"
echo "fake db content" > "$DATA_DIR/glp.db"
echo "fake wal content" > "$DATA_DIR/glp.db-wal"
run_entrypoint
assert_file_exists "$DATA_DIR/.go-cutover-done" "marker gets set"
assert_file_exists "$DATA_DIR/glp.db.pre-go-backup" "glp.db backup created"
assert_file_exists "$DATA_DIR/glp.db-wal.pre-go-backup" "glp.db-wal backup created"
assert_file_absent "$DATA_DIR/glp.db-shm.pre-go-backup" "no glp.db-shm backup (file never existed)"
if [ "$(cat "$DATA_DIR/glp.db.pre-go-backup")" = "fake db content" ]; then
    pass "backup content matches source"
else
    fail "backup content matches source"
fi
assert_file_contains "$WORK/calls.log" "chown glp:glp $DATA_DIR/glp.db.pre-go-backup" "chown ran on the backup file"
assert_file_contains "$WORK/calls.log" "chown glp:glp $DATA_DIR/.go-cutover-done" "chown ran on the marker"
# Idempotency: a second run must be a no-op (marker already present).
rm -f "$WORK/calls.log"
run_entrypoint
assert_not_contains "$WORK/calls.log" "cp " "second run does not re-run the backup (marker already set)"

# ── Scenario 3: leftover .tmp cleanup ───────────────────────────────────────
# A stale .tmp from a prior interrupted attempt must not survive/corrupt a
# subsequent successful run -- backup_data_file's cp overwrites it in place.
reset_scenario "leftover .tmp cleanup"
echo "fresh db content" > "$DATA_DIR/glp.db"
echo "stale garbage from a crashed prior attempt" > "$DATA_DIR/glp.db.pre-go-backup.tmp"
run_entrypoint
assert_file_exists "$DATA_DIR/.go-cutover-done" "marker gets set"
assert_file_absent "$DATA_DIR/glp.db.pre-go-backup.tmp" "leftover .tmp is gone after mv"
if [ "$(cat "$DATA_DIR/glp.db.pre-go-backup")" = "fresh db content" ]; then
    pass "final backup holds the fresh content, not the stale leftover"
else
    fail "final backup holds the fresh content, not the stale leftover"
fi

# ── Scenario 4: ENOSPC-style cp failure on backup ───────────────────────────
reset_scenario "cp failure (ENOSPC)"
echo "fake db content" > "$DATA_DIR/glp.db"
touch "$WORK/fail-cp"
if run_entrypoint 2>"$WORK/stderr.log"; then
    pass "run_pre_go_backup does not abort the whole entrypoint on a cp failure"
else
    fail "run_pre_go_backup does not abort the whole entrypoint on a cp failure"
fi
assert_file_contains "$WORK/stderr.log" "WARNING: backup of $DATA_DIR/glp.db failed" "cp failure is logged as a warning"
assert_file_absent "$DATA_DIR/glp.db.pre-go-backup" "no backup file left behind on cp failure"
assert_file_absent "$DATA_DIR/glp.db.pre-go-backup.tmp" "no leftover .tmp after a failed cp"
assert_file_exists "$DATA_DIR/.go-cutover-done" "marker still gets set despite the backup failure (one-shot by design)"

# ── Scenario 5: chown failure on the backup file ────────────────────────────
reset_scenario "chown failure on backup"
echo "fake db content" > "$DATA_DIR/glp.db"
FAKE_CHOWN_FAIL_SUBSTR=".pre-go-backup"
if run_entrypoint 2>"$WORK/stderr.log"; then
    pass "run_pre_go_backup does not abort the whole entrypoint on a chown failure"
else
    fail "run_pre_go_backup does not abort the whole entrypoint on a chown failure"
fi
assert_file_contains "$WORK/stderr.log" "chown glp:glp failed on $DATA_DIR/glp.db.pre-go-backup" "backup chown failure is logged"
assert_file_absent "$DATA_DIR/glp.db.pre-go-backup" "misowned backup file is removed rather than left root-owned"
assert_file_exists "$DATA_DIR/.go-cutover-done" "marker (unaffected by the backup-file chown failure) still gets set"

# ── Scenario 6: touch failure on the marker (disk full/read-only) ──────────
reset_scenario "touch failure on marker"
touch "$WORK/fail-touch"
if run_entrypoint 2>"$WORK/stderr.log"; then
    pass "run_pre_go_backup does not abort the whole entrypoint when the marker touch fails"
else
    fail "run_pre_go_backup does not abort the whole entrypoint when the marker touch fails"
fi
assert_file_contains "$WORK/stderr.log" "WARNING: failed to write $DATA_DIR/.go-cutover-done" "marker touch failure is logged"
assert_file_absent "$DATA_DIR/.go-cutover-done" "marker stays absent so the backup-check re-runs next boot"

# ── Scenario 7: chown failure on the marker (touch ok, chown fails) ────────
reset_scenario "chown failure on marker"
FAKE_CHOWN_FAIL_SUBSTR=".go-cutover-done"
if run_entrypoint 2>"$WORK/stderr.log"; then
    pass "run_pre_go_backup does not abort the whole entrypoint on a marker chown failure"
else
    fail "run_pre_go_backup does not abort the whole entrypoint on a marker chown failure"
fi
assert_file_contains "$WORK/stderr.log" "chown glp:glp failed on $DATA_DIR/.go-cutover-done" "marker chown failure is logged"
assert_file_absent "$DATA_DIR/.go-cutover-done" "misowned marker is removed so the backup-check re-runs next boot"

# ── Scenario 8: marker missing but backup already exists (round 7 race) ───
# Simulates the exact bug round 7 fixes: the marker fails to stick (as in
# scenario 6/7 above) after a first backup already succeeded, and the
# backup-check then re-runs on a later boot against a glp.db that's since
# been modified (by the Go server, in the real scenario this models) --
# the pre-existing backup must survive completely untouched, never
# overwritten with that newer, no-longer-pre-cutover content.
reset_scenario "marker missing, backup already exists"
echo "original node content" > "$DATA_DIR/glp.db"
echo "original node wal content" > "$DATA_DIR/glp.db-wal"
run_entrypoint
rm -f "$DATA_DIR/.go-cutover-done"
echo "go-modified content, must never overwrite the backup" > "$DATA_DIR/glp.db"
echo "go-modified wal content, must never overwrite the backup" > "$DATA_DIR/glp.db-wal"
rm -f "$WORK/calls.log"
run_entrypoint
if [ "$(cat "$DATA_DIR/glp.db.pre-go-backup")" = "original node content" ]; then
    pass "glp.db backup is unchanged by the marker-less re-run"
else
    fail "glp.db backup is unchanged by the marker-less re-run"
fi
if [ "$(cat "$DATA_DIR/glp.db-wal.pre-go-backup")" = "original node wal content" ]; then
    pass "glp.db-wal backup is unchanged by the marker-less re-run"
else
    fail "glp.db-wal backup is unchanged by the marker-less re-run"
fi
assert_not_contains "$WORK/calls.log" "cp " "no cp is even attempted once a file's backup already exists"
assert_file_exists "$DATA_DIR/.go-cutover-done" "marker gets (re-)written on this run"

echo
if [ "$FAILURES" -eq 0 ]; then
    echo "All docker-entrypoint.sh scenarios passed."
    exit 0
else
    echo "$FAILURES scenario check(s) failed."
    exit 1
fi
