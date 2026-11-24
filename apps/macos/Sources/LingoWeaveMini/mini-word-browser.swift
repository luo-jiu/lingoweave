import AppKit
import SwiftUI

struct MiniWordBrowser: NSViewRepresentable {
    let words: [MiniWord]
    @Binding var selection: Int?
    let visibleWordsChanged: ([MiniWord]) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> Viewport {
        let scroll = Viewport()
        let table = NSTableView()
        table.style = .plain
        table.backgroundColor = .clear
        table.rowHeight = 28
        table.intercellSpacing = NSSize(width: 6, height: 1)
        table.gridStyleMask = .solidHorizontalGridLineMask
        table.gridColor = .separatorColor
        table.columnAutoresizingStyle = .noColumnAutoresizing
        table.allowsColumnReordering = false
        table.allowsColumnResizing = false
        table.setAccessibilityLabel("浏览词表")
        for (key, title) in [("word", "单词"), ("phonetic", "音标"), ("meaning", "释义")] {
            let column = NSTableColumn(identifier: .init(key))
            column.title = title
            table.addTableColumn(column)
        }
        table.delegate = context.coordinator
        table.dataSource = context.coordinator
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.documentView = table
        scroll.onViewport = { [weak coordinator = context.coordinator] in coordinator?.reportViewport($0) }
        return scroll
    }

    func updateNSView(_ scroll: Viewport, context: Context) {
        guard let table = scroll.documentView as? NSTableView else { return }
        let coordinator = context.coordinator
        let reload = !coordinator.loaded || coordinator.browser.words != words
        coordinator.browser = self
        coordinator.updating = true
        defer { coordinator.updating = false }
        if reload { table.reloadData(); coordinator.loaded = true }
        if let selection, words.indices.contains(selection) {
            if table.selectedRow != selection {
                table.selectRowIndexes(IndexSet(integer: selection), byExtendingSelection: false)
                table.scrollRowToVisible(selection)
            }
        } else if table.selectedRow != -1 { table.deselectAll(nil) }
        scroll.scheduleReport()
    }

    static func dismantleNSView(_ scroll: Viewport, coordinator: Coordinator) {
        scroll.onViewport = nil
    }

    final class Viewport: NSScrollView {
        var onViewport: ((NSTableView) -> Void)?
        private var lastWidth: CGFloat = -1
        private var pending = false

        override func layout() {
            super.layout()
            if let table = documentView as? NSTableView, table.tableColumns.count == 3 {
                let width = floor(contentSize.width)
                if width > 0, width != lastWidth {
                    lastWidth = width
                    let columns = table.tableColumns
                    let wide = width >= 440
                    columns[1].isHidden = !wide
                    let usable = width - table.intercellSpacing.width * (wide ? 3 : 2)
                    columns[0].width = floor(min(190, usable * (wide ? 0.29 : 0.36)))
                    if wide { columns[1].width = floor(min(160, usable * 0.23)) }
                    columns[2].width = max(20, usable - columns[0].width - (wide ? columns[1].width : 0))
                }
            }
            scheduleReport()
        }

        override func reflectScrolledClipView(_ clipView: NSClipView) {
            super.reflectScrolledClipView(clipView)
            scheduleReport()
        }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            scheduleReport()
        }

        func scheduleReport() {
            guard !pending, onViewport != nil else { return }
            pending = true
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.pending = false
                if let table = self.documentView as? NSTableView { self.onViewport?(table) }
            }
        }
    }

    @MainActor final class Coordinator: NSObject, NSTableViewDataSource, NSTableViewDelegate {
        var browser: MiniWordBrowser
        var loaded = false
        var updating = false
        private var lastVisible: [MiniWord] = []
        init(_ browser: MiniWordBrowser) { self.browser = browser }

        func numberOfRows(in tableView: NSTableView) -> Int { browser.words.count }

        func tableView(_ table: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
            guard let key = tableColumn?.identifier, browser.words.indices.contains(row) else { return nil }
            let word = browser.words[row]
            let cell = table.makeView(withIdentifier: key, owner: self) as? NSTableCellView ?? NSTableCellView()
            let field: NSTextField
            if let existing = cell.textField { field = existing } else {
                cell.identifier = key
                field = NSTextField(labelWithString: "")
                field.lineBreakMode = .byTruncatingTail
                field.font = .systemFont(ofSize: NSFont.systemFontSize, weight: key.rawValue == "word" ? .semibold : .regular)
                field.textColor = key.rawValue == "phonetic" ? .secondaryLabelColor : .labelColor
                field.translatesAutoresizingMaskIntoConstraints = false
                cell.addSubview(field)
                cell.textField = field
                NSLayoutConstraint.activate([
                    field.leadingAnchor.constraint(equalTo: cell.leadingAnchor),
                    field.trailingAnchor.constraint(equalTo: cell.trailingAnchor),
                    field.centerYAnchor.constraint(equalTo: cell.centerYAnchor)
                ])
            }
            switch key.rawValue {
            case "word": field.stringValue = word.spelling
            case "phonetic": field.stringValue = word.phonetic
            default: field.stringValue = word.meaning
            }
            cell.toolTip = word.chatContext
            return cell
        }

        func tableViewSelectionDidChange(_ notification: Notification) {
            guard !updating, let table = notification.object as? NSTableView,
                  browser.words.indices.contains(table.selectedRow) else { return }
            browser.selection = table.selectedRow
        }

        func reportViewport(_ table: NSTableView) {
            var viewport = table.visibleRect
            // AppKit includes the floating column header in visibleRect after scrolling.
            if let header = table.headerView {
                let cover = viewport.intersection(header.convert(header.bounds, to: table))
                if !cover.isNull, cover.minY <= viewport.minY {
                    viewport = viewport.divided(atDistance: cover.height, from: .minYEdge).remainder
                }
            }
            let range = table.rows(in: viewport)
            let visible: [MiniWord]
            if table.window != nil, !table.isHiddenOrHasHiddenAncestor, range.length > 0,
               range.location != NSNotFound, range.location < browser.words.count {
                visible = Array(browser.words[range.location..<min(NSMaxRange(range), browser.words.count)])
            } else { visible = [] }
            guard visible != lastVisible else { return }
            lastVisible = visible
            browser.visibleWordsChanged(visible)
        }
    }
}
