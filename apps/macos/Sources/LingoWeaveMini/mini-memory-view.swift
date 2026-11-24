import AppKit
import Charts
import SwiftUI

struct MiniMemoryView: View {
    let study: MiniStudyClient
    @State private var overview: MiniMemoryOverview?
    @State private var detail: MiniMemoryDetail?
    @State private var viewport = MiniMemoryViewport()
    @State private var query = ""
    @State private var filter = MemoryFilter.all
    @State private var wordPageNumber = 1
    @State private var dimension = MiniMemoryDimension.meaning
    @State private var selectedID: String?
    @State private var hoveredID: String?
    @State private var overviewError: String?
    @State private var detailError: String?
    @State private var loading = false
    @State private var detailLoading = false
    @State private var reload = 0
    @State private var detailReload = 0
    @State private var lastRefresh: Date?
    private let accent = Color(red: 0.08, green: 0.47, blue: 0.44)

    private var client: MiniMemoryClient { MiniMemoryClient(study: study) }
    private var requestKey: String { viewport.key + "/\(reload)" }
    private var detailKey: String {
        guard let overview, overview.from == viewport.range.lowerBound, overview.to == viewport.range.upperBound,
              let selectedID else { return "waiting" }
        return selectedID + "/" + viewport.key + "/\(overview.asOf.timeIntervalSinceReferenceDate)/\(detailReload)"
    }
    private var filteredWords: [MiniMemoryWord] {
        let words = overview?.words ?? []
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if needle.isEmpty && filter == .all { return words }
        // The overview already orders all senses by due date, spelling and sense ID.
        return words.filter { item in
            filter.includes(item.status) && (needle.isEmpty || item.word.spelling.localizedCaseInsensitiveContains(needle)
                || item.word.meaning.localizedCaseInsensitiveContains(needle))
        }
    }
    private var scatterWords: [MiniMemoryWord] {
        filteredWords.filter { item in item.ability(dimension) != nil && item.dueAt.map(viewport.range.contains) == true }
    }
    private var selectedWord: MiniMemoryWord? { overview?.words.first { $0.senseId == selectedID } }

    var body: some View {
        GeometryReader { geometry in
            VStack(alignment: .leading, spacing: 16) {
                header
                if let overview {
                    summary(overview.summary)
                    controls
                    HStack(alignment: .top, spacing: 16) {
                        ScrollViewReader { scroll in
                            ScrollView {
                                LazyVStack(spacing: 0, pinnedViews: [.sectionHeaders]) {
                                    scatterPanel.padding(.bottom, 16)
                                    workloadPanel(overview).padding(.bottom, 16)
                                    wordList(scroll: scroll)
                                    if !overview.notices.isEmpty {
                                        Text(overview.notices.joined(separator: "\n"))
                                            .font(.caption).foregroundStyle(.secondary)
                                            .frame(maxWidth: .infinity, alignment: .leading)
                                            .padding(.top, 16)
                                    }
                                }
                                .padding(2)
                            }
                        }
                        .frame(maxWidth: .infinity)
                        ScrollView { detailPanel.padding(2) }
                            .frame(width: max(300, min(380, geometry.size.width * 0.34)))
                    }
                } else if let overviewError {
                    initialFailure(overviewError)
                } else {
                    VStack(spacing: 12) {
                        ProgressView().controlSize(.large)
                        Text("正在读取学习记录…").foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .padding(24)
            .background(Color(nsColor: .windowBackgroundColor))
        }
        .tint(accent)
        .task(id: requestKey) { await loadOverview() }
        .task(id: detailKey) { await loadDetail() }
        .onReceive(NotificationCenter.default.publisher(for: .miniMemoryWindowPresented)) { _ in
            if !loading, lastRefresh.map({ Date.now.timeIntervalSince($0) > 15 }) ?? false { reload += 1 }
        }
        .onChange(of: query) { _, _ in keepSelectionVisible(resetPage: true) }
        .onChange(of: filter) { _, _ in keepSelectionVisible(resetPage: true) }
        .accessibilityIdentifier("memoryDashboard")
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 14) {
            Image(systemName: "chart.xyaxis.line")
                .font(.system(size: 25, weight: .medium))
                .foregroundStyle(accent)
                .frame(width: 52, height: 52)
                .background(accent.opacity(0.09), in: RoundedRectangle(cornerRadius: 15))
            VStack(alignment: .leading, spacing: 4) {
                Text("记忆地图").font(.system(size: 28, weight: .semibold, design: .rounded))
                Text("看看每个词的学习轨迹，以及之后什么时候再见。")
                    .font(.callout).foregroundStyle(.secondary)
            }
            Spacer(minLength: 10)
            VStack(alignment: .trailing, spacing: 5) {
                Button { reload += 1 } label: { Label("刷新", systemImage: "arrow.clockwise") }
                    .disabled(loading).accessibilityIdentifier("memoryRefresh")
                if loading, overview != nil {
                    HStack(spacing: 5) { ProgressView().controlSize(.mini); Text("更新中") }.font(.caption2).foregroundStyle(.secondary)
                } else if let overview {
                    Text("更新于 " + overview.asOf.formatted(date: .omitted, time: .shortened))
                        .font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
    }

    private func summary(_ summary: MiniMemoryOverview.Summary) -> some View {
        HStack(spacing: 12) {
            MemoryStat(title: "记录中的词", value: summary.wordCount, subtitle: "已完成 \(summary.completedWordCount) 词", color: accent)
            MemoryStat(title: "待复习", value: summary.dueCount, subtitle: summary.overdueCount.map { "其中往日积压 \($0) 词" } ?? "含当前复习组", color: .orange)
            MemoryStat(title: "可看估计", value: summary.measuredWordCount, subtitle: "至少一个维度有证据", color: .indigo)
            MemoryStat(title: "学习中", value: summary.learningCount, subtitle: "当前还未完成的新词", color: .secondary)
        }
    }

    private var controls: some View {
        VStack(spacing: 9) {
            HStack(spacing: 12) {
                Picker("时间范围", selection: $viewport.preset) {
                    ForEach(MiniMemoryViewport.Preset.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented).labelsHidden().frame(width: 275)
                .onChange(of: viewport.preset) { _, _ in viewport.reset() }
                HStack(spacing: 6) {
                    Image(systemName: "magnifyingglass.minus").foregroundStyle(.secondary)
                    Slider(value: $viewport.zoom, in: 1...8).frame(minWidth: 70, maxWidth: 140)
                        .accessibilityLabel("时间缩放")
                    Image(systemName: "magnifyingglass.plus").foregroundStyle(.secondary)
                }
                Spacer(minLength: 2)
                Button { viewport.pan(-0.5) } label: { Image(systemName: "chevron.left") }
                    .help("向前平移半个时间窗口").accessibilityLabel("查看更早日期")
                Button { viewport.pan(0.5) } label: { Image(systemName: "chevron.right") }
                    .help("向后平移半个时间窗口").accessibilityLabel("查看更晚日期")
                Button("回到今天") { viewport.reset() }
            }
            HStack(spacing: 8) {
                Text(viewport.range.lowerBound.formatted(.dateTime.year().month().day()) + " — "
                     + viewport.range.upperBound.formatted(.dateTime.year().month().day()))
                    .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                if viewport.preset == .overview {
                    Text("最多展示两年，可左右平移").font(.caption2).foregroundStyle(.secondary)
                }
                Spacer()
                if let overviewError {
                    Text(overviewError).font(.caption2).foregroundStyle(.orange).lineLimit(1)
                    Button("重试") { reload += 1 }.font(.caption)
                }
            }
        }
        .accessibilityIdentifier("memoryTimeControls")
    }

    private var scatterPanel: some View {
        MemoryPanel {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("词汇分布").font(.headline)
                        Text("横向看复习日期，纵向看当前预计回忆率")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 4)
                    Picker("估计维度", selection: $dimension) {
                        ForEach(MiniMemoryDimension.allCases) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.segmented).labelsHidden().frame(width: 128)
                }
                if scatterWords.isEmpty {
                    memoryEmpty(title: overview?.words.isEmpty == true ? "还没有记忆曲线" : "当前范围内还没有可绘制的点",
                                subtitle: overview?.words.isEmpty == true
                                    ? "完成学习后会自动积累记录。每个词的安排与曲线会出现在这里。"
                                    : "可以调整日期或筛选。仍在积累证据的词保留在下方词表中。")
                        .frame(height: 210)
                } else {
                    scatterChart.frame(height: 230)
                }
                HStack(spacing: 12) {
                    MemoryLegend(color: accent, text: "已安排")
                    MemoryLegend(color: .orange, text: "待复习")
                    Spacer(minLength: 2)
                    Text("图中 \(scatterWords.count) 词").font(.caption2).foregroundStyle(.secondary)
                }
                Text("未有估计的词不画作 0%。点选一个词，可以查看它的轨迹。")
                    .font(.caption2).foregroundStyle(.secondary)
            }
        }
    }

    private var scatterChart: some View {
        Chart {
            ForEach(scatterWords) { item in
                if let date = item.dueAt, let ability = item.ability(dimension) {
                    PointMark(x: .value("复习日期", date), y: .value("预计回忆率", ability.retrievability * 100))
                        .foregroundStyle(item.status == .due ? Color.orange : accent)
                        .symbolSize(item.senseId == selectedID ? 130 : (item.senseId == hoveredID ? 95 : 45))
                        .opacity(item.senseId == selectedID || item.senseId == hoveredID ? 1 : 0.68)
                        .annotation(position: .top, alignment: .leading) {
                            if item.senseId == hoveredID {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(item.word.spelling).font(.caption.weight(.semibold))
                                    Text("\(dimension.rawValue) \(memoryPercent(ability.retrievability)) · " + date.formatted(.dateTime.month().day()))
                                        .font(.caption2).foregroundStyle(.secondary)
                                }
                                .padding(8).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
                            }
                        }
                }
            }
            if let asOf = overview?.asOf, viewport.range.contains(asOf) {
                RuleMark(x: .value("今天", asOf)).foregroundStyle(Color.secondary.opacity(0.4))
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [4, 4]))
                    .annotation(position: .top, alignment: .leading) { Text("今天").font(.caption2).foregroundStyle(.secondary) }
            }
        }
        .chartXScale(domain: viewport.range).chartYScale(domain: 0...100)
        .chartXAxis { AxisMarks(values: .automatic(desiredCount: 4)) { _ in AxisGridLine(); AxisValueLabel(format: .dateTime.month(.abbreviated).day()) } }
        .chartYAxis { AxisMarks(values: [0, 25, 50, 75, 100]) { value in AxisGridLine(); AxisValueLabel { if let number = value.as(Int.self) { Text("\(number)%") } } } }
        .chartOverlay { proxy in
            GeometryReader { geometry in
                if let anchor = proxy.plotFrame {
                    let plot = geometry[anchor]
                    Rectangle().fill(.clear).contentShape(Rectangle())
                        .onContinuousHover { phase in
                            switch phase {
                            case .active(let location): hoveredID = nearestWord(at: location, plot: plot)?.senseId
                            case .ended: hoveredID = nil
                            }
                        }
                        .gesture(SpatialTapGesture().onEnded { value in
                            if let item = nearestWord(at: value.location, plot: plot),
                               let index = filteredWords.firstIndex(where: { $0.senseId == item.senseId }) {
                                selectedID = item.senseId
                                wordPageNumber = MiniMemoryWordPage.number(containing: index)
                            }
                        })
                }
            }
        }
        .accessibilityLabel("词汇分布，横轴复习日期，纵轴当前预计回忆率。也可用下方词表选词。")
        .accessibilityIdentifier("memoryScatter")
    }

    private func nearestWord(at location: CGPoint, plot: CGRect) -> MiniMemoryWord? {
        guard plot.contains(location), plot.width > 0, plot.height > 0 else { return nil }
        let duration = viewport.range.upperBound.timeIntervalSince(viewport.range.lowerBound)
        var nearest: MiniMemoryWord?
        var distance = 22.0 * 22.0
        for item in scatterWords {
            guard let date = item.dueAt, let ability = item.ability(dimension) else { continue }
            let x = plot.minX + date.timeIntervalSince(viewport.range.lowerBound) / duration * plot.width
            let y = plot.maxY - ability.retrievability * plot.height
            let squared = pow(location.x - x, 2) + pow(location.y - y, 2)
            if squared < distance { nearest = item; distance = squared }
        }
        return nearest
    }

    private func workloadPanel(_ overview: MiniMemoryOverview) -> some View {
        MemoryPanel {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text("复习负荷").font(.headline)
                    Spacer()
                    Text("全词库 · 当前已排期").font(.caption2).foregroundStyle(.secondary)
                }
                if overview.load.contains(where: { $0.count > 0 }) {
                    Chart(overview.load) { item in
                        BarMark(x: .value("日期", item.at, unit: .day), y: .value("词数", item.count))
                            .foregroundStyle(accent.opacity(0.55)).cornerRadius(2)
                    }
                    .chartXScale(domain: viewport.calendarRange)
                    .chartXAxis { AxisMarks(values: .automatic(desiredCount: 4)) { _ in AxisValueLabel(format: .dateTime.month(.abbreviated).day()) } }
                    .chartYAxis { AxisMarks(position: .leading, values: .automatic(desiredCount: 3)) }
                    .frame(height: 110)
                    .accessibilityIdentifier("memoryWorkload")
                } else {
                    Text("这个时间范围内还没有已排期的复习。")
                        .font(.callout).foregroundStyle(.secondary).frame(maxWidth: .infinity, minHeight: 75)
                }
                Text("按原定日期统计。往日积压计入上方「待复习」。")
                    .font(.caption2).foregroundStyle(.secondary)
            }
        }
    }

    private func wordList(scroll: ScrollViewProxy) -> some View {
        let words = filteredWords
        let page = MiniMemoryWordPage(words: words, number: wordPageNumber)
        func changePage(_ number: Int) {
            wordPageNumber = number
            scroll.scrollTo("memoryWordListStart", anchor: .top)
        }

        return Section {
            VStack(alignment: .leading, spacing: 10) {
                if page.rows.isEmpty {
                    Text(query.isEmpty ? "这个筛选下暂时没有词。" : "没有找到匹配的词。")
                        .foregroundStyle(.secondary).font(.callout).padding(.vertical, 18)
                }
                LazyVStack(spacing: 3) {
                    ForEach(page.rows) { item in
                        Button { selectedID = item.senseId } label: {
                            HStack(spacing: 10) {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(item.word.spelling).font(.system(size: 15, weight: .semibold, design: .serif)).foregroundStyle(.primary)
                                    Text(item.word.meaning).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                                }
                                Spacer(minLength: 4)
                                VStack(alignment: .trailing, spacing: 3) {
                                    Text(item.ability(dimension).map { memoryPercent($0.retrievability) } ?? "积累中")
                                        .font(.callout.monospacedDigit()).foregroundStyle(item.status == .due ? Color.orange : accent)
                                    Text(item.dueAt.map { $0.formatted(.dateTime.month().day()) } ?? "未安排")
                                        .font(.caption2).foregroundStyle(.secondary)
                                }
                                if item.senseId == selectedID { Image(systemName: "chevron.right").font(.caption.weight(.bold)).foregroundStyle(accent) }
                            }
                            .padding(.horizontal, 10).padding(.vertical, 9)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(item.senseId == selectedID ? accent.opacity(0.09) : .clear, in: RoundedRectangle(cornerRadius: 9))
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).accessibilityAddTraits(item.senseId == selectedID ? .isSelected : [])
                        .accessibilityIdentifier("memoryWord:" + item.senseId)
                    }
                }
                Text("词表保留范围外及积累中的词，搜索和状态筛选也会作用于散点。")
                    .font(.caption2).foregroundStyle(.secondary)
            }
            .padding([.horizontal, .bottom], 17)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(nsColor: .controlBackgroundColor), in: UnevenRoundedRectangle(bottomLeadingRadius: 16, bottomTrailingRadius: 16))
        } header: {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text("词汇记录").font(.headline)
                    Text("\(words.count) 词").font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    if page.count > 1 {
                        HStack(spacing: 10) {
                            Button { changePage(page.number - 1) } label: { Image(systemName: "chevron.left") }
                                .disabled(page.number == 1)
                                .accessibilityLabel("上一页").accessibilityIdentifier("memoryWordPreviousPage")
                            Text("\(page.number) / \(page.count) 页")
                                .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                                .accessibilityIdentifier("memoryWordPage")
                            Button { changePage(page.number + 1) } label: { Image(systemName: "chevron.right") }
                                .disabled(page.number == page.count)
                                .accessibilityLabel("下一页").accessibilityIdentifier("memoryWordNextPage")
                        }
                        .buttonStyle(.bordered).controlSize(.small)
                    }
                }
                HStack(spacing: 8) {
                    HStack(spacing: 5) {
                        Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                        TextField("搜索单词或释义", text: $query).textFieldStyle(.plain)
                            .accessibilityIdentifier("memorySearch")
                        if !query.isEmpty { Button { query = "" } label: { Image(systemName: "xmark.circle.fill") }.buttonStyle(.plain).foregroundStyle(.secondary) }
                    }
                    .padding(8).background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 8))
                    Picker("到期状态", selection: $filter) {
                        ForEach(MemoryFilter.allCases) { Text($0.rawValue).tag($0) }
                    }
                    .labelsHidden().frame(width: 110)
                }
            }
            .padding(.horizontal, 17).padding(.top, 14).padding(.bottom, 8)
            .background(Color(nsColor: .controlBackgroundColor), in: UnevenRoundedRectangle(topLeadingRadius: 16, topTrailingRadius: 16))
            .id("memoryWordListStart")
        }
    }

    @ViewBuilder
    private var detailPanel: some View {
        if let selectedWord {
            VStack(spacing: 16) {
                MemoryPanel {
                    VStack(alignment: .leading, spacing: 14) {
                        HStack(alignment: .top) {
                            VStack(alignment: .leading, spacing: 5) {
                                Text(selectedWord.word.spelling).font(.system(size: 29, weight: .semibold, design: .serif))
                                Text(selectedWord.word.meaning).font(.callout).foregroundStyle(.secondary)
                            }
                            Spacer(minLength: 4)
                            Text(selectedWord.inCurrentReview == true ? "本组待完成" : selectedWord.status.label).font(.caption.weight(.medium))
                                .padding(.horizontal, 8).padding(.vertical, 4)
                                .background(accent.opacity(0.08), in: Capsule()).foregroundStyle(accent)
                        }
                        HStack(spacing: 10) {
                            abilityTile("词义估计", ability: selectedWord.meaning, color: accent)
                            abilityTile("拼写估计", ability: selectedWord.spelling, color: .indigo)
                        }
                        if let date = selectedWord.dueAt {
                            HStack(spacing: 5) {
                                Image(systemName: "calendar").foregroundStyle(accent)
                                Text("复习安排 " + date.formatted(.dateTime.month().day()))
                                Spacer(minLength: 2)
                                if !viewport.range.contains(date) { Button("定位") { viewport.focus(date) }.font(.caption) }
                            }.font(.caption)
                        }
                        if let last = selectedWord.lastReviewAt {
                            Text("最近复习 " + last.formatted(.dateTime.year().month().day()) + " · \(selectedWord.reviewCount) 次记录")
                                .font(.caption2).foregroundStyle(.secondary)
                        } else {
                            Text("还没有完成的复习记录。")
                                .font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                }
                MemoryPanel {
                    VStack(alignment: .leading, spacing: 11) {
                        HStack {
                            Text("记忆曲线").font(.headline)
                            Spacer()
                            if detailLoading { ProgressView().controlSize(.mini) }
                        }
                        if let detail, detail.word.senseId == selectedID {
                            MemoryCurve(detail: detail, range: viewport.range, accent: accent)
                        } else if detailLoading {
                            ProgressView("读取这个词的轨迹…").font(.caption).frame(maxWidth: .infinity, minHeight: 220)
                        }
                        if let detailError {
                            Text(detailError).font(.caption).foregroundStyle(.secondary)
                            Button("重试读取") { detailReload += 1 }
                        }
                    }
                }
                if let detail, detail.word.senseId == selectedID {
                    MemoryPanel { eventHistory(detail) }
                }
            }
        } else {
            MemoryPanel {
                memoryEmpty(title: "选一个词，看看它的轨迹", subtitle: "点击左侧散点或词汇记录。词义与拼写会分别显示，不把缺少的证据当作零分。")
                    .frame(minHeight: 350)
            }
        }
    }

    private func abilityTile(_ title: String, ability: MiniMemoryWord.Ability?, color: Color) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.caption2).foregroundStyle(.secondary)
            Text(ability.map { memoryPercent($0.retrievability) } ?? "积累中")
                .font(.system(size: 23, weight: .medium, design: .rounded).monospacedDigit()).foregroundStyle(color)
        }
        .frame(maxWidth: .infinity, alignment: .leading).padding(10)
        .background(color.opacity(0.055), in: RoundedRectangle(cornerRadius: 10))
    }

    private func eventHistory(_ detail: MiniMemoryDetail) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("真实记录").font(.headline)
                Spacer()
                Text("\(detail.events.count) 条").font(.caption).foregroundStyle(.secondary)
            }
            if detail.events.isEmpty {
                Text("当前日期范围内没有记录，可以把时间向前移动。")
                    .font(.callout).foregroundStyle(.secondary)
            }
            ForEach(detail.events.sorted { $0.occurredAt > $1.occurredAt }) { event in
                HStack(alignment: .top, spacing: 10) {
                    Circle().fill(event.evidence == "model" ? Color.indigo : accent).frame(width: 7, height: 7).padding(.top, 5)
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(alignment: .firstTextBaseline) {
                            Text(event.title).font(.callout.weight(.medium))
                            Spacer(minLength: 3)
                            Text(event.occurredAt.formatted(.dateTime.month().day().hour().minute()))
                                .font(.caption2).foregroundStyle(.secondary)
                        }
                        Text(event.evidenceLabel).font(.caption2).foregroundStyle(event.evidence == "model" ? Color.indigo : accent)
                        if !event.reasons.isEmpty { Text(event.reasons.joined(separator: "；")).font(.caption).foregroundStyle(.secondary) }
                        if abs(event.recordedAt.timeIntervalSince(event.occurredAt)) > 60 {
                            Text("写入于 " + event.recordedAt.formatted(.dateTime.month().day().hour().minute()))
                                .font(.caption2).foregroundStyle(.tertiary)
                        }
                    }
                }
                .padding(.vertical, 3)
            }
            if detail.eventsTruncated {
                Text("这里只展示最多 500 条记录，缩小日期范围可查看更完整的细节。")
                    .font(.caption2).foregroundStyle(.secondary)
            }
        }
        .textSelection(.enabled)
        .accessibilityIdentifier("memoryEvents")
    }

    private func memoryEmpty(title: String, subtitle: String) -> some View {
        VStack(spacing: 10) {
            Image(systemName: "leaf").font(.system(size: 29, weight: .light)).foregroundStyle(accent.opacity(0.65))
            Text(title).font(.headline)
            Text(subtitle).font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center).lineLimit(4)
        }.padding(22).frame(maxWidth: .infinity)
    }

    private func initialFailure(_ message: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "wifi.exclamationmark").font(.system(size: 30)).foregroundStyle(.secondary)
            Text("暂时无法读取记忆地图").font(.headline)
            Text(message).font(.callout).foregroundStyle(.secondary)
            Button("重新读取") { reload += 1 }
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func keepSelectionVisible(resetPage: Bool = false) {
        let visible = filteredWords
        let page = MiniMemoryWordPage(words: visible, number: resetPage ? 1 : wordPageNumber)
        wordPageNumber = page.number
        if !visible.contains(where: { $0.senseId == selectedID }) {
            let measured = page.rows.filter { $0.meaning != nil || $0.spelling != nil }
            selectedID = measured.first(where: { $0.dueAt.map(viewport.range.contains) == true })?.senseId
                ?? measured.first?.senseId ?? page.rows.first?.senseId
        }
        hoveredID = nil
    }

    @MainActor private func loadOverview() async {
        let key = requestKey
        loading = true
        defer { if key == requestKey { loading = false } }
        do {
            try await Task.sleep(for: .milliseconds(180))
            let response = try await client.overview(viewport)
            guard !Task.isCancelled, key == requestKey else { return }
            overview = response
            overviewError = nil
            lastRefresh = .now
            keepSelectionVisible()
        } catch is CancellationError { return }
        catch {
            guard !Task.isCancelled, key == requestKey else { return }
            overviewError = "本机学习服务暂时无法连接，已有图表保留。"
        }
    }

    @MainActor private func loadDetail() async {
        let key = detailKey
        guard key != "waiting", let selectedID else { return }
        detailLoading = true
        defer { if key == detailKey { detailLoading = false } }
        do {
            try await Task.sleep(for: .milliseconds(120))
            let response = try await client.detail(selectedID, viewport: viewport)
            guard !Task.isCancelled, key == detailKey else { return }
            detail = response
            detailError = nil
        } catch is CancellationError { return }
        catch {
            guard !Task.isCancelled, key == detailKey else { return }
            detailError = "这个词的曲线暂时无法读取，原始学习记录仍然保留。"
        }
    }
}

private enum MemoryFilter: String, CaseIterable, Identifiable {
    case all = "全部状态", due = "待复习", scheduled = "已安排", learning = "学习中", unscheduled = "未排期"
    var id: String { rawValue }
    func includes(_ status: MiniMemoryWord.Status) -> Bool {
        switch self { case .all: true; case .due: status == .due; case .scheduled: status == .scheduled; case .learning: status == .learning; case .unscheduled: status == .unmeasured }
    }
}

private func memoryPercent(_ value: Double) -> String { String(format: "%.0f%%", value * 100) }

private struct MemoryPanel<Content: View>: View {
    @ViewBuilder let content: () -> Content
    var body: some View {
        content().frame(maxWidth: .infinity, alignment: .leading).padding(17)
            .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 16))
            .overlay { RoundedRectangle(cornerRadius: 16).stroke(Color.primary.opacity(0.055), lineWidth: 1) }
    }
}

private struct MemoryStat: View {
    let title: String
    let value: Int
    let subtitle: String
    let color: Color
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline) {
                Text(title).font(.caption).foregroundStyle(.secondary)
                Spacer(minLength: 0)
                Text("\(value)").font(.system(size: 25, weight: .semibold, design: .rounded).monospacedDigit()).foregroundStyle(color)
            }
            Text(subtitle).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
        }.padding(13).frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 12))
    }
}

private struct MemoryLegend: View {
    let color: Color
    let text: String
    var body: some View {
        HStack(spacing: 5) { Circle().fill(color).frame(width: 6, height: 6); Text(text).font(.caption2).foregroundStyle(.secondary) }
    }
}

private struct MemoryCurve: View {
    let detail: MiniMemoryDetail
    let range: ClosedRange<Date>
    let accent: Color
    private var hasPoints: Bool { detail.points.contains { $0.meaning != nil || $0.spelling != nil } }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if hasPoints {
                Chart {
                    ForEach(MiniMemoryDimension.allCases) { dimension in
                        ForEach(Array(detail.points.enumerated()), id: \.offset) { _, point in
                            if let value = point.value(dimension), let segment = point.segment(dimension) {
                                LineMark(x: .value("日期", point.at), y: .value("预计回忆率", value * 100),
                                         series: .value("轨迹", dimension.rawValue + segment + (point.projected ? "future" : "past")))
                                    .foregroundStyle(dimension == .meaning ? accent : Color.indigo)
                                    .lineStyle(StrokeStyle(lineWidth: 2, dash: point.projected ? [5, 4] : []))
                                    .interpolationMethod(.linear)
                            }
                        }
                    }
                    if range.contains(detail.asOf) {
                        RuleMark(x: .value("今天", detail.asOf)).foregroundStyle(Color.secondary.opacity(0.3))
                            .lineStyle(StrokeStyle(lineWidth: 1, dash: [2, 3]))
                    }
                    if let due = detail.word.dueAt, range.contains(due) {
                        RuleMark(x: .value("复习安排", due)).foregroundStyle(Color.orange.opacity(0.65))
                            .lineStyle(StrokeStyle(lineWidth: 1, dash: [5, 3]))
                            .annotation(position: .top, alignment: .trailing) { Text("复习安排").font(.system(size: 9)).foregroundStyle(.orange) }
                    }
                }
                .chartXScale(domain: range).chartYScale(domain: 0...100)
                .chartXAxis { AxisMarks(values: .automatic(desiredCount: 3)) { _ in AxisGridLine(); AxisValueLabel(format: .dateTime.month(.abbreviated).day()) } }
                .chartYAxis { AxisMarks(position: .leading, values: [0, 50, 100]) { value in AxisGridLine(); AxisValueLabel { if let number = value.as(Int.self) { Text("\(number)%") } } } }
                .frame(height: 210)
                .accessibilityLabel("预计回忆率曲线，未来虚线假设不再复习")
                .accessibilityIdentifier("memoryCurve")
                if !detail.events.isEmpty {
                    Chart(detail.events) { event in
                        PointMark(x: .value("真实记录", event.occurredAt), y: .value("记录", 0))
                            .foregroundStyle(event.evidence == "model" ? Color.indigo : accent).symbolSize(22)
                    }
                    .chartXScale(domain: range).chartYScale(domain: -1...1)
                    .chartXAxis(.hidden).chartYAxis(.hidden).frame(height: 16)
                    .accessibilityLabel("真实记录时间点，标记不代表回忆率")
                }
                HStack(spacing: 12) { MemoryLegend(color: accent, text: "词义"); MemoryLegend(color: .indigo, text: "拼写") }
                Text("实线按已保存证据回算；虚线表示之后不再复习。底部点是实际记录时间。")
                    .font(.caption2).foregroundStyle(.secondary)
            } else {
                VStack(spacing: 9) {
                    Image(systemName: "chart.line.uptrend.xyaxis").font(.system(size: 25, weight: .light)).foregroundStyle(accent.opacity(0.6))
                    Text("这个词还在积累证据").font(.callout.weight(.medium))
                    Text(detail.word.dueAt == nil ? "完成学习后会开始安排复习；有可用记录时，这里会出现曲线。" : "复习已经安排。还没有足够的可建模记录，因此暂不绘制曲线。")
                        .font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
                }.padding(.vertical, 24).frame(maxWidth: .infinity)
            }
            Text("这是模型估计。复习安排还会考虑次日复习、错误情况与当天负荷，未必落在同一条曲线位置。")
                .font(.caption2).foregroundStyle(.secondary)
            if detail.downsampled { Text("较长区间已抽样显示，可放大查看细节。 ").font(.caption2).foregroundStyle(.secondary) }
            if !detail.notices.isEmpty { Text(detail.notices.joined(separator: "\n")).font(.caption2).foregroundStyle(.secondary) }
        }
    }
}
