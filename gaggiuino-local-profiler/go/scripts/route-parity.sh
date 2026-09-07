#!/usr/bin/env bash
#
# route-parity.sh — fail if the Node app (server.js + routes/*.js) registers
# an HTTP route the Go rewrite (go/cmd/server/main.go + every internal/*
# package's RegisterRoutes, including the /ui/ templ sub-mux) has no
# equivalent for.
#
# Direction is one-way on purpose: the Go app has routes Node never had
# (the /ui/ templ fallback pages — /shots, /beans, /machines, …), and those
# are not failures. Only Node-has / Go-lacks is a regression during the
# migration.
#
# Routes are compared as "METHOD /normalized/path", where every path
# parameter — Express ":id" and net/http "{id}" alike — is flattened to
# "{}". A Go route registered without a method (main.go's
# mux.Handle("/api/events", …)) matches any method for that exact path.
#
# Genuinely, intentionally deferred Node routes go in ALLOWLIST below, each
# with a comment pointing at where the deferral is documented (the format
# mirrors go/internal/machines/doc.go's "What this phase deliberately does
# NOT port" section). The list is empty because Phase 0-3 (#901) ported
# every REST route.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"   # …/gaggiuino-local-profiler
NODE_DIR="$ROOT"
GO_DIR="$ROOT/go"

# METHOD /normalized/path entries — Node routes with no Go equivalent that
# are known and accepted. Keep empty unless a route is deliberately not
# ported; add a comment with the reference when you add one.
ALLOWLIST=(
  # (none — every routes/*.js route is ported, see go/README.md / the
  #  per-package doc.go files)
)

# normalize: collapse ":param" and "{param}" to "{}", drop net/http's "{$}"
# exact-match marker, strip a trailing slash (except a bare "/").
normalize() {
  sed -E '
    s#/\{\$\}#/#g
    s#:[A-Za-z_][A-Za-z0-9_]*#{}#g
    s#\{[^}]+\}#{}#g
    s#([^/ ])/$#\1#
  '
}

# ── Node routes ───────────────────────────────────────────────────────────
node_routes() {
  # router.get('/path') / app.post("/path") / … across server.js + routes/
  grep -rhoE "(router|app)\.(get|post|put|patch|delete)\(\s*\[?\s*['\"][^'\"]+" \
    "$NODE_DIR/server.js" "$NODE_DIR/routes" \
    | sed -E "s/.*\.(get|post|put|patch|delete)\(\s*\[?\s*['\"]/\1 /" \
    | awk '{ print toupper($1), $2 }'

  # server.js's one array form: app.get(['/', '/index.html'], …)
  grep -hoE "app\.get\(\[[^]]+\]" "$NODE_DIR/server.js" \
    | grep -oE "['\"][^'\"]+['\"]" | tr -d "\"'" \
    | sed 's#^#GET #'
}

# ── Go routes ─────────────────────────────────────────────────────────────
go_routes() {
  grep -rhoE 'mux\.(HandleFunc|Handle)\(\s*"[^"]+"' \
    "$GO_DIR/cmd/server/main.go" "$GO_DIR/internal" \
    --include='*.go' --exclude='*_test.go' \
    | sed -E 's/.*mux\.(HandleFunc|Handle)\(\s*"//; s/".*//' \
    | awk '{
        if ($1 ~ /^(GET|POST|PUT|PATCH|DELETE|HEAD)$/) { print $1, $2 }
        else { print "ANY", $1 }
      }'
}

GO_NORM="$(go_routes | normalize | sort -u)"
NODE_NORM="$(node_routes | normalize | sort -u)"

covered() {
  local route="$1"
  local path="${route#* }"
  grep -qxF "$route" <<<"$GO_NORM" && return 0
  grep -qxF "ANY $path" <<<"$GO_NORM" && return 0
  return 1
}

allowlisted() {
  local route="$1" entry
  for entry in "${ALLOWLIST[@]}"; do
    [[ "$entry" == "$route" ]] && return 0
  done
  return 1
}

missing=()
allowed_hits=()
while IFS= read -r route; do
  [[ -z "$route" ]] && continue
  if covered "$route"; then
    continue
  fi
  if allowlisted "$route"; then
    allowed_hits+=("$route")
    continue
  fi
  missing+=("$route")
done <<<"$NODE_NORM"

node_count="$(grep -c . <<<"$NODE_NORM" || true)"
go_count="$(grep -c . <<<"$GO_NORM" || true)"
echo "route-parity: $node_count Node routes, $go_count Go routes"

if ((${#allowed_hits[@]})); then
  echo
  echo "Allowlisted (Node route, deferred in Go):"
  printf '  %s\n' "${allowed_hits[@]}"
fi

if ((${#missing[@]})); then
  echo
  echo "FAIL — Node routes with no Go equivalent:"
  printf '  %s\n' "${missing[@]}"
  exit 1
fi

echo "route-parity: OK — every Node route has a Go equivalent"
