#!/bin/sh
# Remove the temporary mbp-side install (safe to re-run).
set -eu
HOST=${1:-void@mbp}
ssh "$HOST" 'rm -rf /tmp/pinomad-spike-345'
echo "removed /tmp/pinomad-spike-345 on $HOST"
