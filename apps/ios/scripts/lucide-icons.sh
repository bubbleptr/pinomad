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

# symbol <name> <out-dir> <ultralight-stroke-%> <black-stroke-%>
symbol() {
  local name=$1 set="$2/$1.symbolset"
  mkdir -p "$set"
  # Our own drawings on Lucide's grid live in icons/ and win over Lucide.
  local src="$ROOT/apps/ios/scripts/icons/$name.svg"
  [ -f "$src" ] || src="$WORK/package/icons/$name.svg"
  # One fixed crop for every icon keeps Lucide's shared 24px grid, so
  # icons keep their relative sizes; this one lands a circle on SF's.
  # (`auto` crops each icon to itself.)
  swiftdraw "$src" --format sfsymbol --insets 4,1,4,1 \
    --ultralight-stroke-width "$3%" --black-stroke-width "$4%" \
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
}

generate() {
  local LIST=$1 OUT=$2
  rm -rf "$OUT"
  mkdir -p "$OUT"
  printf '{\n  "info" : {\n    "author" : "xcode",\n    "version" : 1\n  }\n}\n' >"$OUT/Contents.json"

  # The 2px stroke is the regular weight; the thin and heavy ends scale it
  # so the symbol follows the font's weight.
  grep -vE '^(#|$)' "$LIST" | while read -r name; do
    symbol "$name" "$OUT" 50 150
  done

  # A symbol whose weights differ in structure is not interpolatable, and
  # iOS draws it blank: Lucide's message-circle, whose 1px tail arcs
  # collapse to a point at exactly 2px. Compile once to find those, and
  # give them one weight throughout.
  local check="$WORK/check.xcassets" car="$WORK/check-car"
  rm -rf "$check" "$car"
  mkdir -p "$car"
  cp -R "$OUT" "$check"
  xcrun actool "$check" --compile "$car" --platform iphonesimulator \
    --minimum-deployment-target 26.0 --target-device iphone \
    --output-partial-info-plist "$car/info.plist" >/dev/null
  # stderr: assetutil warns about a class it shares with libate.
  xcrun --sdk iphoneos assetutil --info "$car/Assets.car" 2>/dev/null | python3 -I -c '
import json, sys
for e in json.load(sys.stdin):
    if e.get("AssetType") == "Vector Glyph" and e.get("Glyph Weight") == "Regular" and not e.get("Interpolatable"):
        print(e["Name"])' | while read -r name; do
    symbol "$name" "$OUT" 100 100
    echo "  $name: weights do not interpolate, generated at one weight"
  done
  echo "Generated $(ls -d "$OUT"/*.symbolset | wc -l | tr -d ' ') symbols in ${OUT#"$ROOT"/}"
}

generate "$ROOT/apps/ios/scripts/lucide-icons.txt" "$ROOT/apps/ios/Pinomad/Assets.xcassets/Lucide"
generate "$ROOT/packages/agent-chat-kit/scripts/lucide-icons.txt" \
  "$ROOT/packages/agent-chat-kit/Sources/AgentChatKit/Resources/Icons.xcassets"
