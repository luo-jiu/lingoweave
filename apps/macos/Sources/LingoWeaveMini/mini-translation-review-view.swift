import SwiftUI

struct MiniTranslationReviewView: View {
    typealias Entry = MiniTranslationReview.Entry
    let timezone: TimeZone
    let load: (String, String) async throws -> MiniTranslationReview
    let retryJob: (UUID, UUID) async throws -> Void
    let gradeMissing: ((String, String) async throws -> MiniTranslationReview)?
    let close: () -> Void
    @State private var date: Date
    @State private var report: MiniTranslationReview?
    @State private var selection: UUID?
    @State private var lastRead: UUID?
    @State private var submittingGradesFor: Set<String> = []
    @State private var refreshID = UUID()
    @State private var loadError: String?
    @State private var retryError: String?
    @State private var retrying = Set<UUID>()
    @State private var requestIDs: [UUID: UUID] = [:]

    init(date: Date, timezone: TimeZone, load: @escaping (String, String) async throws -> MiniTranslationReview,
         retryJob: @escaping (UUID, UUID) async throws -> Void,
         gradeMissing: ((String, String) async throws -> MiniTranslationReview)? = nil, close: @escaping () -> Void) {
        _date = State(initialValue: date)
        self.timezone = timezone
        self.load = load
        self.retryJob = retryJob
        self.gradeMissing = gradeMissing
        self.close = close
    }

    private var dayKey: String { MiniTranslationReview.dateKey(date, timezone: timezone) }
    private var current: MiniTranslationReview? {
        guard report?.date == dayKey, report?.timezone == timezone.identifier else { return nil }
        return report
    }
    var body: some View {
        let entries = current?.entries ?? []
        let index = entries.firstIndex { $0.id == selection }
        return VStack(alignment: .leading, spacing: 7) {
            HStack {
                Button {
                    if index != nil { lastRead = selection; selection = nil } else { close() }
                } label: {
                    Label(index != nil ? "全部译文" : "返回", systemImage: "chevron.left")
                }
                .buttonStyle(.borderless).accessibilityIdentifier("translationReviewBack")
                Spacer()
                if let index {
                    HStack(spacing: 6) {
                        navigationButton("上一题", id: "translationReviewPrevious",
                                         destination: index > 0 ? entries[index - 1].id : nil)
                        Text("\(index + 1) / \(entries.count)")
                            .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                            .accessibilityLabel("当天第 \(index + 1) 题，共 \(entries.count) 题")
                        navigationButton("下一题", id: "translationReviewNext",
                                         destination: index + 1 < entries.count ? entries[index + 1].id : nil)
                    }
                } else {
                    DatePicker("提交日期", selection: $date, in: ...Date.now, displayedComponents: .date)
                        .labelsHidden().controlSize(.small)
                }
            }
            if let index {
                detail(entries[index])
            } else if let current {
                overview(current)
            } else if loadError == nil {
                ProgressView("读取译文…").controlSize(.small).frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            if let message = retryError ?? loadError {
                HStack {
                    Text(message).font(.caption).foregroundStyle(.secondary)
                    if loadError != nil {
                        Button("刷新") { refreshID = UUID() }.buttonStyle(.borderless)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .environment(\.timeZone, timezone)
        .onChange(of: dayKey) { _, _ in selection = nil; lastRead = nil; retryError = nil }
        .task(id: "\(dayKey)/\(timezone.identifier)/\(refreshID)") { await refresh() }
    }

    private func navigationButton(_ title: String, id: String, destination: UUID?) -> some View {
        Button(title) {
            if let destination { selection = destination }
        }
        .controlSize(.small)
        .disabled(destination == nil)
        .accessibilityIdentifier(id)
    }

    private func overview(_ report: MiniTranslationReview) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    overviewHeading(report).fixedSize()
                    Spacer(minLength: 0)
                    overviewActions(report).fixedSize()
                }
                VStack(alignment: .leading, spacing: 4) {
                    overviewHeading(report)
                    overviewActions(report)
                }
            }
            if report.entries.isEmpty {
                Label("当天还没有提交译文", systemImage: "text.bubble")
                    .foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollViewReader { reader in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            ForEach(report.entries) { entry in
                                Button { selection = entry.id } label: {
                                    HStack(spacing: 6) {
                                        VStack(alignment: .leading, spacing: 3) {
                                            HStack(alignment: .firstTextBaseline, spacing: 5) {
                                                Text(entry.word.spelling).font(.callout.weight(.semibold)).lineLimit(1)
                                                Text(entry.directionLabel).font(.caption2).foregroundStyle(.secondary).fixedSize()
                                            }
                                            Text(entry.question).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                                        }
                                        Spacer(minLength: 2)
                                        entryStatus(entry)
                                        Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.tertiary)
                                            .accessibilityHidden(true)
                                    }
                                    .padding(.vertical, 7).contentShape(Rectangle())
                                }
                                .buttonStyle(.plain).id(entry.id)
                                .accessibilityIdentifier("translationReviewRow-" + entry.id.uuidString.lowercased())
                                Divider()
                            }
                        }
                    }
                    .onAppear {
                        if let lastRead { reader.scrollTo(lastRead, anchor: .center) }
                    }
                }
            }
        }
        .accessibilityIdentifier("translationReviewList")
    }

    private func overviewHeading(_ report: MiniTranslationReview) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text("翻译点评").font(.headline)
            if !report.entries.isEmpty {
                let ready = report.entries.filter { $0.status == .ready && !$0.needsMeaningGrade }.count
                Text("已点评 \(ready) / \(report.entries.count) 题")
                    .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            }
        }
    }

    private func overviewActions(_ report: MiniTranslationReview) -> some View {
        HStack(spacing: 7) {
            if gradeMissing != nil, report.entries.contains(where: \.canGradeExpression) {
                Button("补评译文", action: requestExpressionGrades)
                    .disabled(submittingGradesFor.contains(dayKey))
                    .help("补评当天还缺少结论的译文")
                    .accessibilityIdentifier("gradeMissingTranslationExpressions")
            }
            if report.retryableJobs.count > 1 {
                Button("重试 \(report.retryableJobs.count) 条点评") { retry(report.retryableJobs) }
                    .disabled(!retrying.isEmpty)
                    .accessibilityIdentifier("retryFailedTranslationReviews")
            }
        }
        .buttonStyle(.borderless).font(.caption)
    }

    @ViewBuilder
    private func entryStatus(_ entry: Entry) -> some View {
        if let grade = entry.verdict {
            MiniExpressionGradeBadge(grade: grade)
        } else {
            let label = switch entry.expressionGradeStatus {
            case .queued: "等待点评"
            case .failed: "补评失败"
            case nil: entry.needsMeaningGrade ? "待重新点评" : entry.status.label
            }
            Text(label).font(.caption).foregroundStyle(.secondary).fixedSize()
        }
    }

    private func detail(_ entry: Entry) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 11) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(entry.word.spelling).font(.title3.weight(.semibold))
                    Text(entry.directionLabel).font(.caption).foregroundStyle(.secondary).fixedSize()
                    Spacer(minLength: 2)
                    if let grade = entry.verdict { MiniExpressionGradeBadge(grade: grade) }
                }
                VStack(alignment: .leading, spacing: 6) {
                    section("原题", entry.question)
                    Divider()
                    section("我的译文", entry.answer, protectsTranslation: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 10).padding(.vertical, 7)
                .background(.quaternary.opacity(0.55), in: RoundedRectangle(cornerRadius: 8))
                if let commentary = entry.visibleCommentary {
                    if !commentary.summary.isEmpty { section("AI 点评", commentary.summary) }
                    if entry.verdict == .offMeaning {
                        points("可以这样改", commentary.improvements)
                        points("写得好的地方", commentary.strengths)
                    } else {
                        points("写得好的地方", commentary.strengths)
                        if entry.verdict != .correct { points("可以这样改", commentary.improvements) }
                    }
                    if entry.verdict == .correct {
                        if let alternative = entry.alternativeChineseTranslation {
                            DisclosureGroup("另一种译法") {
                                Text(verbatim: alternative).font(.callout).miniTranslationPrivacy()
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .font(.caption)
                        }
                    } else if !commentary.referenceTranslation.isEmpty {
                        section("参考译文", commentary.referenceTranslation, protectsTranslation: true)
                    }
                    points("值得记住", commentary.keyPoints)
                    if entry.verdict == nil, let status = entry.expressionGradeStatus {
                        Text(status == .queued ? "正在补评…" : "补评失败，可返回列表重试。")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                } else if entry.needsMeaningGrade {
                    if entry.expressionGradeStatus == .queued {
                        Text("等待点评").font(.caption).foregroundStyle(.secondary)
                    } else if gradeMissing != nil {
                        Button("补评当天译文", action: requestExpressionGrades)
                            .disabled(submittingGradesFor.contains(dayKey))
                            .accessibilityIdentifier("regradeTranslationMeaning")
                    }
                } else {
                    HStack(spacing: 6) {
                        switch entry.status {
                        case .queued, .running:
                            ProgressView().controlSize(.mini)
                            Text(entry.status.label)
                        case .submitted:
                            Text("译文已提交，完成这题后可回来看点评。")
                        case .failed:
                            Text("点评生成失败，原译文已保留。")
                            if let id = entry.retryJobId {
                                Button(retrying.contains(id) ? "正在重试…" : "重试点评") { retry([id]) }
                                    .buttonStyle(.borderless).disabled(!retrying.isEmpty)
                                    .accessibilityIdentifier("retryTranslationReview")
                            }
                        case .ready:
                            Text("这题暂无详细点评。")
                        }
                    }
                    .font(.caption).foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading).padding(.trailing, 2)
            .textSelection(.enabled)
        }
        .id(entry.id)
        .accessibilityIdentifier("translationReviewDetail")
    }

    private func section(_ label: String, _ text: String, protectsTranslation: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            if protectsTranslation {
                Text(verbatim: text).font(.callout).fixedSize(horizontal: false, vertical: true)
                    .miniTranslationPrivacy()
            } else {
                Text(verbatim: text).font(.callout).fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    @ViewBuilder
    private func points(_ label: String, _ values: [String]) -> some View {
        let lines = values.filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        if !lines.isEmpty { section(label, lines.joined(separator: "\n")) }
    }

    private func requestExpressionGrades() {
        let key = dayKey, zone = timezone.identifier
        guard let gradeMissing, submittingGradesFor.insert(key).inserted else { return }
        retryError = nil
        Task { @MainActor in
            defer { submittingGradesFor.remove(key) }
            do {
                let next = try await gradeMissing(key, zone)
                guard dayKey == key else { return }
                guard next.date == key, next.timezone == zone else { throw MiniStudyClientError.invalidResponse }
                report = next
                refreshID = UUID()
            } catch {
                if dayKey == key { retryError = "未能补评译文，请再试一次。" }
            }
        }
    }

    @MainActor
    private func refresh() async {
        let key = dayKey, zone = timezone.identifier
        loadError = nil
        while !Task.isCancelled {
            do {
                let next = try await load(key, zone)
                try Task.checkCancellation()
                guard key == dayKey, zone == timezone.identifier else { return }
                guard next.date == key, next.timezone == zone else { throw MiniStudyClientError.invalidResponse }
                report = next
                loadError = nil
                if !next.processing { return }
                try await Task.sleep(for: .seconds(3))
            } catch {
                if !Task.isCancelled { loadError = "暂时无法读取翻译点评。" }
                return
            }
        }
    }

    private func retry(_ jobs: [UUID]) {
        guard retrying.isEmpty, !jobs.isEmpty else { return }
        retrying = Set(jobs)
        retryError = nil
        let key = dayKey
        Task { @MainActor in
            var failed = false
            defer { retrying.removeAll() }
            for id in jobs {
                let request = requestIDs[id] ?? UUID()
                requestIDs[id] = request
                do {
                    try await retryJob(id, request)
                    requestIDs.removeValue(forKey: id)
                } catch {
                    failed = true
                    if error is URLError { break }
                }
            }
            if key == dayKey {
                if failed { retryError = "部分点评未能重新开始，请再试一次。" }
                refreshID = UUID()
            }
        }
    }
}


private struct MiniExpressionGradeBadge: View {
    let grade: MiniTranslationReview.Verdict
    @Environment(\.colorScheme) private var scheme

    private var tint: Color {
        switch (grade, scheme) {
        case (.correct, .dark), (.natural, .dark): Color(red: 0.49, green: 0.84, blue: 0.65)
        case (.correct, _), (.natural, _): Color(red: 0.12, green: 0.42, blue: 0.27)
        case (.understandable, .dark): Color(red: 0.94, green: 0.73, blue: 0.39)
        case (.understandable, _): Color(red: 0.52, green: 0.34, blue: 0.08)
        case (.offMeaning, .dark): Color(red: 0.99, green: 0.61, blue: 0.60)
        case (.offMeaning, _): Color(red: 0.63, green: 0.22, blue: 0.23)
        }
    }
    private var symbol: String {
        switch grade {
        case .correct, .natural: "checkmark"
        case .understandable: "pencil"
        case .offMeaning: "exclamationmark"
        }
    }
    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: symbol).font(.system(size: 9, weight: .bold))
            Text(grade.rawValue).font(.caption.weight(.medium))
        }
        .foregroundStyle(tint)
        .padding(.horizontal, 6).padding(.vertical, 2)
        .background(tint.opacity(0.10), in: Capsule())
        .fixedSize()
        .help(grade.description)
        .accessibilityElement(children: .ignore).accessibilityLabel(grade.description)
    }
}
