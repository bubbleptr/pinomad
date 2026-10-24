#!/bin/bash
# Copy the web client's provider logos (lobehub SVGs,
# docs/licenses/lobehub-icons.md) into the app's asset catalog as vector
# image sets named provider-<file>. The output is committed; run this after
# the logos in apps/web/src/entities/provider/logos change.
#
# Xcode's SVG importer needs an absolute size and doesn't resolve
# currentColor: sizes become the 24pt viewBox, and monochrome logos get a
# fixed fill plus template rendering so SwiftUI tints them like text. A
# logo mixing brand colors with currentColor gets a black and a white copy
# for light and dark appearance instead.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SRC="$ROOT/apps/web/src/entities/provider/logos"
OUT="$ROOT/apps/ios/Pinomad/Assets.xcassets/ProviderLogos"

rm -rf "$OUT"
mkdir -p "$OUT"
cat >"$OUT/Contents.json" <<JSON
{
  "info" : {
    "author" : "xcode",
    "version" : 1
  }
}
JSON

# write <src> <dest> <fill for currentColor>
write() {
  sed -E \
    -e 's#<title>[^<]*</title>##' \
    -e 's# style="[^"]*"##' \
    -e 's#height="1em"#height="24"#' \
    -e 's#width="1em"#width="24"#' \
    -e "s|currentColor|$3|g" \
    "$1" >"$2"
}

for svg in "$SRC"/*.svg; do
  name="$(basename "$svg" .svg)"
  set="$OUT/provider-$name.imageset"
  mkdir -p "$set"
  write "$svg" "$set/$name.svg" "#000000"
  intent="original"
  dark=""
  if grep -q currentColor "$svg"; then
    if grep -o 'fill="[^"]*"' "$svg" | grep -vq currentColor; then
      write "$svg" "$set/$name-dark.svg" "#FFFFFF"
      dark=',
    {
      "appearances" : [
        {
          "appearance" : "luminosity",
          "value" : "dark"
        }
      ],
      "filename" : "'"$name"'-dark.svg",
      "idiom" : "universal"
    }'
    else
      intent="template"
    fi
  fi
  cat >"$set/Contents.json" <<JSON
{
  "images" : [
    {
      "filename" : "$name.svg",
      "idiom" : "universal"
    }$dark
  ],
  "info" : {
    "author" : "xcode",
    "version" : 1
  },
  "properties" : {
    "preserves-vector-representation" : true,
    "template-rendering-intent" : "$intent"
  }
}
JSON
done

echo "Wrote $(ls -d "$OUT"/*.imageset | wc -l | tr -d ' ') logos to $OUT"
