// swift-tools-version: 6.2
import PackageDescription

// ADR-0024 §11: the Rust core's xcframework (built by
// ../scripts/build-core.sh, gitignored) plus the generated UniFFI
// bindings and the platform layer that feeds it.
let package = Package(
    name: "PinomadCore",
    platforms: [.iOS(.v26)],
    products: [
        .library(name: "PinomadCore", targets: ["PinomadCore"]),
        .library(name: "PinomadChat", targets: ["PinomadChat"])
    ],
    dependencies: [
        .package(path: "../../../packages/agent-chat-kit")
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
        // ChatEntry/CotView → AgentChatKit models. Model-only, no SwiftUI —
        // the app composes the kit's views off what this produces.
        .target(
            name: "PinomadChat",
            dependencies: [
                "PinomadCore",
                .product(name: "AgentChatCore", package: "agent-chat-kit"),
                .product(name: "AgentChatKit", package: "agent-chat-kit"),
            ],
            path: "Sources/PinomadChat"
        ),
        .testTarget(
            name: "PinomadCoreTests",
            dependencies: ["PinomadCore"],
            path: "Tests/PinomadCoreTests"
        ),
        .testTarget(
            name: "PinomadChatTests",
            dependencies: ["PinomadChat"],
            path: "Tests/PinomadChatTests"
        ),
    ]
)
