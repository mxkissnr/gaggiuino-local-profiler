#!/usr/bin/env bash
# Verifies the build attestation of every published release image.
# Usage: verify-release-images.sh <release tag, e.g. v3.7.0>
set -euo pipefail

RELEASE_TAG="${1:-}"
if [[ ! "$RELEASE_TAG" =~ ^v[0-9]+(\.[0-9]+)*$ ]]; then
  echo "usage: $0 vX.Y.Z" >&2
  exit 2
fi

repo=mxkissnr/gaggiuino-local-profiler
failed=0
for arch in amd64 armv7 aarch64; do
  for tag in latest "${RELEASE_TAG#v}"; do
    image="ghcr.io/$repo/$arch:$tag"
    if out=$(gh attestation verify "oci://$image" --repo "$repo" \
      --signer-workflow "$repo/.github/workflows/build.yaml" \
      --source-ref "refs/tags/$RELEASE_TAG" 2>&1); then
      echo "OK $image"
    else
      echo "FAILED $image"
      echo "$out" | sed 's/^/    /'
      failed=1
    fi
  done
done
exit "$failed"
