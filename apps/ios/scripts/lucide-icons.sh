#!/bin/bash
# Regenerate the Lucide icons of the app and of agent-chat-kit as custom SF
# Symbols, so they size with the font, follow its weight and take symbol
# effects like the system set. The output is committed; run this after
# editing either lucide-icons.txt.
# Needs swiftdraw (`brew install swiftdraw`) and npm.
set -euo pipefail

VERSION="1.57.0"
INTEGRITY="sha512-nuf4YoaKt3Pq9scXVQ71SLr0Q1/UZiTcfBBivFsCVL6biAzPplTikVWXLetBmK3oFEJS6f2L1rzgEsoJN/Ce0Q=="

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

(cd "$WORK" && npm pack --silent "lucide-static@$VERSION" >/dev/null)
TGZ="$WORK/lucide-static-$VERSION.tgz"
ACTUAL="sha512-$(openssl dgst -sha512 -binary "$TGZ" | base64)"
if [ "$ACTUAL" != "$INTEGRITY" ]; then
  echo "lucide-static $VERSION integrity mismatch: $ACTUAL" >&2
  exit 1
fi
tar xzf "$TGZ" -C "$WORK"

generate() {
  local LIST=$1 OUT=$2
  rm -rf "$OUT"
  mkdir -p "$OUT"
  printf '{\n  "info" : {\n    "author" : "xcode",\n    "version" : 1\n  }\n}\n' >"$OUT/Contents.json"

  grep -vE '^(#|$)' "$LIST" | while read -r name; do
    set="$OUT/$name.symbolset"
    mkdir -p "$set"
    # One fixed crop for every icon keeps Lucide's shared 24px grid, so
    # icons keep their relative sizes; this one lands a circle on SF's.
    # (`auto` crops each icon to itself.) The 2px stroke is the regular
    # weight; the thin and heavy ends scale it so font weights interpolate.
    swiftdraw "$WORK/package/icons/$name.svg" --format sfsymbol --insets 4,1,4,1 \
      --ultralight-stroke-width 50% --black-stroke-width 150% \
      --output "$set/$name.svg" >/dev/null
    cat >"$set/Contents.json" <<EOF
{
  "info" : {
    "author" : "xcode",
    "version" : 1
  },
  "symbols" : [
    {
      "filename" : "$name.svg",
      "idiom" : "universal"
    }
  ]
}
EOF
  done
  echo "Generated $(ls -d "$OUT"/*.symbolset | wc -l | tr -d ' ') symbols in ${OUT#"$ROOT"/}"
}

generate "$ROOT/apps/ios/scripts/lucide-icons.txt" "$ROOT/apps/ios/Pinomad/Assets.xcassets/Lucide"
generate "$ROOT/packages/agent-chat-kit/scripts/lucide-icons.txt" \
  "$ROOT/packages/agent-chat-kit/Sources/AgentChatKit/Resources/Icons.xcassets"
