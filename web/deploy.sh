#!/bin/bash
set -euo pipefail

WEB_ROOT="$(cd "$(dirname "$0")" && pwd)"
NVM_NODE_BIN="${NVM_NODE_BIN:-/home/users/v_qiujie04/.nvm/versions/node/v22.23.1/bin}"
if [ -x "$NVM_NODE_BIN/node" ]; then
  export PATH="$NVM_NODE_BIN:$PATH"
fi

if ! command -v node >/dev/null || ! command -v npm >/dev/null; then
  echo "Node.js and npm are required. Set NVM_NODE_BIN when Node is not on PATH."
  exit 1
fi

cd "$WEB_ROOT"
npm ci
npm run build

echo "Build complete. Start with: npm start"
echo "Cluster view: /app/"
echo "Personal view: /personal/"
echo "Runtime configuration is read from ../config.json."
