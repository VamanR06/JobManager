#!/bin/bash
# Build JobManager and package .next for upload to the server.
# Usage (from the JobManager folder):  ./deploy.sh
# Result: next-build.zip - upload it to JobManager/ on the server and unarchive it there.
set -euo pipefail
cd "$(dirname "$0")"

echo "==> Building..."
npm run build

echo "==> Zipping .next (without cache)..."
rm -f next-build.zip
# -y keeps links as links. Without it, zip would copy your Mac's own better-sqlite3
# into the zip, and that copy can't run on the server.
zip -r -y -q next-build.zip .next \
  -x ".next/cache/*" \
  -x ".next/dev/*" \
  -x "*.DS_Store"

size=$(du -h next-build.zip | cut -f1)
echo
echo "==> Done: next-build.zip ($size)"
echo "    On the server:"
echo "      1. stop jobmanager"
echo "      2. delete JobManager/.next"
echo "      3. upload next-build.zip to JobManager/ and unarchive it"
echo "      4. start jobmanager"