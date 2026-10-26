#!/bin/bash
# Build the Rust core's xcframework and generate the UniFFI Swift bindings
# (ADR-0024 §11). Everything this produces is gitignored — run it once
# after a clean checkout, and again whenever pinomad-core changes.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PKG="$ROOT/apps/ios/PinomadCore"
GENERATED="$PKG/Sources/PinomadCore/Generated"
HEADERS="$PKG/Vendor/ffi-headers"
XCFW="$PKG/Vendor/PinomadCoreFFI.xcframework"

cd "$ROOT"

# Device and simulator slices, release. staticlib keeps the Swift side
# free of dylib embedding; --crate-type overrides the rlib default. The ffi
# feature also pulls in pinomad-rtc, so the RTC engine and the protocol core
# ship as one archive and one xcframework (no second Rust staticlib).
cargo rustc -p pinomad-core --features ffi --crate-type staticlib --release \
  --target aarch64-apple-ios
cargo rustc -p pinomad-core --features ffi --crate-type staticlib --release \
  --target aarch64-apple-ios-sim

# uniffi-bindgen extracts metadata from a loadable library: a debug cdylib
# for the host is the cheapest artifact that carries it.
cargo rustc -p pinomad-core --features ffi --crate-type cdylib

rm -rf "$GENERATED" "$HEADERS" "$XCFW"
mkdir -p "$GENERATED" "$HEADERS"

cd "$ROOT/crates/uniffi-bindgen"
cargo run --release -- generate \
  --library "$ROOT/target/debug/libpinomad_core.dylib" \
  --language swift \
  --out-dir "$GENERATED"
cd "$ROOT"

# The xcframework's Headers dir needs `module.modulemap` for SwiftPM to
# expose the FFI declarations as a clang module the bindings import.
cp "$GENERATED/pinomad_coreFFI.h" "$HEADERS/"
cp "$GENERATED/pinomad_coreFFI.modulemap" "$HEADERS/module.modulemap"

xcodebuild -create-xcframework \
  -library "$ROOT/target/aarch64-apple-ios/release/libpinomad_core.a" -headers "$HEADERS" \
  -library "$ROOT/target/aarch64-apple-ios-sim/release/libpinomad_core.a" -headers "$HEADERS" \
  -output "$XCFW"

echo "Wrote $XCFW and $GENERATED"
