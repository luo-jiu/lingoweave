import AppKit
import SwiftUI

@MainActor
private final class BrowserState: ObservableObject {
    @Published var words: [MiniWord] = MiniWord.starter + (0..<120).map {
        MiniWord(spelling: "entry-\($0)", meaning: "释义 \($0)", phonetic: "/test/")
    }
    @Published var selection: Int?
    var visible: [MiniWord] = []
}

private struct BrowserContent: View {
    @ObservedObject var state: BrowserState

    var body: some View {
        MiniWordBrowser(words: state.words, selection: $state.selection,
                        visibleWordsChanged: { state.visible = $0 })
            .padding(12)
            .background(Color(nsColor: .windowBackgroundColor))
    }
}

@main
struct MiniWordBrowserTests {
    @MainActor
    static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        app.activate(ignoringOtherApps: true)
        let state = BrowserState()
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 360, height: 300),
                              styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: BrowserContent(state: state))
        window.makeKeyAndOrderFront(nil)
        pump()
        guard let table = table(in: window.contentView) else { preconditionFailure("Missing word list") }
        precondition(table.numberOfRows == state.words.count)
        verifyVisible(table, state)
        precondition(state.visible.contains(state.words[1]) && !state.visible.contains(state.words[100]))
        precondition(state.selection == nil, "Entering the word list must not choose a random word")
        verifyCells(table, word: state.words[1], row: 1)

        table.scrollRowToVisible(100)
        pump()
        verifyVisible(table, state)
        precondition(state.visible.contains(state.words[100]) && !state.visible.contains(state.words[1]))
        let row = table.rows(in: table.visibleRect).location + 2
        let point = table.frameOfCell(atColumn: 0, row: row)
        let hit = table.row(at: NSPoint(x: point.midX, y: point.midY))
        precondition(hit == row && table.visibleRect.contains(NSPoint(x: point.midX, y: point.midY)))
        table.selectRowIndexes(IndexSet(integer: hit), byExtendingSelection: false)
        pump()
        precondition(state.selection == row && table.numberOfRows == state.words.count,
                     "Row \(row) was not selected: table=\(table.selectedRow), selection=\(String(describing: state.selection))")

        for size in [NSSize(width: 560, height: 360), NSSize(width: 300, height: 220)] {
            window.setContentSize(size)
            pump()
            verifyVisible(table, state)
            let fields = table.tableColumns.filter { !$0.isHidden }
            precondition(fields.count == (size.width < 440 ? 2 : 3))
            verifyCells(table, word: state.words[row], row: row)
            precondition(state.selection == row, "Resizing should not change the selected word")
        }

        state.words = []
        pump()
        precondition(table.numberOfRows == 0 && state.visible.isEmpty,
                     "An empty deck must clear all visible exposures")
        window.orderOut(nil)
        print("Native word list viewport, scrolling, row selection, resizing and empty-deck checks passed.")
    }

    @MainActor
    private static func table(in view: NSView?) -> NSTableView? {
        guard let view else { return nil }
        if let table = view as? NSTableView { return table }
        return view.subviews.lazy.compactMap { table(in: $0) }.first
    }

    @MainActor
    private static func verifyVisible(_ table: NSTableView, _ state: BrowserState) {
        let bounds = table.visibleRect
        let reported = Set(state.visible)
        let header = table.headerView.map { table.convert($0.bounds, from: $0) } ?? .zero
        let viewport = NSRect(x: bounds.minX, y: max(bounds.minY, header.maxY), width: bounds.width,
                              height: max(0, bounds.maxY - max(bounds.minY, header.maxY)))
        precondition(reported.count >= 3 && reported.count == state.visible.count,
                     "The browser must report several distinct on-screen words")
        for (row, word) in state.words.enumerated() {
            let frame = table.rect(ofRow: row)
            if viewport.minY <= frame.minY && frame.maxY <= viewport.maxY {
                precondition(reported.contains(word), "Missing a fully visible row: \(row)")
            } else if !viewport.intersects(frame) {
                precondition(!reported.contains(word), "Offscreen row reported as seen: \(row)")
            }
        }
    }

    @MainActor
    private static func verifyCells(_ table: NSTableView, word: MiniWord, row: Int) {
        let available = table.tableColumns.enumerated().compactMap { column, model -> String? in
            guard !model.isHidden else { return nil }
            let view = table.view(atColumn: column, row: row, makeIfNecessary: false)
            guard let field = (view as? NSTableCellView)?.textField ?? view as? NSTextField else {
                preconditionFailure("Missing rendered word list column")
            }
            precondition(field.bounds.width > 28 && field.bounds.height > 0)
            return field.stringValue
        }
        precondition(available.first == word.spelling && available.last == word.meaning)
        if available.count == 3 { precondition(available[1] == word.phonetic) }
    }

    @MainActor
    private static func pump() {
        RunLoop.current.run(until: Date().addingTimeInterval(0.2))
    }
}
