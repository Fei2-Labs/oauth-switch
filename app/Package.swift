// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "OAuthSwitch",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "OAuthSwitch",
            path: "OAuthSwitch",
            resources: [.process("Resources")]
        ),
        .testTarget(
            name: "OAuthSwitchTests",
            dependencies: ["OAuthSwitch"],
            path: "Tests/OAuthSwitchTests",
            resources: [.copy("Fixtures")]
        ),
    ]
)
