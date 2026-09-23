#!/bin/sh
# Rebuild and restart the local WCE stack so a training round runs on the latest code.
set -e
cd "$(dirname "$0")/../.."
npm run build >/dev/null
pkill -f "scripts/start-wce.mjs" || true
sleep 3
WCE_PUBLIC_PASSWORD="${WCE_PUBLIC_PASSWORD:-ApodDemo2026}" nohup npm run wce:start > evidence/training/stack.log 2>&1 &
for i in $(seq 1 90); do
  if nc -z 127.0.0.1 4720 2>/dev/null && nc -z 127.0.0.1 3001 2>/dev/null && grep -q "APOD ready" evidence/training/stack.log; then echo "stack ready"; exit 0; fi
  sleep 2
done
echo "stack did not start"; tail -20 evidence/training/stack.log; exit 1
