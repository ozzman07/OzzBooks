#!/bin/bash
# Stopgap for slow app-open (see Claude.md's Render cold-start note and
# Ozzbooks_Addendum_CloudMigration for the real fix): Render's free tier
# spins the cloud/ service down after 15 minutes idle, so a family member
# opening the app cold eats a 30-60s wait. Pinging /health more often than
# that 15-minute window keeps it continuously warm.
#
# Restricted to 7am-8pm rather than running 24/7 — nobody needs the app
# overnight, and staying within that window keeps monthly usage to
# roughly 13 hours/day * 30 days =~ 390 hours, comfortably under Render's
# 750 free instance-hour cap. Going over that cap suspends ALL free
# services until the next month resets, which would be worse than the
# cold start this is trying to avoid, so this check errs on the side of
# doing nothing outside the window rather than trying to be clever about it.
#
# Runs every 10 minutes via launchd (see
# ~/Library/LaunchAgents/com.ozzbooks.renderping.plist); the hour check
# below is what actually enforces the 7am-8pm window, not the launchd
# schedule itself.

set -euo pipefail

RENDER_HEALTH_URL="https://ozzbooks.onrender.com/health"

HOUR="$(date +%H)"
if [ "$HOUR" -lt 7 ] || [ "$HOUR" -ge 20 ]; then
  echo "[render-keepalive] outside 7am-8pm window (hour=$HOUR), skipping"
  exit 0
fi

if curl -fsS --max-time 30 "$RENDER_HEALTH_URL" > /dev/null; then
  echo "[render-keepalive] pinged $RENDER_HEALTH_URL"
else
  echo "[render-keepalive] ping failed (Render may be cold-starting or down)" >&2
fi
