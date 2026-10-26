#!/bin/bash
# Runs on mbp (darwin-arm64). Spike #345 0a packaging smoke.
# Prereq (from the repo root):
#   scp apps/cli/out/pinomad-0.0.0-spike345.1.tgz void@mbp:/tmp/pinomad-spike-345/
#   scp spikes/345-rtc-web/src/rtc-preflight.mjs void@mbp:/tmp/pinomad-spike-345/
#   scp spikes/345-rtc-web/scripts/mbp-package-smoke.sh void@mbp:/tmp/pinomad-spike-345/
#   ssh void@mbp 'bash /tmp/pinomad-spike-345/mbp-package-smoke.sh'
#
# Same pi workaround as the linux script: pin pi-agent-core/tui/ai to 1.2.0 so
# the RTC packaging test is not blocked by the registry missing pi-ai 1.4.0.
set -u
export PATH=/opt/homebrew/bin:$PATH
BASE=/tmp/pinomad-spike-345
TGZ=${1:-$BASE/pinomad-0.0.0-spike345.1.tgz}
free_port() { node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>process.stdout.write(String(p)))})"; }
wait_ready() { local log=$1; for i in $(seq 1 160); do if grep -q '"event":"ready"' "$log" 2>/dev/null; then return 0; fi; sleep 0.25; done; return 1; }

for mode in default omit; do
  DIR=/tmp/pinomad-pkg-mbp-$mode
  rm -rf "$DIR"; mkdir -p "$DIR"; cd "$DIR"
  cat > package.json <<'EOF'
{
  "name": "pinomad-pkg-mbp-test",
  "private": true,
  "overrides": {
    "@earendil-works/pi-agent-core": "1.2.0",
    "@earendil-works/pi-tui": "1.2.0",
    "@earendil-works/pi-ai": "1.2.0"
  }
}
EOF
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
  echo -n "version: "; ./node_modules/.bin/pinomad --version
  cp "$BASE/rtc-preflight.mjs" .
  echo "rtc:"
  node rtc-preflight.mjs 2>&1 | grep '^rtc:' | sed 's/^/  /'

  DATA=$(mktemp -d /tmp/pinomad-mbp-$mode-host-XXXXXX)
  PORT=$(free_port)
  ./node_modules/.bin/pinomad host --faux hi --data-dir "$DATA" --port "$PORT" > host.log 2>&1 &
  HPID=$!
  if wait_ready host.log; then
    echo "host: ready web_http=$(curl -sS -m 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/") port=$PORT"
  else
    echo "host: NOT READY"; tail -15 host.log
  fi
  kill "$HPID" 2>/dev/null; wait "$HPID" 2>/dev/null; rm -rf "$DATA"

  DATA2=$(mktemp -d /tmp/pinomad-mbp-$mode-server-XXXXXX)
  PORT2=$(free_port)
  PINOMAD_SERVER_USER=spike PINOMAD_SERVER_PASSWORD=spike-password-long-enough ./node_modules/.bin/pinomad server --public-origin "http://127.0.0.1:$PORT2" --data-dir "$DATA2" --port "$PORT2" > server.log 2>&1 &
  SPID=$!
  if wait_ready server.log; then
    echo "server: ready web_http=$(curl -sS -m 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT2/") port=$PORT2"
  else
    echo "server: NOT READY"; tail -15 server.log
  fi
  kill "$SPID" 2>/dev/null; wait "$SPID" 2>/dev/null; rm -rf "$DATA2"
  cd /
  rm -rf "$DIR"
done
echo DONE
