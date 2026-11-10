// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "LingoWeaveMini",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "LingoWeaveMini", targets: ["LingoWeaveMini"])],
    targets: [.executableTarget(name: "LingoWeaveMini")]
)
