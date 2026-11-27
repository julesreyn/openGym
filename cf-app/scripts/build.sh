#!/usr/bin/env bash
# Builds the app for the Worker's static assets: cf-app/dist/ (wrangler.jsonc "assets").
# The exercise media are NOT copied here: they are licensed and stay off public assets; they go
# to the private R2 bucket once (scripts/upload-exercise-media.mjs) and the Worker serves them.
set -euo pipefail
cd "$(dirname "$0")/.."
APP="$PWD"
ROOT="$(cd .. && pwd)"

(cd "$ROOT/frontend" && npm ci --ignore-scripts && npm run build)
rm -rf "$APP/dist"
cp -r "$ROOT/frontend/dist" "$APP/dist"
# A build must never carry the media (licence, NOTICE.md): stop if one slipped in.
if [ -e "$APP/dist/exercise-media" ]; then echo "dist/exercise-media must not exist" >&2; exit 1; fi

# The headers nginx sets (web/nginx.conf.template, web/Dockerfile CONTENT_SECURITY_POLICY):
# security headers on everything, then the three cache classes.
CSP="${CONTENT_SECURITY_POLICY:-default-src 'self'; script-src 'self' 'sha256-G6hveK3W3qL6wotsg9mMbpCvPnzXurSHhi8Jb3TS2Vc='; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob: https:; font-src 'self' data:; connect-src 'self' https: http:; worker-src 'self'; manifest-src 'self'; frame-src https://www.youtube-nocookie.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'}"
cat > "$APP/dist/_headers" <<EOF
/*
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: same-origin
  Content-Security-Policy: $CSP
  Cache-Control: no-cache, must-revalidate
/assets/*
  ! Cache-Control
  Cache-Control: public, max-age=31536000, immutable
EOF

echo "cf-app/dist: $(find "$APP/dist" -type f | wc -l | tr -d ' ') files (Workers Free allows 20,000)"
