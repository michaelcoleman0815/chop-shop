// swift-tools-version: 5.9
// The engine plugin for iOS. Capacitor 8 adds it to an app's CapApp-SPM
// package by this file; the CLI names the package and its product
// CutalongEngine, after the npm package cutalong-engine.
//
// The frameworks are built by scripts/build.sh ios into ios/Frameworks,
// which is not committed (see README.md). Each is dynamic, so the LGPL parts
// can be replaced, and Xcode embeds and signs them in the app.
import PackageDescription

let ffmpeg = ["libavutil", "libswresample", "libswscale", "libavcodec", "libavformat", "libavfilter"]

let frameworks: [Target] =
    [.binaryTarget(name: "CutalongEngineCore", path: "ios/Frameworks/CutalongEngineCore.xcframework")]
    + ffmpeg.map { Target.binaryTarget(name: $0, path: "ios/Frameworks/\($0).xcframework") }

let pluginDependencies: [Target.Dependency] =
    [
        .product(name: "Capacitor", package: "capacitor-swift-pm"),
        .product(name: "Cordova", package: "capacitor-swift-pm"),
        .target(name: "CutalongEngineCore")
    ]
    + ffmpeg.map { Target.Dependency.target(name: $0) }

let package = Package(
    name: "CutalongEngine",
    platforms: [.iOS(.v15)],
    products: [
        .library(name: "CutalongEngine", targets: ["CutalongEnginePlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
    ],
    targets: frameworks + [
        .target(
            name: "CutalongEnginePlugin",
            dependencies: pluginDependencies,
            path: "ios/Sources/CutalongEnginePlugin",
            // What the engine does that Apple asks apps to say (see the file).
            resources: [.copy("PrivacyInfo.xcprivacy")],
            linkerSettings: [
                .linkedFramework("Photos"),
                .linkedFramework("PhotosUI"),
                .linkedFramework("UniformTypeIdentifiers"),
                .linkedFramework("VideoToolbox"),
                .linkedFramework("CoreMedia")
            ]
        )
    ]
)
