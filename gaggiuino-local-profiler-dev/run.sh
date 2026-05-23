#!/bin/sh
set -e

BASE="https://raw.githubusercontent.com/mxkissnr/gaggiuino-local-profiler/dev/gaggiuino-local-profiler"

echo "Pulling latest dev code from GitHub..."
wget -qO /app/server.js "$BASE/server.js"
mkdir -p /app/public
wget -qO /app/public/index.html "$BASE/public/index.html"

echo "Starting GLP Dev..."
exec node /app/server.js
