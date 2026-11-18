import AppKit
import Carbon
import SwiftUI

@main
struct LingoWeaveMiniApp {
    @MainActor
    static func main() {
        let app = NSApplication.shared
        let delegate = MiniAppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
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
    @State private var isPinned = false
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
    private var shortcutItem: NSMenuItem?
    private var hotKey: EventHotKeyRef?
    private var hotKeyHandler: EventHandlerRef?
    private var memoryWindow: MiniMemoryWindowController?
    private weak var lastActiveWindow: NSWindow?

    private enum Shortcut: String, CaseIterable {
        case space, letterL, disabled
        var label: String {
            switch self {
            case .space: "⌃⌥空格"
            case .letterL: "⌃⌥L"
            case .disabled: "关闭"
            }
        }
        var keyCode: UInt32? {
            switch self {
            case .space: UInt32(kVK_Space)
            case .letterL: UInt32(kVK_ANSI_L)
            case .disabled: nil
            }
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let url = Bundle.main.url(forResource: "app-icon", withExtension: "icns"),
           let icon = NSImage(contentsOf: url) {
            NSApp.applicationIconImage = icon
        }
        #if DEBUG
        let title = "LingoWeave Mini Dev"
        #else
        let title = "LingoWeave Mini"
        #endif
        let panel = MiniPanel(
            contentRect: NSRect(x: 0, y: 0, width: 360, height: 300),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        panel.title = title
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.titlebarSeparatorStyle = .none
        panel.delegate = self
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.isExcludedFromWindowsMenu = false
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
        NotificationCenter.default.addObserver(self, selector: #selector(openMemoryWindow),
                                               name: .miniOpenMemoryWindow, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(windowBecameKey(_:)),
                                               name: NSWindow.didBecomeKeyNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(applicationHidden),
                                               name: NSApplication.didHideNotification, object: NSApp)
        setPinned(false)
        setUpMainMenu()
        setUpMenu()
        configureShortcut(Shortcut(rawValue: UserDefaults.standard.string(forKey: "globalShortcut") ?? "space") ?? .space)
        presentPanel()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        restoreWindow()
        return false
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        restoreWindow()
    }

    @objc private func windowBecameKey(_ notification: Notification) {
        guard let window = notification.object as? NSWindow,
              window === panel || window === memoryWindow?.window else { return }
        lastActiveWindow = window
    }

    @objc private func applicationHidden() {
        NotificationCenter.default.post(name: .miniWindowVisibilityChanged, object: false)
    }

    private func restoreWindow() {
        if let window = lastActiveWindow, window !== panel, window.isVisible || window.isMiniaturized {
            if window.isMiniaturized { window.deminiaturize(nil) }
            window.makeKeyAndOrderFront(nil)
        } else { presentPanel() }
    }

    private func setUpMainMenu() {
        let main = NSMenu()
        let application = NSMenu(title: "语织")
        application.addItem(withTitle: "隐藏语织", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = application.addItem(withTitle: "隐藏其他应用", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        application.addItem(.separator())
        application.addItem(withTitle: "退出语织", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let applicationItem = NSMenuItem()
        applicationItem.submenu = application
        main.addItem(applicationItem)

        let edit = NSMenu(title: "编辑")
        edit.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "复制", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        let editItem = NSMenuItem(title: "编辑", action: nil, keyEquivalent: "")
        editItem.submenu = edit
        main.addItem(editItem)

        let windows = NSMenu(title: "窗口")
        let study = windows.addItem(withTitle: "显示词卡", action: #selector(showPanel), keyEquivalent: "1")
        study.target = self
        let memory = windows.addItem(withTitle: "记忆曲线…", action: #selector(openMemoryWindow), keyEquivalent: "2")
        memory.target = self
        windows.addItem(.separator())
        windows.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windows.addItem(withTitle: "关闭窗口", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        let windowItem = NSMenuItem(title: "窗口", action: nil, keyEquivalent: "")
        windowItem.submenu = windows
        main.addItem(windowItem)
        NSApp.mainMenu = main
        NSApp.windowsMenu = windows
    }

    func applicationWillTerminate(_ notification: Notification) {
        NotificationCenter.default.removeObserver(self)
        if let hotKey { UnregisterEventHotKey(hotKey) }
        if let hotKeyHandler { RemoveEventHandler(hotKeyHandler) }
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
            #if DEBUG
            button.image = NSImage(systemSymbolName: "hammer", accessibilityDescription: "语织 Dev")
            button.setAccessibilityLabel("显示语织 Dev")
            #else
            button.image = NSImage(systemSymbolName: "book.closed", accessibilityDescription: "语织")
            button.setAccessibilityLabel("显示语织")
            #endif
            button.toolTip = "点击显示语织，右键打开菜单"
            button.target = self
            button.action = #selector(statusItemClicked(_:))
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }

        let menu = NSMenu()
        let visibility = NSMenuItem(title: "显示词卡", action: #selector(togglePanel), keyEquivalent: "")
        visibility.target = self
        menu.addItem(visibility)
        let memory = NSMenuItem(title: "记忆曲线…", action: #selector(openMemoryWindow), keyEquivalent: "")
        memory.target = self
        menu.addItem(memory)
        let shortcut = NSMenuItem(title: "全局快捷键", action: nil, keyEquivalent: "")
        shortcut.submenu = NSMenu()
        shortcutItem = shortcut
        menu.addItem(shortcut)
        menu.addItem(.separator())
        let quit = NSMenuItem(title: "退出语织", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        quit.target = NSApp
        menu.addItem(quit)

        statusItem = item
        statusMenu = menu
        visibilityItem = visibility
    }

    private func configureShortcut(_ choice: Shortcut) {
        if let hotKey { UnregisterEventHotKey(hotKey); self.hotKey = nil }
        UserDefaults.standard.set(choice.rawValue, forKey: "globalShortcut")
        var status = noErr
        if let keyCode = choice.keyCode {
            if hotKeyHandler == nil {
                var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
                status = InstallEventHandler(GetApplicationEventTarget(), { _, event, context in
                    guard let event, let context else { return OSStatus(eventNotHandledErr) }
                    var identifier = EventHotKeyID()
                    let result = GetEventParameter(event, EventParamName(kEventParamDirectObject),
                                                   EventParamType(typeEventHotKeyID), nil,
                                                   MemoryLayout<EventHotKeyID>.size, nil, &identifier)
                    guard result == noErr, identifier.signature == 0x6c67776d, identifier.id == 1 else {
                        return OSStatus(eventNotHandledErr)
                    }
                    let owner = Unmanaged<MiniAppDelegate>.fromOpaque(context).takeUnretainedValue()
                    Task { @MainActor in owner.toggleShortcutPanel() }
                    return noErr
                }, 1, &eventType, Unmanaged.passUnretained(self).toOpaque(), &hotKeyHandler)
            }
            if status == noErr {
                status = RegisterEventHotKey(keyCode, UInt32(controlKey | optionKey),
                                            EventHotKeyID(signature: 0x6c67776d, id: 1),
                                            GetApplicationEventTarget(), 0, &hotKey)
            }
        }
        shortcutItem?.title = status == noErr ? "全局快捷键 · \(choice.label)" : "全局快捷键 · 被占用"
        let menu = shortcutItem?.submenu
        menu?.removeAllItems()
        for option in Shortcut.allCases {
            let item = NSMenuItem(title: option.label, action: #selector(selectShortcut(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = option.rawValue
            item.state = option == choice ? .on : .off
            menu?.addItem(item)
        }
        if status != noErr {
            menu?.addItem(.separator())
            let message = NSMenuItem(title: "\(choice.label) 无法注册，请选择其他快捷键", action: nil, keyEquivalent: "")
            message.isEnabled = false
            menu?.addItem(message)
        }
    }

    @objc private func selectShortcut(_ sender: NSMenuItem) {
        guard let value = sender.representedObject as? String, let choice = Shortcut(rawValue: value) else { return }
        configureShortcut(choice)
    }

    private func toggleShortcutPanel() {
        if panel?.isVisible == true && NSApp.isActive { hidePanel() }
        else { showPanel() }
    }

    @objc private func openMemoryWindow() {
        if memoryWindow == nil { memoryWindow = MiniMemoryWindowController() }
        memoryWindow?.present()
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

    @objc private func showPanel() {
        presentPanel()
        NSApp.activate(ignoringOtherApps: true)
    }

    private func presentPanel() {
        guard let panel else { return }
        if panel.isMiniaturized { panel.deminiaturize(nil) }
        panel.orderFrontRegardless()
        panel.makeKeyAndOrderFront(nil)
        visibilityItem?.title = "隐藏词卡"
        NotificationCenter.default.post(name: .miniWindowVisibilityChanged, object: true)
    }

    private func hidePanel() {
        panel?.orderOut(nil)
        visibilityItem?.title = "显示词卡"
        NotificationCenter.default.post(name: .miniWindowVisibilityChanged, object: false)
    }
}
