#!/usr/bin/env bash
# Nightly database backup: dump, keep 7 days on the server, copy each dump to R2.
#
# The R2 token in /opt/vista/backup.env is write-only, so this machine can add
# backups but never delete or overwrite them — a compromised server cannot take
# its own history with it.
#
# /opt/vista/backup.env must define:
#   R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
#   R2_BUCKET=vista-backups
#   AWS_ACCESS_KEY_ID=...        (the R2 token's access key)
#   AWS_SECRET_ACCESS_KEY=...
#
# Scheduled at 05:30 Malaysia time (21:30 UTC), just after the trading day rolls:
#   30 21 * * * /opt/vista/api/deploy/backup.sh >> /var/log/vista-backup.log 2>&1
set -euo pipefail

# shellcheck disable=SC1091
source /opt/vista/backup.env
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY

DIR=/opt/vista/backups
STAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"
FILE="$DIR/vista-$STAMP.sql.gz"
mkdir -p "$DIR"

docker exec vista-db pg_dump -U vista -d vista --no-owner | gzip -9 > "$FILE"
aws s3 cp "$FILE" "s3://$R2_BUCKET/vista/$(basename "$FILE")" \
  --endpoint-url "$R2_ENDPOINT" --only-show-errors

find "$DIR" -name 'vista-*.sql.gz' -mtime +7 -delete
echo "$(date -u +%FT%TZ) backup ok: $(basename "$FILE") ($(du -h "$FILE" | cut -f1))"
