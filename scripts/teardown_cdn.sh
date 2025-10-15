#!/usr/bin/env bash
set -euo pipefail

# Teardown CloudFront distribution and OAC (does NOT delete S3 bucket)
# REQUIREMENTS: awscli v2, jq
#
# USAGE:
#   export DISTRIBUTION_ID=E123ABC...
#   ./scripts/teardown_cdn.sh

: "${DISTRIBUTION_ID:?Set DISTRIBUTION_ID}"

has_jq=$(command -v jq || true)
if [ -z "$has_jq" ]; then
  echo "ERROR: jq is required"; exit 1
fi

echo "Fetching current distribution config..."
resp=$(aws cloudfront get-distribution --id "$DISTRIBUTION_ID")
etag=$(echo "$resp" | jq -r '.ETag')
config=$(echo "$resp" | jq '.Distribution.DistributionConfig')

echo "Disabling distribution..."
disabled=$(echo "$config" | jq '.Enabled=false')
aws cloudfront update-distribution --id "$DISTRIBUTION_ID" --if-match "$etag" --distribution-config "$disabled"

echo "Waiting 30s before delete (propagation delay)..."
sleep 30

echo "Fetching updated ETag..."
etag2=$(aws cloudfront get-distribution-config --id "$DISTRIBUTION_ID" | jq -r '.ETag')

echo "Deleting distribution..."
aws cloudfront delete-distribution --id "$DISTRIBUTION_ID" --if-match "$etag2"

echo "NOTE: OAC must be deleted manually if needed."
echo "Done."
