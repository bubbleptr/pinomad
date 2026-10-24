#!/bin/bash
# Copy the web client's provider logos (lobehub SVGs,
# docs/licenses/lobehub-icons.md) into the app's asset catalog as vector
# image sets named provider-<file>. The output is committed; run this after
# the logos in apps/web/src/entities/provider/logos change.
#
# Xcode's SVG importer needs an absolute size and doesn't resolve
# currentColor: sizes become the 24pt viewBox, gradients move ahead of
# their use and every stop gets an offset, and monochrome logos get a
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
    -e 's#<stop stop-#<stop offset="0" stop-#g' \
    "$1" |
    # CoreSVG drops a gradient defined after the paths that use it.
    perl -pe 's#^(<svg[^>]*>)(.*)(<defs>.*</defs>)(</svg>)$#$1$3$2$4#' |
    spaced_arcs >"$2"
}

# CoreSVG misreads arc flags packed without separators (`a.5.5 0 00-.9 0`,
# minified SVG's habit); write every path's numbers out spaced.
spaced_arcs() {
  python3 -c '
import re, sys

NUMBER = re.compile(r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?")

def spaced(d):
    out, i, command, arg = [], 0, "", 0
    while i < len(d):
        c = d[i]
        if c.isalpha():
            command, arg = c, 0
            out.append(c)
            i += 1
        elif c in " ,\t\n":
            i += 1
        elif command in "aA" and arg % 7 in (3, 4):
            out.append(c)
            arg += 1
            i += 1
        else:
            number = NUMBER.match(d, i)
            out.append(number.group())
            arg += 1
            i = number.end()
    return " ".join(out)

svg = sys.stdin.read()
sys.stdout.write(re.sub(r"\bd=\"([^\"]*)\"", lambda m: "d=\"" + spaced(m.group(1)) + "\"", svg))
'
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
