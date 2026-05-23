// swift-tools-version:5.9
// Swift sidecar for macos-mcp. One CLI executable; the Node MCP layer
// spawns it and talks newline-delimited JSON-RPC over stdin/stdout.

import PackageDescription

let package = Package(
    name: "macos-mcp-helper",
    platforms: [.macOS(.v14)],  // SCScreenshotManager.captureImage requires macOS 14.
    targets: [
        .executableTarget(
            name: "MacosMcpHelper",
            path: "Sources/MacosMcpHelper"
        ),
    ]
)
