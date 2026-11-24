import AppKit
import SwiftUI

extension Notification.Name {
    static let miniOpenMemoryWindow = Notification.Name("lingoweave.open-memory-window")
    static let miniMemoryWindowPresented = Notification.Name("lingoweave.memory-window-presented")
    static let miniDataOverviewWindowPresented = Notification.Name("lingoweave.data-overview-window-presented")
}

/// These windows are always separate from the small study panel and its pin setting.
@MainActor
final class MiniDashboardWindowController: NSWindowController, NSWindowDelegate {
    private let presented: Notification.Name

    init(title: String, frameName: String, size: NSSize, minimum: NSSize,
         presented: Notification.Name, content: some View) {
        self.presented = presented
        let window = NSWindow(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = title
        window.contentMinSize = minimum
        window.isReleasedWhenClosed = false
        window.level = .normal
        window.collectionBehavior = [.fullScreenPrimary]
        window.contentView = NSHostingView(rootView: content)
        super.init(window: window)
        window.delegate = self
        window.center()
        window.setFrameUsingName(frameName)
        window.setFrameAutosaveName(frameName)
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
        NotificationCenter.default.post(name: presented, object: nil)
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        return false
    }
}
