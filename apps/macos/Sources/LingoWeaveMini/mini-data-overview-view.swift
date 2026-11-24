import AppKit
import SwiftUI

struct MiniDataOverviewView: View {
    let study: MiniStudyClient
    @State private var overview: MiniDataOverview?
    @State private var loading = false
    @State private var loadError: String?
    @State private var folderError: String?
    @State private var reload = 0
    private let accent = Color(red: 0.08, green: 0.47, blue: 0.44)

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            header
            if let overview {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        if let loadError { refreshFailure(loadError) }
                        highlights(overview)
                        storagePanel(overview)
                        locationPanel(overview.dataPath)
                        recordPanels(overview)
                    }
                    .padding(2)
                }
            } else if let loadError {
                VStack(spacing: 12) {
                    Image(systemName: "externaldrive.badge.questionmark")
                        .font(.system(size: 32)).foregroundStyle(.secondary)
                    Text("暂时无法读取数据总览").font(.headline)
                    Text(loadError).font(.callout).foregroundStyle(.secondary)
                    Button("重新读取") { reload += 1 }.buttonStyle(.borderedProminent)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                VStack(spacing: 12) {
                    ProgressView().controlSize(.large)
                    Text("正在统计本地数据…").foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .padding(24)
        .background(Color(nsColor: .windowBackgroundColor))
        .tint(accent)
        .task(id: reload) { await loadOverview() }
        .onReceive(NotificationCenter.default.publisher(for: .miniDataOverviewWindowPresented)) { _ in
            reload += 1
        }
        .accessibilityIdentifier("dataOverviewDashboard")
    }

    private var header: some View {
        HStack(spacing: 14) {
            Image(systemName: "externaldrive")
                .font(.system(size: 25, weight: .medium)).foregroundStyle(accent)
                .frame(width: 52, height: 52)
                .background(accent.opacity(0.09), in: RoundedRectangle(cornerRadius: 15))
            Text("数据总览").font(.system(size: 28, weight: .semibold, design: .rounded))
            Spacer(minLength: 10)
            VStack(alignment: .trailing, spacing: 6) {
                Button { reload += 1 } label: { Label("刷新", systemImage: "arrow.clockwise") }
                    .disabled(loading).accessibilityIdentifier("dataOverviewRefresh")
                if loading {
                    HStack(spacing: 5) {
                        ProgressView().controlSize(.mini)
                        Text("统计中")
                    }
                    .font(.caption2).foregroundStyle(.secondary)
                } else if let overview {
                    Text("更新于 " + overview.asOf.formatted(date: .abbreviated, time: .shortened))
                        .font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
    }

    private func highlights(_ overview: MiniDataOverview) -> some View {
        HStack(spacing: 12) {
            DataOverviewStat(title: "已完成单词", value: overview.learning.completedWords, unit: "词", color: accent)
            DataOverviewStat(title: "复习记录", value: overview.learning.reviewVisits, unit: "词次", color: .blue)
            DataOverviewStat(title: "学习天数", value: overview.learning.studyDays, unit: "天", color: .indigo)
        }
    }

    private func storagePanel(_ overview: MiniDataOverview) -> some View {
        let segments = overview.storage.map(DataStorageSegment.init)
        let total = segments.reduce(Int64(0)) { $0 + $1.bytes }
        return DataOverviewPanel {
            VStack(alignment: .leading, spacing: 14) {
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("存储占用").font(.headline)
                        Text("应用资料和服务日志").font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Text(dataByteCount(total))
                        .font(.system(size: 26, weight: .semibold, design: .rounded).monospacedDigit())
                        .foregroundStyle(accent)
                        .help(dataExactBytes(total))
                        .accessibilityLabel("总占用，" + dataExactBytes(total))
                }
                GeometryReader { geometry in
                    HStack(spacing: 0) {
                        ForEach(segments.filter { $0.bytes > 0 }) { segment in
                            segment.color
                                .frame(width: total > 0 ? geometry.size.width * Double(segment.bytes) / Double(total) : 0)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.primary.opacity(0.055))
                    .clipShape(RoundedRectangle(cornerRadius: 7))
                }
                .frame(height: 16)
                .accessibilityHidden(true)
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 155), alignment: .leading)], alignment: .leading, spacing: 12) {
                    ForEach(segments) { segment in
                        HStack(alignment: .top, spacing: 7) {
                            RoundedRectangle(cornerRadius: 2).fill(segment.color)
                                .frame(width: 8, height: 8).padding(.top, 3)
                            VStack(alignment: .leading, spacing: 3) {
                                HStack(spacing: 6) {
                                    Text(segment.title).foregroundStyle(.secondary)
                                    Text(dataByteCount(segment.bytes)).monospacedDigit()
                                }
                                Text(dataExactBytes(segment.bytes))
                                    .font(.caption2).foregroundStyle(.secondary).monospacedDigit()
                            }
                            .font(.caption)
                        }
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(segment.title + "，" + dataExactBytes(segment.bytes))
                    }
                }
            }
        }
        .accessibilityIdentifier("dataStorageDistribution")
    }

    private func recordPanels(_ overview: MiniDataOverview) -> some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 218), alignment: .top)], alignment: .leading, spacing: 12) {
            DataOverviewPanel {
                VStack(alignment: .leading, spacing: 12) {
                    sectionTitle("学习与词库", symbol: "books.vertical", color: accent)
                    dataRow("学习事件", count: overview.learning.events)
                    dataRow("翻译首答", count: overview.learning.translations)
                    Divider()
                    dataRow("词书", count: overview.vocabulary.books)
                    dataRow("词库条目", count: overview.vocabulary.entries)
                }
            }
            DataOverviewPanel {
                VStack(alignment: .leading, spacing: 12) {
                    sectionTitle("AI 与测评", symbol: "bubble.left.and.bubble.right", color: .indigo)
                    dataRow("对话", count: overview.ai.conversations)
                    dataRow("消息", count: overview.ai.messages)
                    Divider()
                    dataRow("已完成测评", count: overview.ai.completedAssessments)
                    HStack(spacing: 10) {
                        statusCount("待处理", count: overview.ai.pendingAssessments)
                        statusCount("失败", count: overview.ai.failedAssessments, attention: true)
                    }
                }
            }
            DataOverviewPanel {
                VStack(alignment: .leading, spacing: 12) {
                    sectionTitle("音频资源", symbol: "waveform", color: .blue)
                    HStack(spacing: 12) {
                        statusCount("单词", count: overview.audio.wordAssets)
                        statusCount("例句", count: overview.audio.sentenceAssets)
                    }
                    HStack(spacing: 12) {
                        statusCount("当前版本", count: overview.audio.currentAssets)
                        statusCount("历史版本", count: overview.audio.previousAssets)
                    }
                    Divider()
                    HStack(spacing: 12) {
                        statusCount("待生成", count: overview.audio.pendingJobs)
                        statusCount("失败或中断", count: overview.audio.failedJobs, attention: true)
                    }
                    HStack(spacing: 12) {
                        statusCount("文件缺失", count: overview.audio.missingFiles, attention: true)
                        statusCount("未引用文件", count: overview.audio.unreferencedFiles, attention: true)
                    }
                }
            }
        }
    }

    private func locationPanel(_ path: String) -> some View {
        DataOverviewPanel {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Label("数据位置", systemImage: "folder").font(.headline)
                    Spacer(minLength: 12)
                    Button {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(path, forType: .string)
                    } label: { Label("复制路径", systemImage: "doc.on.doc") }
                    .accessibilityIdentifier("dataOverviewCopyPath")
                    Button {
                        let opened = NSWorkspace.shared.open(URL(fileURLWithPath: path, isDirectory: true))
                        folderError = opened ? nil : "暂时无法打开文件夹，可以复制路径后在 Finder 中前往。"
                    } label: { Label("在 Finder 中打开", systemImage: "arrow.up.right.square") }
                    .accessibilityIdentifier("dataOverviewOpenFolder")
                }
                Text(path).font(.system(.caption, design: .monospaced)).foregroundStyle(.secondary)
                    .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("dataOverviewPath")
                if let folderError {
                    Text(folderError).font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }

    private func sectionTitle(_ title: String, symbol: String, color: Color) -> some View {
        Label(title, systemImage: symbol).font(.headline).foregroundStyle(color)
    }

    private func dataRow(_ title: String, count: Int) -> some View {
        HStack {
            Text(title).foregroundStyle(.secondary)
            Spacer(minLength: 8)
            Text(count.formatted()).monospacedDigit()
        }
        .font(.callout)
        .accessibilityElement(children: .combine)
    }

    private func statusCount(_ title: String, count: Int, attention: Bool = false) -> some View {
        HStack(spacing: 5) {
            Text(title).foregroundStyle(.secondary)
            Spacer(minLength: 0)
            Text(count.formatted()).monospacedDigit()
                .foregroundStyle(attention && count > 0 ? Color.orange : Color.primary)
        }
        .font(.caption)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    private func refreshFailure(_ message: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "arrow.clockwise.circle")
            Text(message)
            Spacer(minLength: 8)
            Button("重试") { reload += 1 }.disabled(loading)
        }
        .font(.caption).foregroundStyle(.secondary)
    }

    @MainActor private func loadOverview() async {
        let key = reload
        loading = true
        defer { if key == reload { loading = false } }
        do {
            let response = try await MiniDataOverviewClient(study: study).overview()
            guard !Task.isCancelled, key == reload else { return }
            overview = response
            loadError = nil
        } catch is CancellationError { return }
        catch {
            guard !Task.isCancelled, key == reload else { return }
            loadError = overview == nil
                ? "本机服务暂时无法提供统计，请稍后重试。"
                : "更新未完成，当前仍显示上次读取的数据。"
        }
    }
}

private struct DataOverviewPanel<Content: View>: View {
    @ViewBuilder let content: () -> Content
    var body: some View {
        content().frame(maxWidth: .infinity, alignment: .leading).padding(17)
            .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 16))
            .overlay { RoundedRectangle(cornerRadius: 16).stroke(Color.primary.opacity(0.055), lineWidth: 1) }
    }
}

private struct DataOverviewStat: View {
    let title: String
    let value: Int
    let unit: String
    let color: Color
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            HStack(alignment: .firstTextBaseline, spacing: 5) {
                Text(value.formatted())
                    .font(.system(size: 29, weight: .semibold, design: .rounded).monospacedDigit())
                    .foregroundStyle(color)
                Text(unit).font(.caption).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading).padding(16)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 14))
        .accessibilityElement(children: .combine)
    }
}

private struct DataStorageSegment: Identifiable {
    let id: String
    let title: String
    let color: Color
    let bytes: Int64

    init(_ storage: MiniDataOverview.Storage) {
        id = storage.kind.rawValue
        bytes = max(0, storage.bytes)
        switch storage.kind {
        case .learning: title = "学习数据库"; color = Color(red: 0.08, green: 0.47, blue: 0.44)
        case .ai: title = "AI 数据库"; color = .indigo
        case .audioIndex: title = "音频索引"; color = .cyan
        case .audioFiles: title = "音频 WAV"; color = .blue
        case .vocabulary: title = "词库资料"; color = .orange
        case .materials: title = "阅读素材"; color = .purple
        case .serviceLog: title = "服务日志"; color = .brown
        case .other: title = "其他资料"; color = .gray
        }
    }
}

private func dataByteCount(_ bytes: Int64) -> String {
    ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
}

private func dataExactBytes(_ bytes: Int64) -> String {
    bytes.formatted() + " 字节"
}
