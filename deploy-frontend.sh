#!/bin/sh
# Rebuild and restart the polyp frontend, safely.
#
# Next.js runs here in STANDALONE mode: systemd runs `node server.js` from
# .next/standalone. `next build` writes a fresh server.js there but leaves the
# JS/CSS in .next/static and the assets in public/ -- neither is copied in.
# Skip that copy and the app serves HTML whose every chunk 404s: the page
# renders for an instant, React never hydrates, and it goes white. On a phone
# you get raw unstyled HTML with dead buttons.
#
# That is exactly what happened on 2026-08-15. Hence this script, and hence the
# verification at the end: it refuses to leave a broken build running.
set -eu

cd /home/fati/noormind/polyp-detection/frontend

echo "--- housekeeping (disk is tight on this box) ---"
rm -rf .next.bak-* 2>/dev/null || true
df -h / | tail -1

echo "--- build ---"
npx --yes next build

echo "--- the step that must never be skipped ---"
rm -rf .next/standalone/.next/static .next/standalone/public
cp -r .next/static .next/standalone/.next/static
[ -d public ] && cp -r public .next/standalone/public

echo "--- restart ---"
sudo -n systemctl restart polyp-frontend
sleep 4

echo "--- verify every chunk the page asks for actually loads ---"
HTML=$(curl -fsS http://127.0.0.1:19001/)
MISSING=0
for u in $(printf '%s' "$HTML" | grep -o '/_next/static/[a-zA-Z0-9./_-]*\.\(js\|css\)' | sort -u); do
    CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:19001$u")
    [ "$CODE" = "200" ] || { echo "  MISSING $CODE $u"; MISSING=$((MISSING + 1)); }
done
if [ "$MISSING" -gt 0 ]; then
    echo "FAIL: $MISSING asset(s) 404 -- the app would render a white page."
    exit 1
fi
echo "OK: all assets served. Frontend is up."
