#!/bin/bash
# Deploys the Orsin research pilot to the orsin-io Cloudflare account.
# Same steps as the project's own `pnpm deploy:selfhost`, with pnpm replaced
# by the project's local binaries, and a log kept in .logs/ for review.
set -o pipefail
cd "$(dirname "$0")/.." || exit 1
export NODE_OPTIONS="$NODE_OPTIONS --experimental-strip-types"
mkdir -p .logs
LOG=.logs/deploy.log
{
  echo "== preflight =="
  node scripts/selfhost-deploy-preflight.mjs || exit 1
  echo "== build =="
  ./node_modules/.bin/vite build --mode selfhost || exit 1
  echo "== deploy state store =="
  ./node_modules/.bin/alchemy cloudflare bootstrap || exit 1
  echo "== deploy =="
  ./node_modules/.bin/alchemy deploy deploy/alchemy/alchemy.run.ts --env-file .env.selfhost --stage selfhost --yes
} 2>&1 | tee "$LOG"
STATUS=${PIPESTATUS[0]}
echo "DEPLOY FINISHED exit=$STATUS" | tee -a "$LOG"
if [ "$STATUS" = "0" ]; then
  echo
  echo "DONE. You can go back to the chat."
else
  echo
  echo "Something failed. Go back to the chat; the log is saved for Claude to read."
fi
