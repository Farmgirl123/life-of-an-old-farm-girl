#!/usr/bin/env bash
set -euo pipefail

# One-click provision for S3 + CloudFront (OAC) and bucket policy
# REQUIREMENTS: awscli v2, jq
#
# USAGE:
#   export AWS_REGION=us-east-1
#   export S3_BUCKET=my-bucket-name
#   # Optional custom domain + cert (ACM cert must be in us-east-1):
#   # export CUSTOM_DOMAIN=media.example.com
#   # export ACM_CERT_ARN=arn:aws:acm:us-east-1:123456789012:certificate/...
#   ./scripts/provision_cdn.sh
#
# OUTPUT:
#   - CloudFront Distribution ID & Domain
#   - Suggested S3_PUBLIC_URL_BASE

echo "=== Provision S3 + CloudFront (OAC) ==="

: "${AWS_REGION:?Set AWS_REGION}"
: "${S3_BUCKET:?Set S3_BUCKET}"

if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required"; exit 1
fi

aws configure set default.region "$AWS_REGION"

# 1) Create S3 bucket if missing
if aws s3api head-bucket --bucket "$S3_BUCKET" 2>/dev/null; then
  echo "Bucket exists: $S3_BUCKET"
else
  echo "Creating bucket: $S3_BUCKET"
  if [ "$AWS_REGION" = "us-east-1" ]; then
    aws s3api create-bucket --bucket "$S3_BUCKET"
  else
    aws s3api create-bucket --bucket "$S3_BUCKET" --create-bucket-configuration LocationConstraint="$AWS_REGION"
  fi
fi

# Block public access (we’ll use CloudFront OAC)
aws s3api put-public-access-block --bucket "$S3_BUCKET" --public-access-block-configuration \
'{"BlockPublicAcls":true,"IgnorePublicAcls":true,"BlockPublicPolicy":true,"RestrictPublicBuckets":true}'

# 2) Create Origin Access Control (OAC)
OAC_NAME="oac-${S3_BUCKET}-$(date +%s)"
oac_id=$(aws cloudfront create-origin-access-control --origin-access-control-config \
'{"Name":"'"$OAC_NAME"'","Description":"OAC for '"$S3_BUCKET"'","SigningProtocol":"sigv4","SigningBehavior":"always","OriginAccessControlOriginType":"s3"}' \
| jq -r '.OriginAccessControl.Id')

echo "Created OAC: $oac_id"

# 3) Create CloudFront distribution
S3_ORIGIN_DOMAIN="$S3_BUCKET.s3.$AWS_REGION.amazonaws.com"
if [ "$AWS_REGION" = "us-east-1" ]; then
  S3_ORIGIN_DOMAIN="$S3_BUCKET.s3.amazonaws.com"
fi

DISTRIBUTION_CONFIG=$(cat <<JSON
{
  "CallerReference": "farm-girl-$(date +%s)",
  "Comment": "Life of an Old Farm Girl CDN",
  "Enabled": true,
  "Origins": {
    "Quantity": 1,
    "Items": [{
      "Id": "s3-origin",
      "DomainName": "$S3_ORIGIN_DOMAIN",
      "S3OriginConfig": { "OriginAccessIdentity": "" },
      "OriginAccessControlId": "$oac_id"
    }]
  },
  "DefaultCacheBehavior": {
    "TargetOriginId": "s3-origin",
    "ViewerProtocolPolicy": "redirect-to-https",
    "AllowedMethods": {
      "Quantity": 7,
      "Items": ["GET","HEAD","OPTIONS","PUT","POST","PATCH","DELETE"],
      "CachedMethods": {
        "Quantity": 3,
        "Items": ["GET","HEAD","OPTIONS"]
      }
    },
    "Compress": true,
    "ForwardedValues": { "QueryString": false, "Cookies": { "Forward": "none" } },
    "MinTTL": 0,
    "DefaultTTL": 86400,
    "MaxTTL": 31536000
  },
  "PriceClass": "PriceClass_All",
  "HttpVersion": "http2",
  "IsIPV6Enabled": true
}
JSON
)

# Add custom domain + cert if provided
if [ -n "${CUSTOM_DOMAIN:-}" ] && [ -n "${ACM_CERT_ARN:-}" ]; then
  DISTRIBUTION_CONFIG=$(echo "$DISTRIBUTION_CONFIG" | jq \
    --arg dom "$CUSTOM_DOMAIN" --arg arn "$ACM_CERT_ARN" '
      .Aliases = {"Quantity":1,"Items":[ $dom ]} |
      .ViewerCertificate = {"ACMCertificateArn": $arn, "SSLSupportMethod":"sni-only","MinimumProtocolVersion":"TLSv1.2_2021"}')
fi

dist_resp=$(aws cloudfront create-distribution --distribution-config "$DISTRIBUTION_CONFIG")
dist_id=$(echo "$dist_resp" | jq -r '.Distribution.Id')
dist_domain=$(echo "$dist_resp" | jq -r '.Distribution.DomainName')

echo "Created CloudFront Distribution: $dist_id"
echo "Domain: $dist_domain"
echo "Status: $(echo "$dist_resp" | jq -r '.Distribution.Status')"

# 4) Attach bucket policy allowing this distribution via OAC SourceArn
account_id=$(aws sts get-caller-identity | jq -r '.Account')

policy=$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowCloudFrontServicePrincipalReadOnly",
      "Effect": "Allow",
      "Principal": { "Service": "cloudfront.amazonaws.com" },
      "Action": ["s3:GetObject"],
      "Resource": ["arn:aws:s3:::$S3_BUCKET/*"],
      "Condition": {
        "StringEquals": {
          "AWS:SourceArn": "arn:aws:cloudfront::$account_id:distribution/$dist_id"
        }
      }
    }
  ]
}
JSON
)

aws s3api put-bucket-policy --bucket "$S3_BUCKET" --policy "$policy"
echo "Applied bucket policy for Distribution $dist_id"

echo ""
echo "=== DONE ==="
echo "CloudFront Domain: https://$dist_domain"
echo "Suggested env for app:"
echo "  S3_PUBLIC_URL_BASE=https://$dist_domain"
