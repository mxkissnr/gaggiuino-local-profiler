#!/usr/bin/env bash
# #1557: merge the feature branches listed in $DEV_FEATURES onto the current
# checkout (dev). A conflict fails the run and names the branch instead of
# publishing a half-merged image. Needs a full-history checkout.
set -euo pipefail
git config user.name  "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
for b in ${DEV_FEATURES:-}; do
  git fetch --no-tags origin "$b"
  git merge --no-edit FETCH_HEAD || {
    echo "::error::$b does not merge cleanly onto dev -- merge dev into $b first"
    exit 1
  }
done
