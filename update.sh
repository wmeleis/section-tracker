#!/bin/bash
# Daily Fall 2026 Section Tracker refresh (launchd).
# Pull Tableau custom view -> store -> rebuild encrypted site -> force-push gh-pages.
cd "$(dirname "$0")" || exit 1
mkdir -p data
echo "===== $(date '+%Y-%m-%d %H:%M:%S') =====" >> data/update.log
/usr/bin/python3 run_update.py >> data/update.log 2>&1
echo "exit $? at $(date '+%H:%M:%S')" >> data/update.log
