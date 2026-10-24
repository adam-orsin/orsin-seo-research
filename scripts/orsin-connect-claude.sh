#!/bin/bash
# Reconnects Claude Code to the Orsin research pilot after the Cloudflare
# Access sign-in pass expires. Opens the Cloudflare sign-in page in the
# browser, waits for it, then refreshes the stored pass in Claude Code.
set -e
APP=https://open-seo-selfhost.orsin.workers.dev
echo "Opening the Cloudflare sign-in page. Enter adam@orsin.io, then the code from your email."
cloudflared access login "$APP" > /dev/null
claude mcp remove -s user orsin-research > /dev/null 2>&1 || true
claude mcp add -s user -t http orsin-research "$APP/mcp" \
  -H "cf-access-token: $(cloudflared access token --app="$APP")" > /dev/null
echo
echo "DONE. Claude Code is reconnected to the research tool. Start a new Claude Code session to use it."
