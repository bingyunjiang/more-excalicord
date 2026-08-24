import AppKit
import Foundation

final class AgentController: NSObject, NSApplicationDelegate {
  private let engine = CaptureEngine()
  private let sessionToken = UUID().uuidString
  private lazy var server = HTTPServer { [weak self] request in
    guard let self else {
      return HTTPResponse.json(
        CommandResponse(
          ok: false,
          state: "error",
          message: "Capture agent is shutting down",
          outputPath: nil
        ),
        status: 500
      )
    }
    return await self.handle(request)
  }

  func start(background: Bool) throws {
    if background {
      recoverDesktopIconsAfterInterruptedSession()
      try server.start(port: 5002)
    } else {
      let secondaryLaunch = isAgentAlreadyRunning()
      if !secondaryLaunch {
        recoverDesktopIconsAfterInterruptedSession()
        try server.start(port: 5002)
      }
      DispatchQueue.main.async { [weak self] in
        self?.showManualLaunchDialog(terminateAfterDialog: secondaryLaunch)
      }
    }
  }

  private func handle(_ request: HTTPRequest) async -> HTTPResponse {
    if request.method == "OPTIONS" {
      return HTTPResponse(
        status: 204,
        contentType: "text/plain; charset=utf-8",
        body: Data(),
        extraHeaders: [:]
      )
    }

    if request.path != "/v1/health" &&
       request.headers["x-excalicord-token"] != sessionToken {
      return .json(
        CommandResponse(
          ok: false,
          state: "error",
          message: "Invalid local session token",
          outputPath: nil
        ),
        status: 403
      )
    }

    do {
      switch (request.method, request.path) {
      case ("GET", "/v1/health"):
        return .json(engine.health(token: sessionToken))
      case ("GET", "/v1/sources"):
        return .json(try await engine.listSources())
      case ("GET", "/v1/status"):
        return .json(engine.status())
      case ("GET", "/v1/save-folder"):
        return .json(engine.saveFolderResponse())
      case ("GET", "/v1/project-folder"):
        return .json(engine.projectFolderResponse())
      case ("GET", "/v1/desktop-icons"):
        return .json(engine.desktopIconsStatus())
      case ("POST", "/v1/save-folder/choose"):
        guard let url = try await chooseSaveFolder() else {
          return .json(FolderSelectionCancelledResponse(ok: false, cancelled: true))
        }
        return .json(try engine.setSaveFolder(url))
      case ("POST", "/v1/project-folder/choose"):
        guard let url = try await chooseSaveFolder() else {
          return .json(FolderSelectionCancelledResponse(ok: false, cancelled: true))
        }
        return .json(try engine.setSaveFolder(url))
      case ("POST", "/v1/save-folder/open"):
        let url = engine.saveFolderURL()
        try FileManager.default.createDirectory(
          at: url,
          withIntermediateDirectories: true
        )
        await revealInFinder(url)
        return .json(engine.saveFolderResponse())
      case ("POST", "/v1/project-folder/open"):
        let url = engine.projectFolderURL()
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        await revealInFinder(url)
        return .json(engine.projectFolderResponse())
      case ("POST", "/v1/desktop-icons/restore"):
        try engine.restoreDesktopIconsIfNeeded()
        return .json(engine.desktopIconsStatus())
      case ("POST", "/v1/project-file"):
        let payload = try JSONDecoder().decode(ProjectFileRequest.self, from: request.body)
        guard let content = payload.content else { throw AgentError.badRequest("Project file content is required") }
        return .json(try engine.writeProjectFile(path: payload.path, content: content))
      case ("POST", "/v1/project-file/read"):
        let payload = try JSONDecoder().decode(ProjectFileRequest.self, from: request.body)
        let content = try engine.readProjectFile(path: payload.path)
        return .json(ProjectFileReadResponse(ok: true, found: content != nil, path: payload.path, content: content))
      case ("POST", "/v1/project-file/delete"):
        let payload = try JSONDecoder().decode(ProjectFileRequest.self, from: request.body)
        return .json(try engine.deleteProjectFile(path: payload.path))
      case ("POST", "/v1/browser-recording"):
        let saved = try engine.saveExternalRecording(
          data: request.body,
          fileName: request.headers["x-excalicord-file-name"]
        )
        return .json(saved)
      case ("POST", "/v1/start"):
        let start = try JSONDecoder().decode(CaptureStartRequest.self, from: request.body)
        let url = try await engine.start(start)
        return .json(
          CommandResponse(
            ok: true,
            state: "recording",
            message: "Desktop recording started",
            outputPath: url.path
          )
        )
      case ("POST", "/v1/pause"):
        try engine.pause()
        return .json(
          CommandResponse(
            ok: true,
            state: "paused",
            message: nil,
            outputPath: engine.status().outputPath
          )
        )
      case ("POST", "/v1/resume"):
        try engine.resume()
        return .json(
          CommandResponse(
            ok: true,
            state: "recording",
            message: nil,
            outputPath: engine.status().outputPath
          )
        )
      case ("POST", "/v1/stop"):
        let url = try await engine.stop()
        return .json(
          CommandResponse(
            ok: true,
            state: "idle",
            message: "Recording saved",
            outputPath: url.path
          )
        )
      case ("GET", "/v1/recording"):
        let (url, data) = try engine.recordingData()
        return HTTPResponse(
          status: 200,
          contentType: "video/mp4",
          body: data,
          extraHeaders: [
            "Content-Disposition": "attachment; filename=\"\(url.lastPathComponent)\"",
          ]
        )
      case ("POST", "/v1/recording/open"):
        let url = try engine.recordingURL()
        NSWorkspace.shared.open(url)
        return .json(
          CommandResponse(
            ok: true,
            state: engine.status().state,
            message: "Recording opened",
            outputPath: url.path
          )
        )
      default:
        return .json(
          CommandResponse(
            ok: false,
            state: "error",
            message: "Endpoint not found",
            outputPath: nil
          ),
          status: 404
        )
      }
    } catch {
      let status: Int
      if error is DecodingError || error is AgentError { status = 400 }
      else { status = 500 }
      return .json(
        CommandResponse(
          ok: false,
          state: engine.status().state,
          message: error.localizedDescription,
          outputPath: engine.status().outputPath
        ),
        status: status
      )
    }
  }

  private func isAgentAlreadyRunning() -> Bool {
    guard let url = URL(string: "http://127.0.0.1:5002/v1/health") else {
      return false
    }
    let semaphore = DispatchSemaphore(value: 0)
    var available = false
    var request = URLRequest(url: url)
    request.timeoutInterval = 0.6
    URLSession.shared.dataTask(with: request) { _, response, _ in
      available = (response as? HTTPURLResponse)?.statusCode == 200
      semaphore.signal()
    }.resume()
    _ = semaphore.wait(timeout: .now() + 0.8)
    return available
  }

  func applicationWillTerminate(_ notification: Notification) {
    try? engine.restoreDesktopIconsIfNeeded()
  }

  private func recoverDesktopIconsAfterInterruptedSession() {
    do {
      try engine.restoreDesktopIconsIfNeeded()
    } catch {
      fputs("Capture Agent could not restore desktop icons: \(error)\n", stderr)
    }
  }

  private func chooseSaveFolder() async throws -> URL? {
    let initialDirectory = engine.saveFolderURL()
    return try await withCheckedThrowingContinuation { continuation in
      DispatchQueue.main.async {
        NSApp.activate(ignoringOtherApps: true)
        let panel = NSOpenPanel()
        panel.title = "选择 more-excalicord 项目文件夹"
        panel.message = "项目清单、白板、字幕和录制文件都会保存在这里。"
        panel.prompt = "选择项目文件夹"
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.directoryURL = initialDirectory
        if panel.runModal() == .OK, let url = panel.url {
          continuation.resume(returning: url)
        } else {
          continuation.resume(returning: nil)
        }
      }
    }
  }

  private func revealInFinder(_ url: URL) async {
    await MainActor.run {
      NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: url.path)
      activateFinder()
    }
    activateFinderByScript()
    try? await Task.sleep(nanoseconds: 180_000_000)
    await MainActor.run {
      activateFinder()
    }
    activateFinderByScript()
  }

  private func activateFinder() {
    if let finder = NSRunningApplication.runningApplications(
      withBundleIdentifier: "com.apple.finder"
    ).first {
      finder.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
      return
    }
    NSWorkspace.shared.openApplication(
      at: URL(fileURLWithPath: "/System/Library/CoreServices/Finder.app"),
      configuration: NSWorkspace.OpenConfiguration()
    )
  }

  private func activateFinderByScript() {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
    process.arguments = ["-e", "tell application \"Finder\" to activate"]
    try? process.run()
  }

  private func showManualLaunchDialog(terminateAfterDialog: Bool) {
    NSApp.activate(ignoringOtherApps: true)
    let alert = NSAlert()
    alert.alertStyle = .informational
    alert.messageText = "Excalicord Capture"
    alert.informativeText = "这是网页 more-excalicord 的后台组件。请在浏览器中的 more-excalicord 里开始或停止录制。"
    alert.addButton(withTitle: "打开 more-excalicord")
    alert.addButton(withTitle: "继续后台运行")
    alert.addButton(withTitle: "卸载后台组件")
    switch alert.runModal() {
    case .alertFirstButtonReturn:
      NSWorkspace.shared.open(URL(string: "http://localhost:5001/")!)
      if terminateAfterDialog { NSApp.terminate(nil) }
    case .alertThirdButtonReturn:
      uninstallSelf()
    default:
      if terminateAfterDialog { NSApp.terminate(nil) }
    }
  }

  private func uninstallSelf() {
    let home = FileManager.default.homeDirectoryForCurrentUser
    let plist = home
      .appendingPathComponent("Library/LaunchAgents")
      .appendingPathComponent("com.excalicord.capture-agent.plist")
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    process.arguments = ["bootout", "gui/\(getuid())", plist.path]
    try? process.run()
    process.waitUntilExit()
    try? FileManager.default.removeItem(at: plist)

    let bundleURL = Bundle.main.bundleURL
    if bundleURL.pathExtension == "app" {
      var trashedURL: NSURL?
      do {
        try FileManager.default.trashItem(
          at: bundleURL,
          resultingItemURL: &trashedURL
        )
      } catch {
        let alert = NSAlert(error: error)
        alert.runModal()
        return
      }
    }
    NSApp.terminate(nil)
  }
}
