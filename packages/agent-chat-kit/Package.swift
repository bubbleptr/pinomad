// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "AgentChatKit",
    platforms: [.iOS(.v26), .macOS(.v26)],
    products: [
        .library(name: "AgentChatCore", targets: ["AgentChatCore"]),
    ],
    dependencies: [
        .package(url: "https://github.com/swiftlang/swift-markdown.git", exact: "0.9.0"),
    ],
    targets: [
        .target(
            name: "AgentChatCore",
            dependencies: [.product(name: "Markdown", package: "swift-markdown")]
        ),
        .testTarget(name: "AgentChatCoreTests", dependencies: ["AgentChatCore"]),
    ]
)
