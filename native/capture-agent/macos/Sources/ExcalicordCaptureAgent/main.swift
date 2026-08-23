import AppKit
import Foundation

let application = NSApplication.shared
application.setActivationPolicy(.accessory)

let controller = AgentController()
do {
  try controller.start(background: CommandLine.arguments.contains("--background"))
} catch {
  fputs("Excalicord Capture Agent failed to start: \(error)\n", stderr)
  exit(1)
}

application.run()
