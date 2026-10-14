#!/bin/sh
# Runs as root (default), fixes /data ownership for whatever UID the host
# bind-mount actually has (varies per install — HA Supervisor doesn't
# guarantee it matches our container's non-root user), then drops to the
# unprivileged `glp` user before exec'ing the real process. Same pattern
# used by most HA add-ons and images like postgres/grafana that write to a
# host-mounted data dir. See #271.
set -e

DATA_DIR="${GLP_DATA_DIR:-/data}"

# The ownership fix only runs when it is actually wrong. An unconditional
# `chown -R glp:glp /data` rewrites every inode on every boot, which is slow
# on an SD card; `find ... ! -user glp -print -quit` stops at the first
# misowned entry, so an already-correct data dir costs a single walk and no
# writes. A chown failure is logged and the boot continues -- an ownership
# problem must never take the container down.
fix_data_ownership() {
    if [ -z "$(find "$DATA_DIR" ! -user glp -print -quit 2>/dev/null)" ]; then
        return 0
    fi
    if ! chown -R glp:glp "$DATA_DIR"; then
        echo "WARNING: chown -R glp:glp failed on $DATA_DIR, continuing anyway" >&2
    fi
}

# DOCKER_ENTRYPOINT_TEST=1 is a test-only sentinel, checked against the exact
# value "1" and logged loudly: test/docker-entrypoint.test.sh is the only
# thing that should ever set it. A stray/misconfigured value in a real
# container would otherwise make the entrypoint skip the ownership fix and
# exec, i.e. exit without starting the server at all; this makes that failure
# mode visible in the logs instead of a silent, unexplained container exit.
if [ "${DOCKER_ENTRYPOINT_TEST:-}" = "1" ]; then
    echo "DOCKER_ENTRYPOINT_TEST=1: test mode, NOT starting the server (this must never be set in a real container)" >&2
else
    fix_data_ownership
    exec su-exec glp "$@"
fi
