@preconcurrency import AVFoundation
import AppKit
import CoreImage
import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

final class CaptureEngine: NSObject {
  private let saveFolderDefaultsKey = "ExcalicordCaptureSaveFolderPath"
  private let maxProjectAssetBytes = 128 * 1024 * 1024
  private let desktopIcons = DesktopIconController()
  private let ringLightOverlay = RingLightOverlayController()

  enum State: String {
    case idle
    case recording
    case paused
    case stopping
    case failed
  }

  private let screenQueue = DispatchQueue(label: "excalicord.capture.screen")
  private let cameraQueue = DispatchQueue(label: "excalicord.capture.camera")
  private let audioQueue = DispatchQueue(label: "excalicord.capture.audio")
  private let writerLock = NSLock()
  private let cameraLock = NSLock()
  private let ciContext = CIContext(options: [.cacheIntermediates: false])

  private var state: State = .idle
  private var stateStartedAt: Date?
  private var lastError: String?
  private var stream: SCStream?
  private var cameraSession: AVCaptureSession?
  private var latestCameraBuffer: CVPixelBuffer?

  private var writer: AVAssetWriter?
  private var videoInput: AVAssetWriterInput?
  private var audioInput: AVAssetWriterInput?
  private var pixelAdaptor: AVAssetWriterInputPixelBufferAdaptor?
  private var writerSessionStarted = false
  private var lastVideoPTS: CMTime = .invalid
  private var timeOffset: CMTime = .zero
  private var resumePending = false
  private var outputWidth = 1920
  private var outputHeight = 1080
  private var outputURL: URL?
  private var lastRecordingURL: URL?
  private var screenCaptureOperational = false

  private var cameraEnabled = false
  private var microphoneEnabled = true
  private var cameraX = 0.84
  private var cameraY = 0.78
  private var cameraSize = 0.26
  private var cameraMirrored = true
  private var smoothing = 0.0
  private var whitening = 0.0
  private var lightIntensity = 0.0
  private var screenLightEnabled = false
  private var screenLightIntensity = 0.85

  func health(token: String) -> HealthResponse {
    writerLock.lock()
    defer { writerLock.unlock() }
    return HealthResponse(
      ok: true,
      protocolVersion: 1,
      platform: "macos",
      state: state.rawValue,
      capabilities: [
        "display",
        "window",
        "camera-overlay",
        "microphone",
        "h264-mp4",
        "pause-resume",
        "save-folder",
        "project-folder",
        "project-files",
        "desktop-icons",
        "screen-light",
      ],
      permissions: [
        // On newer macOS releases the legacy CoreGraphics preflight can lag
        // behind ScreenCaptureKit's permission state. A successful
        // SCShareableContent request is the authoritative runtime signal.
        "screen": CGPreflightScreenCaptureAccess() || screenCaptureOperational,
        "camera": AVCaptureDevice.authorizationStatus(for: .video) == .authorized,
        "microphone": AVCaptureDevice.authorizationStatus(for: .audio) == .authorized,
      ],
      token: token
    )
  }

  func listSources() async throws -> SourcesResponse {
    let content = try await shareableContent()
    let displays = content.displays.map {
      CaptureSource(
        id: String($0.displayID),
        type: "display",
        name: "显示器 \($0.displayID)",
        width: $0.width,
        height: $0.height,
        application: nil,
        thumbnail: thumbnailForDisplay($0.displayID)
      )
    }
    let windows = content.windows.compactMap { window -> CaptureSource? in
      let title = window.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
      let application = window.owningApplication?.applicationName ?? ""
      guard window.frame.width >= 160,
            window.frame.height >= 140,
            shouldExposeWindowSource(title: title, application: application, frame: window.frame)
      else { return nil }
      return CaptureSource(
        id: String(window.windowID),
        type: "window",
        name: title.isEmpty ? "窗口 \(window.windowID)" : title,
        width: Int(window.frame.width),
        height: Int(window.frame.height),
        application: application.isEmpty ? nil : application,
        thumbnail: thumbnailForWindow(window.windowID)
      )
    }
    .sorted {
      ($0.application ?? "") + $0.name < ($1.application ?? "") + $1.name
    }
    return SourcesResponse(displays: displays, windows: windows)
  }

  private func shouldExposeWindowSource(
    title: String,
    application: String,
    frame: CGRect
  ) -> Bool {
    if title.isEmpty { return false }
    let haystack = "\(application) \(title)"
    let suppressedPatterns = [
      "AccessibilityVisualsAgent",
      "Open and Save Panel Service",
      "Save Panel",
      "Open Panel",
      "自动填充",
      "Autofill",
      "Notification Center",
      "通知中心",
      "Control Center",
      "控制中心",
      "Dock",
      "程序坞",
      "Wallpaper",
      "聚焦",
      "Spotlight",
      "loginwindow",
      "Display \\d+ Backstop",
      "Ring Light Helper",
      "Excalicord Capture",
      "ChatGPT Computer Use",
      "Enable ChatGPT with Messages Permissions",
      "SafariPlatformSupport\\.Helper",
      "输入法",
      "搜狗输入法",
      "NacAssUIWindow",
    ]
    if matchesAny(haystack, patterns: suppressedPatterns) { return false }

    if isGenericWindowTitle(title) {
      return false
    }
    return true
  }

  private func isGenericWindowTitle(_ title: String) -> Bool {
    let normalized = title.trimmingCharacters(in: .whitespacesAndNewlines)
    for prefix in ["窗口", "Window"] {
      guard normalized.localizedCaseInsensitiveCompare(prefix) != .orderedSame else {
        return true
      }
      if normalized.lowercased().hasPrefix(prefix.lowercased()) {
        let suffix = normalized.dropFirst(prefix.count)
          .trimmingCharacters(in: .whitespacesAndNewlines)
        if !suffix.isEmpty, suffix.allSatisfy({ $0.isNumber }) {
          return true
        }
      }
    }
    return false
  }

  private func matchesAny(_ value: String, patterns: [String]) -> Bool {
    patterns.contains { matches(value, pattern: $0) }
  }

  private func matches(_ value: String, pattern: String) -> Bool {
    value.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil
  }

  func defaultSaveFolderURL() -> URL {
    FileManager.default.urls(for: .moviesDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("Excalicord", isDirectory: true)
  }

  func saveFolderURL() -> URL {
    if let path = UserDefaults.standard.string(forKey: saveFolderDefaultsKey),
       !path.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      return URL(fileURLWithPath: path, isDirectory: true).standardizedFileURL
    }
    return defaultSaveFolderURL()
  }

  func projectFolderURL() -> URL { saveFolderURL() }

  func setScreenLight(_ request: ScreenLightRequest) -> ScreenLightResponse {
    screenLightEnabled = request.enabled
    screenLightIntensity = clamp(request.intensity ?? screenLightIntensity, 0, 1)
    applyScreenLightPreference()
    return ScreenLightResponse(
      ok: true,
      enabled: screenLightEnabled,
      intensity: screenLightIntensity
    )
  }

  private func applyScreenLightPreference() {
    if screenLightEnabled, screenLightIntensity > 0 {
      ringLightOverlay.show(displayID: nil, sourceFrame: nil, intensity: screenLightIntensity)
    } else {
      ringLightOverlay.hide()
    }
  }

  private func recordingsFolderURL() -> URL {
    projectFolderURL().appendingPathComponent("recordings", isDirectory: true)
  }

  private func ensureProjectFolderStructure() throws {
    try FileManager.default.createDirectory(at: projectFolderURL(), withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: recordingsFolderURL(), withIntermediateDirectories: true)
  }

  private func projectAssetURL(_ path: String) throws -> URL {
    let allowed = [
      "project.excalicord.json",
      "scene.excalidraw",
      "text/transcript.raw.json",
      "text/transcript.corrected.json",
      "text/transcript.corrections.json",
      "text/subtitles.srt",
      "text/subtitles.vtt",
    ]
    let components = path.split(separator: "/", omittingEmptySubsequences: true)
    let sessionAsset = components.count == 3
      && components[0] == "recordings"
      && (components[2] == "session.json" || components[2] == "events.json")
      && isSafeSessionId(String(components[1]))
    guard (allowed.contains(path) || sessionAsset), !path.hasPrefix("/"),
          !path.contains("\\"), !path.contains("..") else {
      throw AgentError.badRequest("Unsupported project asset path")
    }
    let root = projectFolderURL().resolvingSymlinksInPath().standardizedFileURL
    let target = root.appendingPathComponent(path, isDirectory: false).resolvingSymlinksInPath().standardizedFileURL
    guard target.path.hasPrefix(root.path + "/") else {
      throw AgentError.badRequest("Project asset escapes the selected project folder")
    }
    return target
  }

  func projectFolderResponse() -> SaveFolderResponse { saveFolderResponse() }

  func writeProjectFile(path: String, content: String) throws -> ProjectFileResponse {
    try ensureProjectFolderStructure()
    let url = try projectAssetURL(path)
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    let data = Data(content.utf8)
    guard data.count <= maxProjectAssetBytes else {
      throw AgentError.badRequest("Project asset exceeds the 128 MB limit")
    }
    try data.write(to: url, options: [.atomic])
    return ProjectFileResponse(ok: true, path: path, bytes: data.count)
  }

  func readProjectFile(path: String) throws -> String? {
    let url = try projectAssetURL(path)
    guard FileManager.default.fileExists(atPath: url.path) else {
      return nil
    }
    let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
    if let size = attributes[.size] as? NSNumber, size.intValue > maxProjectAssetBytes {
      throw AgentError.badRequest("Project asset exceeds the 128 MB limit")
    }
    guard let content = try? String(contentsOf: url, encoding: .utf8) else {
      throw AgentError.badRequest("Project asset is not valid UTF-8")
    }
    return content
  }

  func deleteProjectFile(path: String) throws -> ProjectFileResponse {
    let url = try projectAssetURL(path)
    guard FileManager.default.fileExists(atPath: url.path) else {
      return ProjectFileResponse(ok: true, path: path, bytes: 0)
    }
    try FileManager.default.removeItem(at: url)
    return ProjectFileResponse(ok: true, path: path, bytes: 0)
  }

  func saveFolderResponse() -> SaveFolderResponse {
    let url = saveFolderURL()
    return SaveFolderResponse(
      ok: true,
      path: url.path,
      isDefault: url.standardizedFileURL.path == defaultSaveFolderURL().standardizedFileURL.path
    )
  }

  func setSaveFolder(_ url: URL) throws -> SaveFolderResponse {
    let directory = url.standardizedFileURL
    var isDirectory: ObjCBool = false
    if !FileManager.default.fileExists(atPath: directory.path, isDirectory: &isDirectory) {
      try FileManager.default.createDirectory(
        at: directory,
        withIntermediateDirectories: true
      )
      isDirectory = true
    }
    guard isDirectory.boolValue else {
      throw AgentError.badRequest("Selected path is not a folder")
    }
    guard FileManager.default.isWritableFile(atPath: directory.path) else {
      throw AgentError.badRequest("Selected folder is not writable")
    }
    UserDefaults.standard.set(directory.path, forKey: saveFolderDefaultsKey)
    try ensureProjectFolderStructure()
    return saveFolderResponse()
  }

  private func thumbnailForDisplay(_ displayID: CGDirectDisplayID) -> String? {
    guard let image = CGDisplayCreateImage(displayID) else { return nil }
    return pngDataURL(from: image, maxWidth: 240, maxHeight: 150)
  }

  private func thumbnailForWindow(_ windowID: CGWindowID) -> String? {
    guard let image = CGWindowListCreateImage(
      .null,
      .optionIncludingWindow,
      windowID,
      [.bestResolution, .nominalResolution, .boundsIgnoreFraming]
    ) else { return nil }
    return pngDataURL(from: image, maxWidth: 240, maxHeight: 150)
  }

  private func pngDataURL(from image: CGImage, maxWidth: Int, maxHeight: Int) -> String? {
    let sourceWidth = image.width
    let sourceHeight = image.height
    guard sourceWidth > 0, sourceHeight > 0 else { return nil }
    let scale = min(
      1.0,
      Double(maxWidth) / Double(sourceWidth),
      Double(maxHeight) / Double(sourceHeight)
    )
    let outputWidth = max(1, Int(Double(sourceWidth) * scale))
    let outputHeight = max(1, Int(Double(sourceHeight) * scale))

    guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
          let context = CGContext(
            data: nil,
            width: outputWidth,
            height: outputHeight,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
          )
    else { return nil }

    context.interpolationQuality = .medium
    context.draw(image, in: CGRect(x: 0, y: 0, width: outputWidth, height: outputHeight))
    guard let scaled = context.makeImage() else { return nil }

    let data = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(
      data,
      UTType.png.identifier as CFString,
      1,
      nil
    ) else { return nil }
    CGImageDestinationAddImage(destination, scaled, nil)
    guard CGImageDestinationFinalize(destination) else { return nil }
    return "data:image/png;base64," + (data as Data).base64EncodedString()
  }

  func start(_ request: CaptureStartRequest) async throws -> URL {
    try beginStarting()

    do {
      let content = try await shareableContent()
      let filter: SCContentFilter
      let sourceWidth: Int
      let sourceHeight: Int
      var ringLightDisplayID: CGDirectDisplayID?
      var ringLightSourceFrame: CGRect?

      if request.sourceType == "window" {
        guard let id = CGWindowID(request.sourceId),
              let window = content.windows.first(where: { $0.windowID == id })
        else { throw AgentError.sourceNotFound }
        filter = SCContentFilter(desktopIndependentWindow: window)
        sourceWidth = max(2, Int(window.frame.width))
        sourceHeight = max(2, Int(window.frame.height))
        ringLightSourceFrame = window.frame
      } else {
        let requestedDisplay = CGDirectDisplayID(request.sourceId).flatMap { id in
          content.displays.first(where: { $0.displayID == id })
        }
        guard let display = requestedDisplay ?? content.displays.first else {
          throw AgentError.sourceNotFound
        }
        filter = SCContentFilter(display: display, excludingWindows: [])
        sourceWidth = max(2, display.width)
        sourceHeight = max(2, display.height)
        ringLightDisplayID = display.displayID
      }

      let dimensions = scaledDimensions(width: sourceWidth, height: sourceHeight)
      outputWidth = dimensions.width
      outputHeight = dimensions.height
      cameraEnabled = request.cameraEnabled ?? false
      microphoneEnabled = request.microphoneEnabled ?? true
      cameraX = clamp(request.cameraX ?? 0.84, 0.05, 0.95)
      cameraY = clamp(request.cameraY ?? 0.78, 0.05, 0.95)
      cameraSize = clamp(request.cameraSize ?? 0.26, 0.08, 0.50)
      cameraMirrored = request.cameraMirrored ?? true
      smoothing = clamp(request.smoothing ?? 0, 0, 1)
      whitening = clamp(request.whitening ?? 0, 0, 1)
      lightIntensity = clamp(request.lightIntensity ?? 0, 0, 1)
      screenLightEnabled = request.screenLightEnabled ?? screenLightEnabled
      screenLightIntensity = clamp(request.screenLightIntensity ?? screenLightIntensity, 0, 1)
      if screenLightEnabled, screenLightIntensity > 0 {
        ringLightOverlay.show(
          displayID: ringLightDisplayID,
          sourceFrame: ringLightSourceFrame,
          intensity: screenLightIntensity
        )
      } else {
        ringLightOverlay.hide()
      }

      let url = try makeOutputURL(sessionId: request.sessionId)
      try configureWriter(url: url, width: outputWidth, height: outputHeight)

      if cameraEnabled || microphoneEnabled {
        try await configureCameraAndMicrophone()
      }

      let configuration = SCStreamConfiguration()
      configuration.width = outputWidth
      configuration.height = outputHeight
      configuration.minimumFrameInterval = CMTime(value: 1, timescale: 30)
      configuration.queueDepth = 6
      configuration.pixelFormat = kCVPixelFormatType_32BGRA
      configuration.showsCursor = true
      configuration.capturesAudio = false

      let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
      try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: screenQueue)
      self.stream = stream
      let desktopIconsHidden = try desktopIcons.hideIfRequested(
        request.sourceType == "display" && request.hideDesktopIcons == true
      )
      if desktopIconsHidden {
        try await Task.sleep(nanoseconds: 250_000_000)
      }
      try await stream.startCapture()
      return url
    } catch {
      fail(error)
      throw error
    }
  }

  func pause() throws {
    writerLock.lock()
    defer { writerLock.unlock() }
    guard state == .recording else { throw AgentError.notRecording }
    state = .paused
  }

  func resume() throws {
    writerLock.lock()
    defer { writerLock.unlock() }
    guard state == .paused else { throw AgentError.notRecording }
    state = .recording
    resumePending = true
  }

  func stop() async throws -> URL {
    let activeStream = try beginStopping()

    if let activeStream {
      try? await activeStream.stopCapture()
    }
    stream = nil
    cameraSession?.stopRunning()
    cameraSession = nil

    let (activeWriter, url) = prepareWriterForFinishing()

    if let activeWriter {
      await withCheckedContinuation { continuation in
        activeWriter.finishWriting {
          continuation.resume()
        }
      }
      if activeWriter.status == .failed {
        let message = activeWriter.error?.localizedDescription ?? "MP4 writer failed"
        fail(AgentError.capture(message))
        throw AgentError.capture(message)
      }
    }

    completeStop(url: url)
    applyScreenLightPreference()
    try desktopIcons.restoreIfNeeded()
    guard let url else { throw AgentError.noRecording }
    return url
  }

  func desktopIconsStatus() -> DesktopIconsResponse { desktopIcons.status() }

  func restoreDesktopIconsIfNeeded() throws { try desktopIcons.restoreIfNeeded() }

  func status() -> StatusResponse {
    writerLock.lock()
    defer { writerLock.unlock() }
    return StatusResponse(
      ok: state != .failed,
      state: state.rawValue,
      seconds: stateStartedAt.map { Date().timeIntervalSince($0) } ?? 0,
      outputPath: (outputURL ?? lastRecordingURL)?.path,
      error: lastError
    )
  }

  func recordingData() throws -> (URL, Data) {
    let url = try recordingURL()
    return (url, try Data(contentsOf: url))
  }

  func recordingURL() throws -> URL {
    writerLock.lock()
    let url = lastRecordingURL
    writerLock.unlock()
    guard let url else { throw AgentError.noRecording }
    return url
  }

  func saveExternalRecording(data: Data, fileName: String?) throws -> SaveRecordingResponse {
    guard !data.isEmpty else {
      throw AgentError.badRequest("Recording payload is empty")
    }
    let (sessionId, requestedFileName) = try splitExternalRecordingName(fileName)
    let directory = sessionId.map {
      recordingsFolderURL().appendingPathComponent($0, isDirectory: true)
    } ?? recordingsFolderURL()
    try FileManager.default.createDirectory(
      at: directory,
      withIntermediateDirectories: true
    )
    let safeFileName = sanitizedRecordingFileName(requestedFileName)
    let url = directory.appendingPathComponent(safeFileName, isDirectory: false)
    let existed = FileManager.default.fileExists(atPath: url.path)
    try data.write(to: url, options: [.atomic])

    writerLock.lock()
    lastRecordingURL = url
    outputURL = url
    writerLock.unlock()

    return SaveRecordingResponse(
      ok: true,
      path: url.path,
      fileName: sessionId.map { "\($0)/\(safeFileName)" } ?? safeFileName,
      overwritten: existed
    )
  }

  private func splitExternalRecordingName(_ fileName: String?) throws -> (String?, String?) {
    let original = fileName ?? ""
    guard !original.contains("\\"), !original.contains("..") else {
      throw AgentError.badRequest("Invalid recording path")
    }
    let raw = original
    let components = raw.split(separator: "/", omittingEmptySubsequences: true)
    if components.count == 2 && isSafeSessionId(String(components[0])) {
      return (String(components[0]), String(components[1]))
    }
    if components.count > 1 {
      throw AgentError.badRequest("Invalid recording session path")
    }
    return (nil, fileName)
  }

  private func sanitizedRecordingFileName(_ fileName: String?) -> String {
    let fallback = "excalicord-\(timestampString()).mp4"
    guard let fileName else { return fallback }
    var clean = fileName.trimmingCharacters(in: .whitespacesAndNewlines)
    clean = clean.components(separatedBy: CharacterSet(charactersIn: "/:\\")).joined(separator: "-")
    clean = clean.replacingOccurrences(of: "..", with: "-")
    guard !clean.isEmpty else { return fallback }
    let allowedExtensions = ["mp4", "webm", "mov", "m4v"]
    let ext = (clean as NSString).pathExtension.lowercased()
    if !allowedExtensions.contains(ext) {
      clean += ".mp4"
    }
    return clean
  }

  private func scaledDimensions(width: Int, height: Int) -> (width: Int, height: Int) {
    let maximum = 3840.0
    let scale = min(1.0, maximum / Double(max(width, height)))
    let outputWidth = max(2, Int(Double(width) * scale) / 2 * 2)
    let outputHeight = max(2, Int(Double(height) * scale) / 2 * 2)
    return (outputWidth, outputHeight)
  }

  private func makeOutputURL(sessionId: String?) throws -> URL {
    if let sessionId, !isSafeSessionId(sessionId) {
      throw AgentError.badRequest("Invalid recording session id")
    }
    let directory = sessionId.map {
      recordingsFolderURL().appendingPathComponent($0, isDirectory: true)
    } ?? recordingsFolderURL()
    try FileManager.default.createDirectory(
      at: directory,
      withIntermediateDirectories: true
    )
    let url = directory.appendingPathComponent(
      "excalicord-\(timestampString()).mp4"
    )
    if FileManager.default.fileExists(atPath: url.path) {
      try FileManager.default.removeItem(at: url)
    }
    return url
  }

  private func isSafeSessionId(_ value: String) -> Bool {
    value.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$", options: .regularExpression) != nil
  }

  private func timestampString() -> String {
    let formatter = DateFormatter()
    formatter.dateFormat = "yyyyMMdd-HHmmss"
    return formatter.string(from: Date())
  }

  private func configureWriter(url: URL, width: Int, height: Int) throws {
    let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
    let videoSettings: [String: Any] = [
      AVVideoCodecKey: AVVideoCodecType.h264,
      AVVideoWidthKey: width,
      AVVideoHeightKey: height,
      AVVideoCompressionPropertiesKey: [
        AVVideoAverageBitRateKey: 10_000_000,
        AVVideoExpectedSourceFrameRateKey: 30,
        AVVideoMaxKeyFrameIntervalKey: 60,
      ],
    ]
    let videoInput = AVAssetWriterInput(
      mediaType: .video,
      outputSettings: videoSettings
    )
    videoInput.expectsMediaDataInRealTime = true
    guard writer.canAdd(videoInput) else {
      throw AgentError.capture("Cannot create H.264 video writer")
    }
    writer.add(videoInput)

    var audioInput: AVAssetWriterInput?
    if microphoneEnabled {
      let settings: [String: Any] = [
        AVFormatIDKey: kAudioFormatMPEG4AAC,
        AVSampleRateKey: 48_000,
        AVNumberOfChannelsKey: 1,
        AVEncoderBitRateKey: 128_000,
      ]
      let input = AVAssetWriterInput(mediaType: .audio, outputSettings: settings)
      input.expectsMediaDataInRealTime = true
      if writer.canAdd(input) {
        writer.add(input)
        audioInput = input
      }
    }

    let adaptor = AVAssetWriterInputPixelBufferAdaptor(
      assetWriterInput: videoInput,
      sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        kCVPixelBufferWidthKey as String: width,
        kCVPixelBufferHeightKey as String: height,
        kCVPixelBufferIOSurfacePropertiesKey as String: [:],
      ]
    )
    guard writer.startWriting() else {
      throw AgentError.capture(
        writer.error?.localizedDescription ?? "Cannot start MP4 writer"
      )
    }

    writerLock.lock()
    self.writer = writer
    self.videoInput = videoInput
    self.audioInput = audioInput
    self.pixelAdaptor = adaptor
    self.outputURL = url
    self.writerSessionStarted = false
    self.lastVideoPTS = .invalid
    self.timeOffset = .zero
    self.resumePending = false
    writerLock.unlock()
  }

  private func configureCameraAndMicrophone() async throws {
    if cameraEnabled {
      let granted = await requestAccess(for: .video)
      guard granted else { throw AgentError.capture("Camera permission was denied") }
    }
    if microphoneEnabled {
      let granted = await requestAccess(for: .audio)
      guard granted else { throw AgentError.capture("Microphone permission was denied") }
    }

    let session = AVCaptureSession()
    session.beginConfiguration()
    session.sessionPreset = .high

    if cameraEnabled,
       let device = AVCaptureDevice.default(for: .video) {
      let input = try AVCaptureDeviceInput(device: device)
      if session.canAddInput(input) { session.addInput(input) }
      let output = AVCaptureVideoDataOutput()
      output.alwaysDiscardsLateVideoFrames = true
      output.videoSettings = [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
      ]
      output.setSampleBufferDelegate(self, queue: cameraQueue)
      if session.canAddOutput(output) { session.addOutput(output) }
    }

    if microphoneEnabled,
       let device = AVCaptureDevice.default(for: .audio) {
      let input = try AVCaptureDeviceInput(device: device)
      if session.canAddInput(input) { session.addInput(input) }
      let output = AVCaptureAudioDataOutput()
      output.setSampleBufferDelegate(self, queue: audioQueue)
      if session.canAddOutput(output) { session.addOutput(output) }
    }

    session.commitConfiguration()
    cameraSession = session
    session.startRunning()
  }

  private func requestAccess(for mediaType: AVMediaType) async -> Bool {
    switch AVCaptureDevice.authorizationStatus(for: mediaType) {
    case .authorized: return true
    case .denied, .restricted: return false
    case .notDetermined:
      return await AVCaptureDevice.requestAccess(for: mediaType)
    @unknown default: return false
    }
  }

  private func shareableContent() async throws -> SCShareableContent {
    if !CGPreflightScreenCaptureAccess() {
      _ = await MainActor.run { CGRequestScreenCaptureAccess() }
    }

    do {
      let content = try await SCShareableContent.excludingDesktopWindows(
        false,
        onScreenWindowsOnly: false
      )
      writerLock.withLock {
        screenCaptureOperational = true
      }
      return content
    } catch {
      throw AgentError.capture(
        "请在系统设置 → 隐私与安全性 → 屏幕与系统音频录制中允许 Excalicord Capture，然后重新启动录制组件。系统返回：\(error.localizedDescription)"
      )
    }
  }

  private func compose(screenBuffer: CVPixelBuffer) -> CVPixelBuffer? {
    var output: CVPixelBuffer?
    let attributes: [CFString: Any] = [
      kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA,
      kCVPixelBufferWidthKey: outputWidth,
      kCVPixelBufferHeightKey: outputHeight,
      kCVPixelBufferIOSurfacePropertiesKey: [:],
    ]
    let result = CVPixelBufferCreate(
      kCFAllocatorDefault,
      outputWidth,
      outputHeight,
      kCVPixelFormatType_32BGRA,
      attributes as CFDictionary,
      &output
    )
    guard result == kCVReturnSuccess, let output else { return nil }

    let outputRect = CGRect(x: 0, y: 0, width: outputWidth, height: outputHeight)
    var image = CIImage(cvPixelBuffer: screenBuffer)
    let sx = CGFloat(outputWidth) / image.extent.width
    let sy = CGFloat(outputHeight) / image.extent.height
    image = image.transformed(by: CGAffineTransform(scaleX: sx, y: sy))

    cameraLock.lock()
    let cameraBuffer = latestCameraBuffer
    cameraLock.unlock()
    if cameraEnabled, let cameraBuffer {
      image = compositeCamera(cameraBuffer, over: image, outputRect: outputRect)
    }

    ciContext.render(
      image.cropped(to: outputRect),
      to: output,
      bounds: outputRect,
      colorSpace: CGColorSpaceCreateDeviceRGB()
    )
    return output
  }

  private func compositeCamera(
    _ buffer: CVPixelBuffer,
    over background: CIImage,
    outputRect: CGRect
  ) -> CIImage {
    var camera = CIImage(cvPixelBuffer: buffer)
    let square = min(camera.extent.width, camera.extent.height)
    let crop = CGRect(
      x: camera.extent.midX - square / 2,
      y: camera.extent.midY - square / 2,
      width: square,
      height: square
    )
    camera = camera.cropped(to: crop)
    if smoothing > 0,
       let filter = CIFilter(name: "CINoiseReduction") {
      filter.setValue(camera, forKey: kCIInputImageKey)
      filter.setValue(0.02 + smoothing * 0.08, forKey: "inputNoiseLevel")
      filter.setValue(0.40, forKey: "inputSharpness")
      camera = filter.outputImage ?? camera
    }
    if let controls = CIFilter(name: "CIColorControls") {
      controls.setValue(camera, forKey: kCIInputImageKey)
      controls.setValue(1 + whitening * 0.12, forKey: kCIInputSaturationKey)
      controls.setValue(lightIntensity * 0.20 + whitening * 0.10, forKey: kCIInputBrightnessKey)
      controls.setValue(1 + lightIntensity * 0.08, forKey: kCIInputContrastKey)
      camera = controls.outputImage ?? camera
    }

    let diameter = CGFloat(cameraSize) * min(outputRect.width, outputRect.height)
    let centerX = CGFloat(cameraX) * outputRect.width
    let centerY = (1 - CGFloat(cameraY)) * outputRect.height
    let target = CGRect(
      x: centerX - diameter / 2,
      y: centerY - diameter / 2,
      width: diameter,
      height: diameter
    )
    let scale = diameter / square
    // Use explicit coefficients so the crop-origin translation is scaled as
    // well. Chaining translatedBy/scaledBy leaves the translation in source
    // coordinates and can move the camera pixels outside the circular mask.
    camera = camera.transformed(by: CGAffineTransform(
      a: scale,
      b: 0,
      c: 0,
      d: scale,
      tx: -crop.minX * scale,
      ty: -crop.minY * scale
    ))
    if cameraMirrored {
      camera = camera.transformed(by: CGAffineTransform(
        a: -1,
        b: 0,
        c: 0,
        d: 1,
        tx: diameter,
        ty: 0
      ))
    }
    camera = camera.transformed(
      by: CGAffineTransform(translationX: target.minX, y: target.minY)
    )

    guard let maskFilter = CIFilter(name: "CIRoundedRectangleGenerator") else {
      return camera.composited(over: background)
    }
    maskFilter.setValue(CIVector(cgRect: target), forKey: "inputExtent")
    maskFilter.setValue(diameter / 2, forKey: "inputRadius")
    maskFilter.setValue(CIColor.white, forKey: "inputColor")
    guard let mask = maskFilter.outputImage,
          let blend = CIFilter(name: "CIBlendWithMask")
    else { return camera.composited(over: background) }
    blend.setValue(camera, forKey: kCIInputImageKey)
    blend.setValue(background, forKey: kCIInputBackgroundImageKey)
    blend.setValue(mask, forKey: kCIInputMaskImageKey)
    return blend.outputImage ?? background
  }

  private func fail(_ error: Error) {
    writerLock.lock()
    lastError = error.localizedDescription
    state = .failed
    writer?.cancelWriting()
    resetWriterState()
    writerLock.unlock()
    cameraSession?.stopRunning()
    cameraSession = nil
    stream = nil
    applyScreenLightPreference()
    do {
      try desktopIcons.restoreIfNeeded()
    } catch {
      writerLock.withLock {
        lastError = (lastError ?? "录制失败") + "；桌面图标恢复失败：" + error.localizedDescription
      }
    }
  }

  private func beginStarting() throws {
    writerLock.lock()
    defer { writerLock.unlock() }
    guard state == .idle || state == .failed else {
      throw AgentError.alreadyRecording
    }
    state = .recording
    stateStartedAt = Date()
    lastError = nil
  }

  private func beginStopping() throws -> SCStream? {
    writerLock.lock()
    defer { writerLock.unlock() }
    guard state == .recording || state == .paused else {
      throw AgentError.notRecording
    }
    state = .stopping
    return stream
  }

  private func prepareWriterForFinishing() -> (AVAssetWriter?, URL?) {
    writerLock.lock()
    defer { writerLock.unlock() }
    videoInput?.markAsFinished()
    audioInput?.markAsFinished()
    return (writer, outputURL)
  }

  private func completeStop(url: URL?) {
    writerLock.lock()
    defer { writerLock.unlock() }
    lastRecordingURL = url
    resetWriterState()
    state = .idle
    stateStartedAt = nil
  }

  private func resetWriterState() {
    writer = nil
    videoInput = nil
    audioInput = nil
    pixelAdaptor = nil
    outputURL = nil
    writerSessionStarted = false
    lastVideoPTS = .invalid
    timeOffset = .zero
    resumePending = false
  }

  private func clamp(_ value: Double, _ minimum: Double, _ maximum: Double) -> Double {
    min(maximum, max(minimum, value))
  }
}

extension CaptureEngine: SCStreamDelegate, SCStreamOutput {
  func stream(
    _ stream: SCStream,
    didStopWithError error: Error
  ) {
    fail(error)
  }

  func stream(
    _ stream: SCStream,
    didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
    of outputType: SCStreamOutputType
  ) {
    guard outputType == .screen,
          sampleBuffer.isValid,
          let screenBuffer = sampleBuffer.imageBuffer
    else { return }

    writerLock.lock()
    guard state == .recording,
          let writer,
          writer.status == .writing,
          let videoInput,
          videoInput.isReadyForMoreMediaData,
          let pixelAdaptor
    else {
      writerLock.unlock()
      return
    }

    let sourcePTS = sampleBuffer.presentationTimeStamp
    if resumePending, lastVideoPTS.isValid {
      let expectedFrame = CMTime(value: 1, timescale: 30)
      let gap = CMTimeSubtract(CMTimeSubtract(sourcePTS, lastVideoPTS), expectedFrame)
      if gap > .zero { timeOffset = CMTimeAdd(timeOffset, gap) }
      resumePending = false
    }
    let adjustedPTS = CMTimeSubtract(sourcePTS, timeOffset)
    if !writerSessionStarted {
      writer.startSession(atSourceTime: adjustedPTS)
      writerSessionStarted = true
    }
    lastVideoPTS = sourcePTS
    writerLock.unlock()

    guard let output = compose(screenBuffer: screenBuffer) else { return }
    writerLock.lock()
    if state == .recording, videoInput.isReadyForMoreMediaData {
      _ = pixelAdaptor.append(output, withPresentationTime: adjustedPTS)
    }
    writerLock.unlock()
  }
}

extension CaptureEngine:
  AVCaptureVideoDataOutputSampleBufferDelegate,
  AVCaptureAudioDataOutputSampleBufferDelegate
{
  func captureOutput(
    _ output: AVCaptureOutput,
    didOutput sampleBuffer: CMSampleBuffer,
    from connection: AVCaptureConnection
  ) {
    if output is AVCaptureVideoDataOutput {
      guard let buffer = sampleBuffer.imageBuffer else { return }
      cameraLock.lock()
      latestCameraBuffer = buffer
      cameraLock.unlock()
      return
    }

    guard output is AVCaptureAudioDataOutput else { return }
    writerLock.lock()
    guard state == .recording,
          writerSessionStarted,
          let input = audioInput,
          input.isReadyForMoreMediaData
    else {
      writerLock.unlock()
      return
    }
    _ = input.append(sampleBuffer)
    writerLock.unlock()
  }
}
