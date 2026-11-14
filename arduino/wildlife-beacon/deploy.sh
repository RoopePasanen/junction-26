#!/usr/bin/env bash
# Copy the wildlife-beacon app to the UNO Q and restart it.
#
#   ./deploy.sh usb                                     # board on the USB cable (adb)
#   ./deploy.sh 172.20.10.12 http://172.20.10.2:3000/api/events   # over Wi-Fi (ssh)
#
# USB: also forwards the board's port 7000 to this laptop, so the board page is
# http://localhost:7000 and the dashboard pulls events with
#   BOARD_URL=http://localhost:7000 npm run dev      (in Suomikartta/)
#
# Wi-Fi: dashboard-url = the Suomikartta server on the laptop (its IP on the same network).
# It is written into the board's copy of main.py only; the repo keeps DASHBOARD_URL = "".
set -euo pipefail

TARGET="${1:?usage: ./deploy.sh usb | <board-ip> [dashboard-url]}"
DASH="${2:-}"
APP="/home/arduino/ArduinoApps/wildlife-beacon"
HERE="$(cd "$(dirname "$0")" && pwd)"
FILES=(app.yaml python/main.py assets/index.html sketch/sketch.ino sketch/sketch.yaml)

if [ "$TARGET" = "usb" ]; then
  # Git Bash on Windows: keep /home/... as is, give adb.exe a Windows path for local files.
  export MSYS_NO_PATHCONV=1
  LOCAL="$(cygpath -m "$HERE" 2>/dev/null || echo "$HERE")"
  run() { adb shell "$1"; }
  put() { adb push "$LOCAL/$1" "$APP/$1" >/dev/null; }
else
  KEY="${SSH_KEY:-$HOME/.ssh/unoq}"
  run() { ssh -i "$KEY" -o ConnectTimeout=8 "arduino@$TARGET" "$1"; }
  put() { scp -i "$KEY" -q "$HERE/$1" "arduino@$TARGET:$APP/$1"; }
fi

run "mkdir -p $APP/python $APP/assets $APP/sketch"
for f in "${FILES[@]}"; do put "$f"; done

if [ -n "$DASH" ]; then
  run "sed -i 's|^DASHBOARD_URL = .*|DASHBOARD_URL = \"$DASH\"|' $APP/python/main.py && grep -n '^DASHBOARD_URL' $APP/python/main.py"
fi

run "arduino-app-cli app restart $APP"

if [ "$TARGET" = "usb" ]; then
  adb forward tcp:7000 tcp:7000 >/dev/null
  echo "Deployed. Page: http://localhost:7000  Logs: adb shell arduino-app-cli app logs $APP --follow"
else
  echo "Deployed. Page: http://$TARGET:7000  Logs: ssh arduino@$TARGET arduino-app-cli app logs $APP --follow"
fi
