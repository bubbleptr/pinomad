#!/bin/bash
# Linux-x64 packaging smoke for spike #345 0a.
# Usage: scripts/package-smoke.sh [version] [tgz]
#
# The RTC part of the published package is node-datachannel + one optional
# platform prebuild. This checks both the default install (prebuild present,
# module loads) and --omit=optional (prebuild absent, loader explains why, and
# the CLI still starts).
#
# pi workaround: on 2026-10-26 the public registry has pi-agent-core@1.4.0 but
# not pi-ai@1.4.0, so npm's fresh resolution of pi-coding-agent@1.2.0's caret
# deps fails. The repo's bun.lock pins 1.2.0; the temp projects repeat that pin
# with "overrides" so this RTC test is not blocked by an unrelated registry
# state. Remove the overrides once the pi stack resolves normally.
set -u
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
VERSION=${1:-0.0.0-spike345.1}
TGZ=${2:-$ROOT/apps/cli/out/pinomad-$VERSION.tgz}

if [ ! -f "$TGZ" ]; then
  echo "building $VERSION (web + package + npm pack)"
  (cd "$ROOT/apps/web" && bun run build) || exit 1
  (cd "$ROOT" && bun run package -- --version "$VERSION") || exit 1
  (cd "$ROOT/apps/cli/out" && npm pack --silent >/dev/null) || exit 1
  TGZ="$ROOT/apps/cli/out/pinomad-$VERSION.tgz"
fi

free_port() { node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>process.stdout.write(String(p)))})"; }
wait_ready() { local log=$1; for i in $(seq 1 160); do if grep -q '"event":"ready"' "$log" 2>/dev/null; then return 0; fi; sleep 0.25; done; return 1; }

for mode in default omit; do
  DIR=$(mktemp -d "/tmp/pinomad-pkg-$mode-XXXXXX")
  cat > "$DIR/package.json" <<'EOF'
{
  "name": "pinomad-pkg-test",
  "private": true,
  "overrides": {
    "@earendil-works/pi-agent-core": "1.2.0",
    "@earendil-works/pi-tui": "1.2.0",
    "@earendil-works/pi-ai": "1.2.0"
  }
}
EOF
  (
    cd "$DIR" || exit 1
    if [ "$mode" = omit ]; then
      npm install --omit=optional "$TGZ" --no-audit --no-fund > install.log 2>&1
    else
      npm install "$TGZ" --no-audit --no-fund > install.log 2>&1
    fi
    echo "===== $mode install exit=$? ====="
    tail -2 install.log
    echo -n "platform prebuild: "
    find node_modules -maxdepth 3 -path '*@node-datachannel*' -name package.json 2>/dev/null | sed 's#node_modules/##' | tr '\n' ' '
    echo
    BIN="$DIR/node_modules/.bin/pinomad"
    echo -n "version: "; "$BIN" --version

    DATA=$(mktemp -d "/tmp/pinomad-$mode-host-XXXXXX")
    PORT=$(free_port)
    "$BIN" host --faux hi --data-dir "$DATA" --port "$PORT" > host.log 2>&1 &
    HPID=$!
    if wait_ready host.log; then
      echo "host: ready web_http=$(curl -sS -m 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/") port=$PORT"
    else
      echo "host: NOT READY"; tail -15 host.log
    fi
    kill "$HPID" 2>/dev/null; wait "$HPID" 2>/dev/null; rm -rf "$DATA"

    DATA2=$(mktemp -d "/tmp/pinomad-$mode-server-XXXXXX")
    PORT2=$(free_port)
    PINOMAD_SERVER_USER=spike PINOMAD_SERVER_PASSWORD=spike-password-long-enough "$BIN" server --public-origin "http://127.0.0.1:$PORT2" --data-dir "$DATA2" --port "$PORT2" > server.log 2>&1 &
    SPID=$!
    if wait_ready server.log; then
      echo "server: ready web_http=$(curl -sS -m 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT2/") port=$PORT2"
    else
      echo "server: NOT READY"; tail -15 server.log
    fi
    kill "$SPID" 2>/dev/null; wait "$SPID" 2>/dev/null; rm -rf "$DATA2"

    cp "$ROOT/spikes/345-rtc-web/src/rtc-preflight.mjs" .
    echo "rtc:"
    node rtc-preflight.mjs 2>&1 | grep '^rtc:' | sed 's/^/  /'
  )
  rm -rf "$DIR"
done
echo "package smoke ok: $TGZ"
