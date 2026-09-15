#!/usr/bin/env bash
# Update the API on the server: pull, install, migrate, reload.
#
#   /opt/vista/api/deploy/deploy.sh            # deploys master
#   /opt/vista/api/deploy/deploy.sh my-branch  # deploys a branch
#
# Migrations run before the reload. They are additive by design, so the old code
# keeps serving against the new schema for the few seconds in between.
set -euo pipefail

BRANCH="${1:-master}"
cd /opt/vista/api

git fetch --quiet origin
git checkout --quiet "$BRANCH"
git pull --ff-only --quiet origin "$BRANCH"

npm ci --no-audit --no-fund
npx prisma generate
npx prisma migrate deploy

pm2 reload deploy/ecosystem.config.cjs --update-env
pm2 save

sleep 2
curl -fsS http://127.0.0.1:3000/healthz && echo "  <- api healthy on $BRANCH ($(git rev-parse --short HEAD))"
