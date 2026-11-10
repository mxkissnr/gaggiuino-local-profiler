#!/usr/bin/env bash
# Verifies the build attestation of every published release image.
# Usage: verify-release-images.sh <release tag, e.g. v3.7.0>
# Exit codes: 0 verified, 1 a verification failed, 2 usage, 3 the check itself could not run.
set -euo pipefail

RELEASE_TAG="${1:-}"
if [[ ! "$RELEASE_TAG" =~ ^v[0-9]+(\.[0-9]+)*$ ]]; then
  echo "usage: $0 vX.Y.Z" >&2
  exit 2
fi

repo=mxkissnr/gaggiuino-local-profiler
# API and infrastructure errors; anything else from gh stays a finding.
api_error_re='HTTP (401|403|408|429|5[0-9]{2})|UNAUTHORIZED|DENIED|TOOMANYREQUESTS|dial tcp|connection (refused|reset)|TLS handshake|timeout'
failed=0
for arch in amd64 armv7 aarch64; do
  for tag in latest "${RELEASE_TAG#v}"; do
    image="ghcr.io/$repo/$arch:$tag"
    if out=$(gh attestation verify "oci://$image" --repo "$repo" \
      --signer-workflow "$repo/.github/workflows/build.yaml" \
      --source-ref "refs/tags/$RELEASE_TAG" 2>&1); then
      echo "OK $image"
    elif grep -Eq "$api_error_re" <<<"$out"; then
      echo "ERROR $image could not be checked"
      echo "$out" | sed 's/^/    /'
      exit 3
    else
      echo "FAILED $image"
      echo "$out" | sed 's/^/    /'
      failed=1
    fi
  done
done
exit "$failed"
