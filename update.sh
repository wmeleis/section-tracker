#!/bin/bash
# Fall 2026 Section Tracker refresh (launchd).
# Pull Tableau custom view -> store -> rebuild encrypted site -> force-push gh-pages.
#
# Retry-until-success, once per calendar day. launchd fires this every 30 min
# (+ on wake). We want at most ONE successful refresh per day, but we want a
# failed attempt (e.g. the network isn't up yet at 6:30am, as happened 2026-07-09)
# to be retried by the next firing instead of leaving the site stale all day.
#   - Before 6am: skip (preserve the morning-refresh intent; no overnight runs).
#   - Already succeeded today (data/last_success_date == today): skip.
#   - Otherwise run run_update.py; on exit 0, stamp today so later firings no-op.
# So the day's first attempt is ~6am-ish; if it fails, each subsequent 30-min
# firing retries until one succeeds, then the rest of the day is quiet.
cd "$(dirname "$0")" || exit 1
mkdir -p data

TODAY=$(date '+%Y-%m-%d')
HOUR=$((10#$(date '+%H')))          # 10# forces base-10 (avoid "08"/"09" octal error)
SUCCESS_FILE="data/last_success_date"

# Don't start before 6am.
[ "$HOUR" -lt 6 ] && exit 0

# Already refreshed successfully today? Nothing to do.
if [ -f "$SUCCESS_FILE" ] && [ "$(cat "$SUCCESS_FILE" 2>/dev/null)" = "$TODAY" ]; then
  exit 0
fi

echo "===== $(date '+%Y-%m-%d %H:%M:%S') =====" >> data/update.log
/usr/bin/python3 run_update.py >> data/update.log 2>&1
RC=$?
echo "exit $RC at $(date '+%H:%M:%S')" >> data/update.log
# Mark today done only on success -> a failure leaves the marker stale so the
# next 30-min firing retries.
[ "$RC" -eq 0 ] && echo "$TODAY" > "$SUCCESS_FILE"
exit "$RC"
