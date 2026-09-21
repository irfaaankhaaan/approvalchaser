#!/usr/bin/env bash
set -euo pipefail

# Always run from the folder this script is in, no matter where it was
# invoked from.
cd "$(dirname "${BASH_SOURCE[0]}")"

echo "============================================"
echo " Slack Approval Chaser"
echo "============================================"
echo

if ! command -v node > /dev/null 2>&1; then
  echo "Node.js was not found."
  echo "Install it from https://nodejs.org (the LTS version), then run this again."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Installing dependencies - this takes a minute the first time..."
  npm install
  echo
fi

if [ ! -f .env.local ]; then
  echo "Setting up your local configuration..."
  npm run setup
  echo
fi

if [ ! -d .pgdata ]; then
  echo "Loading three demo approvals so there is something to click on..."
  npm run db:seed
  echo
  echo "============================================"
  echo " Copy one of the http://localhost:3000/approve/... links above."
  echo " You'll open it in your browser once the app says \"Ready\"."
  echo "============================================"
  echo
fi

echo "Starting the app..."
echo "Once you see \"Ready\", open http://localhost:3000 in your browser."
echo "Press Ctrl+C to stop it."
echo
exec npm run dev
