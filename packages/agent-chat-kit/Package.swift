// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "AgentChatKit",
    defaultLocalization: "en",
    platforms: [.iOS(.v26), .macOS(.v26)],
    products: [
        .library(name: "AgentChatCore", targets: ["AgentChatCore"]),
        .library(name: "AgentChatKit", targets: ["AgentChatKit"]),
    ],
    dependencies: [
        .package(url: "https://github.com/swiftlang/swift-markdown.git", exact: "0.9.0"),
        .package(url: "https://github.com/mgriebling/SwiftMath.git", exact: "1.7.3"),
    ],
    targets: [
        .target(
            name: "AgentChatCore",
            dependencies: [.product(name: "Markdown", package: "swift-markdown")]
        ),
        .target(
            name: "AgentChatKit",
            dependencies: ["AgentChatCore", .product(name: "SwiftMath", package: "SwiftMath")],
            resources: [.process("Resources")]
        ),
        .testTarget(name: "AgentChatCoreTests", dependencies: ["AgentChatCore"]),
    ]
)
