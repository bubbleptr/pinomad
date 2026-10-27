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

# aws-lc-sys (through rcgen -> aws-lc-rs) compiles C with the host SDK by
# default, which stamps objects as iOS 27 even though the app targets 26.
# Read the single deployment target from the Xcode project so the archive
# and the app cannot drift, then pass it to both cargo/cc and CMake.
DEPLOYMENT_TARGET="${IPHONEOS_DEPLOYMENT_TARGET:-$(
  sed -n 's/^[[:space:]]*IPHONEOS_DEPLOYMENT_TARGET = \(.*\);/\1/p' \
    "$ROOT/apps/ios/Pinomad.xcodeproj/project.pbxproj" | head -1
)}"
: "${DEPLOYMENT_TARGET:?could not read IPHONEOS_DEPLOYMENT_TARGET from the Xcode project}"

# Device and simulator slices, release. staticlib keeps the Swift side
# free of dylib embedding; --crate-type overrides the rlib default. The ffi
# feature also pulls in pinomad-rtc, so the RTC engine and the protocol core
# ship as one archive and one xcframework (no second Rust staticlib).
build_slice() {
  local target="$1" sysroot="$2" min_flag="$3"
  local cflags="CFLAGS_${target//-/_}"
  env \
    IPHONEOS_DEPLOYMENT_TARGET="$DEPLOYMENT_TARGET" \
    CMAKE_OSX_DEPLOYMENT_TARGET="$DEPLOYMENT_TARGET" \
    CMAKE_OSX_SYSROOT="$sysroot" \
    CMAKE_OSX_ARCHITECTURES="arm64" \
    "$cflags=$min_flag" \
    cargo rustc -p pinomad-core --features ffi --crate-type staticlib --release \
      --target "$target"
}

build_slice aarch64-apple-ios iphoneos "-mios-version-min=$DEPLOYMENT_TARGET"
build_slice aarch64-apple-ios-sim iphonesimulator "-mios-simulator-version-min=$DEPLOYMENT_TARGET"

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
