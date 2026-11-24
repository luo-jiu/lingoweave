import SwiftUI

struct MiniPatternLibraryView: View {
    var load: (String, Int) async throws -> MiniPhrasePage
    var close: () -> Void

    @State private var text = ""
    @State private var rows: [MiniLearnedPhrase] = []
    @State private var expanded: String?
    @State private var total: Int?
    @State private var offset = 0
    @State private var requestId: UUID?
    @State private var failed = false
    private var search: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 5) {
                Button(action: close) { Label("首页", systemImage: "chevron.left") }
                    .buttonStyle(.borderless).accessibilityIdentifier("patternLibraryBack")
                Spacer(minLength: 2)
                if let total { Text("\(total) 个句式").font(.caption.monospacedDigit()).foregroundStyle(.secondary) }
            }
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary).accessibilityHidden(true)
                TextField("搜索英文句式或中文意思", text: $text).textFieldStyle(.plain)
                    .accessibilityIdentifier("patternLibrarySearch")
                if !text.isEmpty {
                    Button { text = "" } label: { Image(systemName: "xmark.circle.fill") }
                        .buttonStyle(.plain).foregroundStyle(.secondary).accessibilityLabel("清除搜索")
                }
            }
            .padding(.horizontal, 8).padding(.vertical, 5)
            .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 6))

            if search.utf16.count > 200 {
                Text("搜索词请控制在 200 个字符以内").font(.caption).foregroundStyle(.secondary)
            } else if rows.isEmpty && !failed {
                if total == nil {
                    ProgressView().controlSize(.small).frame(maxWidth: .infinity, maxHeight: .infinity)
                        .accessibilityLabel("读取句式")
                } else {
                    Label(search.isEmpty ? "还没有看过起手句式" : "没有找到匹配的句式",
                          systemImage: search.isEmpty ? "text.quote" : "magnifyingglass")
                        .font(.callout).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(rows) { entry in
                            patternRow(entry)
                            Divider()
                        }
                        if failed {
                            HStack {
                                Text("暂时无法读取句式").foregroundStyle(.secondary)
                                Button("重试") { Task { await fetch(search, startingAt: offset) } }.buttonStyle(.borderless)
                            }.font(.caption).padding(.vertical, 8)
                        } else if let total, offset < total {
                            Button(requestId == nil ? "显示更多" : "正在读取…") {
                                Task { await fetch(search, startingAt: offset) }
                            }
                            .buttonStyle(.borderless).disabled(requestId != nil)
                            .frame(maxWidth: .infinity).padding(.vertical, 6)
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .task(id: search) {
            let selection = search
            requestId = nil
            expanded = nil
            rows = []
            total = nil
            offset = 0
            failed = false
            guard selection.utf16.count <= 200 else { return }
            if !selection.isEmpty {
                do { try await Task.sleep(for: .milliseconds(160)) } catch { return }
            }
            await fetch(selection, startingAt: 0)
        }
        .accessibilityIdentifier("learnedPatternLibrary")
    }

    private func patternRow(_ entry: MiniLearnedPhrase) -> some View {
        let open = expanded == entry.id
        return VStack(alignment: .leading, spacing: 4) {
            Button {
                expanded = open ? nil : entry.id
            } label: {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .firstTextBaseline, spacing: 5) {
                        Text(entry.expression).font(.callout.weight(.semibold)).lineLimit(open ? nil : 2)
                        Spacer(minLength: 0)
                        if let status = entry.patternStatusLabel {
                            Text(status).font(.caption2).foregroundStyle(.secondary).fixedSize()
                        }
                        Image(systemName: open ? "chevron.down" : "chevron.right")
                            .font(.system(size: 8, weight: .semibold)).foregroundStyle(.tertiary)
                    }
                    if let meaning = entry.explanation, !meaning.isEmpty {
                        Text(meaning).font(.caption).foregroundStyle(.secondary).lineLimit(open ? nil : 1)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint(open ? "收起详情" : "展开详情")
            if open {
                VStack(alignment: .leading, spacing: 3) {
                    if let english = entry.exampleEnglish, !english.isEmpty, english != entry.expression {
                        Text(english).font(.callout)
                    }
                    if let chinese = entry.exampleChinese, !chinese.isEmpty, chinese != entry.explanation {
                        Text(chinese).font(.caption).foregroundStyle(.secondary)
                    }
                    HStack(spacing: 4) {
                        Text("最近记录")
                        Text(entry.lastSeenAt, format: .dateTime.year().month().day())
                    }
                    .font(.caption2).foregroundStyle(.secondary)
                }
                .textSelection(.enabled)
            }
        }
        .padding(.vertical, 6)
    }

    private func fetch(_ selection: String, startingAt start: Int) async {
        guard selection == search, !Task.isCancelled, requestId == nil else { return }
        let id = UUID()
        requestId = id
        failed = false
        defer { if requestId == id { requestId = nil } }
        do {
            let page = try await load(selection, start)
            guard requestId == id, search == selection, !Task.isCancelled else { return }
            let previous = Set(rows.map(\.id))
            rows.append(contentsOf: page.items.filter { !previous.contains($0.id) })
            total = page.total
            offset = page.items.isEmpty ? page.total : start + page.items.count
        } catch {
            if requestId == id, search == selection, !Task.isCancelled { failed = true }
        }
    }
}
