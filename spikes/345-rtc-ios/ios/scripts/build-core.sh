#!/bin/bash
# Build the spike static library for device + arm64 simulator and generate
# the UniFFI Swift bindings (same shape as apps/ios/scripts/build-core.sh).
set -euo pipefail

HERE="$(cd "$(dirname "$0")/../.." && pwd)"
GENERATED="$HERE/ios/RTCSpike/Generated"
HEADERS="$HERE/ios/Vendor/ffi-headers"
XCFW="$HERE/ios/Vendor/RTCSpikeCore.xcframework"

cd "$HERE"
export IPHONEOS_DEPLOYMENT_TARGET=18.0

cargo rustc -p rtc-spike-core --lib --features ffi --crate-type staticlib --release \
  --target aarch64-apple-ios
cargo rustc -p rtc-spike-core --lib --features ffi --crate-type staticlib --release \
  --target aarch64-apple-ios-sim
cargo rustc -p rtc-spike-core --lib --features ffi --crate-type cdylib

rm -rf "$GENERATED" "$HEADERS" "$XCFW"
mkdir -p "$GENERATED" "$HEADERS"

cargo run -p rtc-spike-uniffi-bindgen --release -- generate \
  --library "$HERE/target/debug/librtc_spike_core.dylib" \
  --language swift --out-dir "$GENERATED"

cp "$GENERATED/rtc_spike_coreFFI.h" "$HEADERS/"
cp "$GENERATED/rtc_spike_coreFFI.modulemap" "$HEADERS/module.modulemap"

xcodebuild -create-xcframework \
  -library "$HERE/target/aarch64-apple-ios/release/librtc_spike_core.a" -headers "$HEADERS" \
  -library "$HERE/target/aarch64-apple-ios-sim/release/librtc_spike_core.a" -headers "$HEADERS" \
  -output "$XCFW"

echo "Wrote $XCFW and $GENERATED"
