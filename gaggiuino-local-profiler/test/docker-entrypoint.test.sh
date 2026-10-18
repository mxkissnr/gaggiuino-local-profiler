#!/bin/sh
# Automated regression test for docker-entrypoint.sh's #271 data-ownership
# fix (fix_data_ownership()).
#
# An unconditional `chown -R glp:glp /data` rewrites every inode under the
# data dir on every boot, which is slow on an SD card, so the entrypoint now
# chowns only when something under /data is not already owned by glp. This
# script covers the three cases that matter:
#   1. a misowned entry triggers the recursive chown;
#   2. a data dir already owned by glp skips it (the common boot writes
#      nothing);
#   3. a chown failure only warns and lets the boot continue.
#
# It sources the real docker-entrypoint.sh (DOCKER_ENTRYPOINT_TEST=1 stops it
# from also running fix_data_ownership/exec su-exec on source -- see that
# script's own comment) to get the actual function under test, rather than
# reimplementing its logic here. Each scenario runs in its own throwaway
# DATA_DIR (via the GLP_DATA_DIR override the entrypoint reads) with a PATH
# prepended with fake find/chown stubs (fake-bin/), so root privileges and a
# real `glp` user are never required: this test process is unprivileged and
# has no `glp` account, so a real `find -user glp` would just error out and a
# real `chown` would fail unconditionally. The find stub reports a misowned
# path only while $WORK/find-misowned exists; the chown stub is a pure no-op
# that never chowns anything -- each stub logs its invocation to
# $WORK/calls.log so the tests can assert on it, and chown can be told to
# fail on demand via FAKE_CHOWN_FAIL_SUBSTR (fails only the call whose last
# argument contains that substring).
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

# fake_find writes a find stub that logs its invocation and reports a
# misowned path (on stdout) only while $WORK/find-misowned exists -- standing
# in for `find "$DATA_DIR" ! -user glp -print -quit`, which cannot run here
# because this unprivileged test process has no `glp` account to match
# against.
fake_find() {
    cat > "$FAKE_BIN/find" <<EOF
#!/bin/sh
echo "find \$*" >> "$WORK/calls.log"
if [ -f "$WORK/find-misowned" ]; then
    echo "$DATA_DIR/some-file"
fi
exit 0
EOF
    chmod +x "$FAKE_BIN/find"
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

# reset_scenario wipes DATA_DIR + flags + call log so each scenario starts
# from a clean slate, and (re-)installs the stub binaries.
reset_scenario() {
    CURRENT="$1"
    DATA_DIR="$WORK/data"
    rm -rf "$DATA_DIR"
    mkdir -p "$DATA_DIR"
    rm -f "$WORK"/fail-* "$WORK/calls.log" "$WORK/find-misowned"
    FAKE_CHOWN_FAIL_SUBSTR=""
    fake_chown
    fake_find
}

# run_entrypoint sources the real script (functions only, per
# DOCKER_ENTRYPOINT_TEST) and calls fix_data_ownership against the DATA_DIR/
# fake-bin PATH/FAKE_CHOWN_FAIL_SUBSTR set up by reset_scenario (and any
# scenario-specific override made after it).
#
# The call runs in a *child* `sh -e -c` process, not an in-process subshell:
# scenario 3 needs the real exit status, and a function invoked from the
# caller's `if`/`||` condition has `set -e` suppressed inside it (POSIX
# ignores -e for a condition's command), so a failure that would abort the
# real, `set -e`-guarded entrypoint was invisible there. A fresh `sh -e`
# starts with errexit on no matter how the parent calls it, so a regression
# that lets a failure escape the function's own error handling really does
# abort, exactly as it would in the container.
run_entrypoint() {
    PATH="$FAKE_BIN:$PATH" \
        DOCKER_ENTRYPOINT_TEST=1 \
        GLP_DATA_DIR="$DATA_DIR" \
        FAKE_CHOWN_FAIL_SUBSTR="${FAKE_CHOWN_FAIL_SUBSTR:-}" \
        sh -e -c '. "$1"; fix_data_ownership' sh "$ENTRYPOINT"
}

# ── Scenario 1: a misowned entry triggers the recursive chown ───────────────
reset_scenario "misowned data dir"
touch "$WORK/find-misowned"
run_entrypoint
assert_file_contains "$WORK/calls.log" "find " "the ownership check runs"
assert_file_contains "$WORK/calls.log" "chown -R glp:glp $DATA_DIR" "chown -R runs when something under /data is misowned"

# ── Scenario 2: data dir already owned by glp -- chown is skipped ───────────
reset_scenario "already owned by glp"
run_entrypoint
assert_file_contains "$WORK/calls.log" "find " "the ownership check still runs"
assert_not_contains "$WORK/calls.log" "chown " "chown is skipped when everything under /data is already owned by glp"

# ── Scenario 3: chown failure only warns and continues ──────────────────────
reset_scenario "chown failure"
touch "$WORK/find-misowned"
FAKE_CHOWN_FAIL_SUBSTR="$DATA_DIR"
status=0
run_entrypoint 2>"$WORK/stderr.log" || status=$?
if [ "$status" -eq 0 ]; then
    pass "fix_data_ownership does not abort the whole entrypoint on a chown failure"
else
    fail "fix_data_ownership does not abort the whole entrypoint on a chown failure (exit $status)"
fi
assert_file_contains "$WORK/stderr.log" "WARNING: chown -R glp:glp failed on $DATA_DIR" "chown failure is logged as a warning"

echo
if [ "$FAILURES" -eq 0 ]; then
    echo "All docker-entrypoint.sh scenarios passed."
    exit 0
else
    echo "$FAILURES scenario check(s) failed."
    exit 1
fi
