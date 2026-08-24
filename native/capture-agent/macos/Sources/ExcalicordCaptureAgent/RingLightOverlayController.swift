import AppKit
import CoreGraphics
import Foundation

final class RingLightOverlayController {
  private var panel: NSPanel?
  private var lightView: RingLightView?

  func show(
    displayID: CGDirectDisplayID?,
    sourceFrame: CGRect?,
    intensity: Double
  ) {
    runOnMain {
      let screen = self.targetScreen(displayID: displayID, sourceFrame: sourceFrame)
        ?? NSScreen.main
        ?? NSScreen.screens.first
      guard let screen else { return }

      let view = self.lightView ?? RingLightView(frame: screen.frame)
      view.frame = CGRect(origin: .zero, size: screen.frame.size)
      view.intensity = max(0, min(1, intensity))
      view.needsDisplay = true
      self.lightView = view

      let panel = self.panel ?? NSPanel(
        contentRect: screen.frame,
        styleMask: [.borderless, .nonactivatingPanel],
        backing: .buffered,
        defer: false,
        screen: screen
      )
      panel.setFrame(screen.frame, display: true)
      panel.contentView = view
      panel.isOpaque = false
      panel.backgroundColor = .clear
      panel.hasShadow = false
      panel.ignoresMouseEvents = true
      panel.hidesOnDeactivate = false
      panel.level = .screenSaver
      panel.collectionBehavior = [
        .canJoinAllSpaces,
        .fullScreenAuxiliary,
        .stationary,
        .ignoresCycle,
      ]
      panel.sharingType = .none
      self.panel = panel

      if !panel.isVisible {
        panel.alphaValue = 0
        panel.orderFrontRegardless()
      }
      NSAnimationContext.runAnimationGroup { context in
        context.duration = 0.42
        context.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        panel.animator().alphaValue = 1
      }
    }
  }

  func hide() {
    runOnMain {
      guard let panel = self.panel else { return }
      NSAnimationContext.runAnimationGroup({ context in
        context.duration = 0.28
        context.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        panel.animator().alphaValue = 0
      }, completionHandler: {
        panel.orderOut(nil)
      })
    }
  }

  private func runOnMain(_ work: @escaping () -> Void) {
    if Thread.isMainThread {
      work()
    } else {
      DispatchQueue.main.async(execute: work)
    }
  }

  private func targetScreen(
    displayID: CGDirectDisplayID?,
    sourceFrame: CGRect?
  ) -> NSScreen? {
    if let main = NSScreen.main {
      return main
    }

    if let displayID,
       let screen = NSScreen.screens.first(where: { screen in
         guard let value = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber
         else { return false }
         return value.uint32Value == displayID
       }) {
      return screen
    }

    if let sourceFrame {
      let center = CGPoint(x: sourceFrame.midX, y: sourceFrame.midY)
      if let screen = NSScreen.screens.first(where: { $0.frame.contains(center) }) {
        return screen
      }
    }

    return NSScreen.screens.first
  }
}

private final class RingLightView: NSView {
  var intensity: Double = 0.85

  override var isOpaque: Bool { false }

  override func draw(_ dirtyRect: NSRect) {
    super.draw(dirtyRect)
    guard let context = NSGraphicsContext.current?.cgContext else { return }

    let bounds = self.bounds
    let shortEdge = max(1, min(bounds.width, bounds.height))
    let band = min(max(shortEdge * 0.036, 28), 56)
    let cornerRadius = min(max(shortEdge * 0.08, 60), 112)
    let alpha = CGFloat(max(0, min(1, intensity)))

    context.saveGState()
    context.setBlendMode(.screen)

    // Keep the light close to the display edge. The first ring only softens the
    // boundary by a few pixels; the second is the visible, continuous light band.
    drawRoundedRing(
      context,
      bounds: bounds,
      inset: 5,
      width: band + 6,
      radius: cornerRadius,
      color: NSColor(calibratedRed: 1, green: 0.985, blue: 0.94, alpha: 0.18 * alpha)
    )
    drawRoundedRing(
      context,
      bounds: bounds,
      inset: 8,
      width: band,
      radius: cornerRadius - 3,
      color: NSColor(calibratedRed: 1, green: 0.995, blue: 0.98, alpha: alpha)
    )

    context.restoreGState()
  }

  private func drawRoundedRing(
    _ context: CGContext,
    bounds: CGRect,
    inset: CGFloat,
    width: CGFloat,
    radius: CGFloat,
    color: NSColor
  ) {
    let outerRect = bounds.insetBy(dx: inset, dy: inset)
    let innerInset = inset + width
    let innerRect = bounds.insetBy(dx: innerInset, dy: innerInset)
    guard outerRect.width > 0, outerRect.height > 0,
          innerRect.width > 0, innerRect.height > 0 else { return }

    let path = CGMutablePath()
    path.addRoundedRect(
      in: outerRect,
      cornerWidth: radius,
      cornerHeight: radius
    )
    path.addRoundedRect(
      in: innerRect,
      cornerWidth: max(8, radius - width),
      cornerHeight: max(8, radius - width)
    )
    context.addPath(path)
    context.setFillColor(color.cgColor)
    context.drawPath(using: .eoFill)
  }
}
