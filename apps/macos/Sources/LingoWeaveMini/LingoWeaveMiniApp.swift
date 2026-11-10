import AppKit
import SwiftUI

@main
struct LingoWeaveMiniApp {
    @MainActor
    static func main() {
        let app = NSApplication.shared
        let delegate = MiniAppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        withExtendedLifetime(delegate) {
            app.run()
        }
    }
}

private final class MiniPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

private struct MiniPanelContent: View {
    @State private var isPinned = true
    let onPinChange: (Bool) -> Void

    var body: some View {
        MiniStudyView(isPinned: $isPinned)
            .onChange(of: isPinned) { _, pinned in onPinChange(pinned) }
    }
}

struct MiniTitleDragRegion: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView { DragView() }

    func updateNSView(_ view: NSView, context: Context) {}

    private final class DragView: NSView {
        override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

        override func mouseDown(with event: NSEvent) {
            window?.performDrag(with: event)
        }
    }
}

@MainActor
private final class MiniAppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var panel: MiniPanel?
    private var statusItem: NSStatusItem?
    private var statusMenu: NSMenu?
    private var visibilityItem: NSMenuItem?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let panel = MiniPanel(
            contentRect: NSRect(x: 0, y: 0, width: 360, height: 300),
            styleMask: [.titled, .closable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        panel.title = "LingoWeave Mini"
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.titlebarSeparatorStyle = .none
        panel.delegate = self
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.contentMinSize = NSSize(width: 300, height: 250)
        panel.collectionBehavior = [.moveToActiveSpace, .canJoinAllApplications]
        let host = NSHostingView(rootView: MiniPanelContent { [weak self] pinned in
            self?.setPinned(pinned)
        })
        // The SwiftUI header shares the title bar's top row with the native buttons.
        host.safeAreaRegions = .keyboard
        panel.contentView = host
        panel.center()
        self.panel = panel
        setPinned(true)
        setUpMenu()
        panel.orderFrontRegardless()
        visibilityItem?.title = "隐藏词卡"
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        presentPanel()
        return false
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        if panel?.isVisible == true { presentPanel() }
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        hidePanel()
        return false
    }

    private func setPinned(_ pinned: Bool) {
        panel?.isFloatingPanel = pinned
        panel?.level = pinned ? .floating : .normal
    }

    private func setUpMenu() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = item.button {
            button.image = NSImage(systemSymbolName: "book.closed", accessibilityDescription: "语织")
            button.setAccessibilityLabel("显示语织")
            button.toolTip = "点击显示语织，右键打开菜单"
            button.target = self
            button.action = #selector(statusItemClicked(_:))
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }

        let menu = NSMenu()
        let visibility = NSMenuItem(title: "显示词卡", action: #selector(togglePanel), keyEquivalent: "")
        visibility.target = self
        menu.addItem(visibility)
        menu.addItem(.separator())
        let quit = NSMenuItem(title: "退出语织", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        quit.target = NSApp
        menu.addItem(quit)

        statusItem = item
        statusMenu = menu
        visibilityItem = visibility
    }

    @objc private func statusItemClicked(_ button: NSStatusBarButton) {
        let event = NSApp.currentEvent
        if event?.type == .rightMouseUp
            || (event?.type == .leftMouseUp && event?.modifierFlags.contains(.control) == true) {
            let bottom = button.isFlipped ? button.bounds.maxY : button.bounds.minY
            statusMenu?.popUp(positioning: nil, at: NSPoint(x: button.bounds.minX, y: bottom), in: button)
        } else {
            showPanel()
        }
    }

    @objc private func togglePanel() {
        if panel?.isVisible == true {
            hidePanel()
        } else {
            showPanel()
        }
    }

    private func showPanel() {
        presentPanel()
        guard !NSApp.isActive else { return }

        // Ask Launch Services to foreground the running accessory app on this explicit click.
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        configuration.addsToRecentItems = false
        configuration.createsNewApplicationInstance = false
        NSWorkspace.shared.openApplication(at: Bundle.main.bundleURL, configuration: configuration)
    }

    private func presentPanel() {
        guard let panel else { return }
        panel.orderFrontRegardless()
        panel.makeKeyAndOrderFront(nil)
        visibilityItem?.title = "隐藏词卡"
    }

    private func hidePanel() {
        panel?.orderOut(nil)
        visibilityItem?.title = "显示词卡"
    }
}
