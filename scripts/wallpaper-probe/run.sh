#!/bin/sh
# 壁纸模式 · Linux X11 探针 (docs/wallpaper-mode.md §6). Needs: openbox, x11-utils (xprop, xwininfo), wmctrl, xdotool,
# x11-xserver-utils (xrandr), imagemagick (import); Xvfb for P0–P5, TigerVNC Xvnc for P6/P7 (Xvfb cannot change mode).
set -u
cd "$(dirname "$0")/../.."
unset ELECTRON_RUN_AS_NODE
E=./node_modules/.bin/electron
OUT=out/wallpaper-probe; mkdir -p "$OUT"
echo "== no window manager (Xvfb only)"
xvfb-run -a -s "-screen 0 1280x800x24" $E --no-sandbox scripts/wallpaper-probe/main.js 2>&1 | grep -E '^(PASS|FAIL|SKIP)'
echo "== Xvfb + openbox"
xvfb-run -a -s "-screen 0 1280x800x24" sh -c "openbox >/dev/null 2>&1 & sleep 1.5; $E --no-sandbox scripts/wallpaper-probe/main.js 2>&1 | grep -E '^(PASS|FAIL|SKIP)'; cp $OUT/result.json $OUT/result-xvfb.json"
echo "== Xvnc + openbox (resolution change, second monitor)"
Xvnc :79 -geometry 1280x800 -depth 24 -SecurityTypes None >/dev/null 2>&1 & XV=$!; sleep 2
DISPLAY=:79 PROBE_XSERVER=xvnc sh -c "openbox >/dev/null 2>&1 & sleep 1.5; $E --no-sandbox scripts/wallpaper-probe/main.js 2>&1 | grep -E '^(PASS|FAIL|SKIP)'; cp $OUT/result.json $OUT/result-xvnc.json"
code=$?
kill $XV 2>/dev/null
exit $code
