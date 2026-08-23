// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "ExcalicordCaptureAgent",
  platforms: [.macOS(.v13)],
  products: [
    .executable(
      name: "ExcalicordCaptureAgent",
      targets: ["ExcalicordCaptureAgent"]
    ),
  ],
  targets: [
    .executableTarget(
      name: "ExcalicordCaptureAgent",
      path: "Sources/ExcalicordCaptureAgent"
    ),
  ],
  swiftLanguageVersions: [.v5]
)
