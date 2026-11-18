import AppKit
import SwiftUI

extension Notification.Name {
    static let miniOpenMemoryWindow = Notification.Name("lingoweave.open-memory-window")
}

/// A separate, normally layered window keeps the charts out of the small study panel.
@MainActor
final class MiniMemoryWindowController: NSWindowController, NSWindowDelegate {
    init(study: MiniStudyClient = MiniStudyClient()) {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1120, height: 780),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "记忆曲线 · 语织"
        window.contentMinSize = NSSize(width: 900, height: 640)
        window.isReleasedWhenClosed = false
        window.level = .normal
        window.collectionBehavior = [.fullScreenPrimary]
        window.contentView = NSHostingView(rootView: MiniMemoryView(study: study))
        super.init(window: window)
        window.delegate = self
        window.setFrameAutosaveName("mini-memory-window")
        if let screen = NSScreen.main, !screen.visibleFrame.contains(window.frame) {
            let frame = window.frame
            let visible = screen.visibleFrame
            window.setFrame(NSRect(x: visible.midX - min(frame.width, visible.width) / 2,
                                   y: visible.midY - min(frame.height, visible.height) / 2,
                                   width: min(frame.width, visible.width),
                                   height: min(frame.height, visible.height)), display: false)
        }
    }

    required init?(coder: NSCoder) { nil }

    func present() {
        if window?.isMiniaturized == true { window?.deminiaturize(nil) }
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        NotificationCenter.default.post(name: Notification.Name("miniMemoryWindowPresented"), object: nil)
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        return false
    }
}
