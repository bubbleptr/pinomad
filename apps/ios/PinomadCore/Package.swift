// swift-tools-version: 6.2
import PackageDescription

// ADR-0024 §11: the Rust core's xcframework (built by
// ../scripts/build-core.sh, gitignored) plus the generated UniFFI
// bindings and the platform layer that feeds it.
let package = Package(
    name: "PinomadCore",
    platforms: [.iOS(.v26)],
    products: [
        .library(name: "PinomadCore", targets: ["PinomadCore"])
    ],
    targets: [
        .binaryTarget(
            name: "PinomadCoreFFI",
            path: "Vendor/PinomadCoreFFI.xcframework"
        ),
        .target(
            name: "PinomadCore",
            dependencies: ["PinomadCoreFFI"],
            path: "Sources/PinomadCore"
        ),
        .testTarget(
            name: "PinomadCoreTests",
            dependencies: ["PinomadCore"],
            path: "Tests/PinomadCoreTests"
        ),
    ]
)
