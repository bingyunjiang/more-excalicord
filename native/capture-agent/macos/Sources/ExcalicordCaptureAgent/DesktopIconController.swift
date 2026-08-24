import AppKit
import Foundation

final class DesktopIconController {
  private let lock = NSLock()
  private let pendingKey = "ExcalicordDesktopIconsRestorePending"
  private let originalExistsKey = "ExcalicordDesktopIconsOriginalExists"
  private let originalValueKey = "ExcalicordDesktopIconsOriginalValue"

  func status() -> DesktopIconsResponse {
    lock.lock()
    defer { lock.unlock() }
    return DesktopIconsResponse(
      ok: true,
      hidden: currentCreateDesktopValue() == false,
      managedByRecording: UserDefaults.standard.bool(forKey: pendingKey)
    )
  }

  @discardableResult
  func hideIfRequested(_ requested: Bool) throws -> Bool {
    guard requested else { return false }
    lock.lock()
    defer { lock.unlock() }

    if UserDefaults.standard.bool(forKey: pendingKey) {
      if currentCreateDesktopValue() != false {
        try setCreateDesktop(false)
        restartFinder()
      }
      return true
    }

    let original = readCreateDesktopPreference()
    UserDefaults.standard.set(true, forKey: originalExistsKey)
    if let original {
      UserDefaults.standard.set(original, forKey: originalValueKey)
    } else {
      UserDefaults.standard.set(false, forKey: originalExistsKey)
      UserDefaults.standard.removeObject(forKey: originalValueKey)
    }
    UserDefaults.standard.set(true, forKey: pendingKey)
    UserDefaults.standard.synchronize()

    do {
      try setCreateDesktop(false)
      restartFinder()
      return true
    } catch {
      clearRestoreSnapshot()
      throw error
    }
  }

  func restoreIfNeeded() throws {
    lock.lock()
    defer { lock.unlock() }
    guard UserDefaults.standard.bool(forKey: pendingKey) else { return }

    if UserDefaults.standard.bool(forKey: originalExistsKey) {
      try setCreateDesktop(UserDefaults.standard.bool(forKey: originalValueKey))
    } else {
      try deleteCreateDesktopPreference()
    }
    restartFinder()
    clearRestoreSnapshot()
  }

  private func readCreateDesktopPreference() -> Bool? {
    let result = runDefaults(["read", "com.apple.finder", "CreateDesktop"])
    guard result.status == 0 else { return nil }
    switch result.output.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
    case "1", "true", "yes": return true
    case "0", "false", "no": return false
    default: return nil
    }
  }

  private func currentCreateDesktopValue() -> Bool {
    readCreateDesktopPreference() ?? true
  }

  private func setCreateDesktop(_ enabled: Bool) throws {
    let result = runDefaults([
      "write", "com.apple.finder", "CreateDesktop", "-bool", enabled ? "true" : "false",
    ])
    guard result.status == 0 else {
      throw AgentError.capture("无法修改 Finder 桌面图标设置：\(result.output)")
    }
  }

  private func deleteCreateDesktopPreference() throws {
    let result = runDefaults(["delete", "com.apple.finder", "CreateDesktop"])
    guard result.status == 0 else {
      throw AgentError.capture("无法恢复 Finder 桌面图标默认设置：\(result.output)")
    }
  }

  private func runDefaults(_ arguments: [String]) -> (status: Int32, output: String) {
    let process = Process()
    let pipe = Pipe()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/defaults")
    process.arguments = arguments
    process.standardOutput = pipe
    process.standardError = pipe
    do {
      try process.run()
      process.waitUntilExit()
      let data = pipe.fileHandleForReading.readDataToEndOfFile()
      return (process.terminationStatus, String(data: data, encoding: .utf8) ?? "")
    } catch {
      return (-1, error.localizedDescription)
    }
  }

  private func restartFinder() {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/killall")
    process.arguments = ["Finder"]
    if (try? process.run()) != nil {
      process.waitUntilExit()
    }
    DispatchQueue.main.async {
      NSWorkspace.shared.openApplication(
        at: URL(fileURLWithPath: "/System/Library/CoreServices/Finder.app"),
        configuration: NSWorkspace.OpenConfiguration()
      )
    }
  }

  private func clearRestoreSnapshot() {
    UserDefaults.standard.removeObject(forKey: pendingKey)
    UserDefaults.standard.removeObject(forKey: originalExistsKey)
    UserDefaults.standard.removeObject(forKey: originalValueKey)
    UserDefaults.standard.synchronize()
  }
}
