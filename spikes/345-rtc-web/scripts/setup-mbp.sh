#!/bin/sh
# One-time deps for the mbp-side peer/browser used by the LAN runs.
set -eu
HOST=${1:-void@mbp}
DIR=/tmp/pinomad-spike-345
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

ssh "$HOST" "mkdir -p $DIR"
scp "$ROOT/src/remote/package.json" "$HOST:$DIR/package.json"
ssh "$HOST" "export PATH=/opt/homebrew/bin:\$PATH; cd $DIR && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --no-audit --no-fund"
ssh "$HOST" 'test -d "/Applications/Google Chrome.app" && "/opt/homebrew/bin/node" -e "import(\"node-datachannel\").then(m=>console.log(\"node-datachannel\", m.default.getLibraryVersion())).catch(e=>{console.error(e.message);process.exit(1)})" && echo "mbp setup ok"'
