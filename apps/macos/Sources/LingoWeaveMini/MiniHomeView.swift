import SwiftUI

struct MiniHomeView: View {
    let day: MiniDailyDay?
    let ledger: MiniDailyLedger?
    let start: (MiniStudyIntent) -> Void
    var error: String? = nil
    var legacyReview: MiniReviewSession? = nil
    var preview = false
    var context: MiniPlanContext? = nil
    var saving = false
    var startExtraGroup: ((String) -> Void)? = nil
    var openPlan: (() -> Void)? = nil
    var deckName = "自定义词表"
    var deckDetail: String? = nil
    var bookId: String? = nil
    var openWords: (() -> Void)? = nil
    var assessmentClient: MiniAssessmentClient? = nil
    var assessmentUpdated: (() async -> Void)? = nil
    var assessmentPreview: MiniAssessmentSnapshot? = nil
    var assessmentPreviewDetail: MiniAssessmentDetail? = nil
    var openTranslationReview: (() -> Void)? = nil
    var openLearnedPatterns: (() -> Void)? = nil
    @Environment(\.colorScheme) private var colorScheme
    @State private var showingActivity = false
    @State private var hoveredActivityDate: Date?

    var body: some View {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = context.flatMap { TimeZone(identifier: $0.timezone) } ?? .autoupdatingCurrent
        let now = Date.now
        let activityTime = context?.dayInterval.map { day in
            let lastInstant = Date(timeIntervalSinceReferenceDate: day.end.timeIntervalSinceReferenceDate.nextDown)
            return min(max(now, day.start), lastInstant)
        } ?? (preview ? now : nil)
        let activity = activityTime.flatMap { time in
            ledger.map { MiniActivityGrid(ledger: $0, now: time, calendar: calendar) }
        }

        return VStack(spacing: 8) {
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    plan
                    if let ledger, let activityTime {
                        todayActivity(MiniTodayActivity(ledger: ledger, now: activityTime, calendar: calendar),
                                      date: activityTime, timezone: calendar.timeZone)
                    }
                    if assessmentClient != nil || assessmentPreview != nil {
                        MiniAssessmentHomeView(client: assessmentClient, preview: assessmentPreview,
                                               previewDetail: assessmentPreviewDetail, didUpdate: assessmentUpdated)
                            .id(assessmentPreview?.jobs.first?.status.rawValue ?? "live")
                    }
                    if let openLearnedPatterns {
                        Button(action: openLearnedPatterns) {
                            HStack(spacing: 6) {
                                Image(systemName: "text.quote").foregroundStyle(studyTint)
                                Text("学过的句式")
                                Spacer()
                                Image(systemName: "chevron.right").foregroundStyle(.secondary)
                            }
                            .font(.caption.weight(.medium)).padding(.vertical, 3)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("homeLearnedPatterns")
                    }
                    if let activity {
                        DisclosureGroup(isExpanded: $showingActivity) {
                            heatmap(activity)
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("学习记录")
                                    if let progress = context?.wordProgress {
                                        Text("累计学完 \(progress.lifetime) 词")
                                            .font(.caption2).foregroundStyle(.secondary)
                                    }
                                }
                                Spacer(minLength: 4)
                                if !showingActivity { weeklyActivity(activity) }
                                Text("近 4 个月 · \(activity.activeDays) 天")
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .font(.caption)
                        .accessibilityIdentifier("homeActivity")
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 1)
                .padding(.bottom, 2)
            }
            .overlayPreferenceValue(MiniActivityHoverKey.self) { hover in
                if let hover { activityTooltip(hover) }
            }
            .onChange(of: showingActivity) { _, _ in hoveredActivityDate = nil }

            VStack(spacing: 4) {
                if let next = nextTaskDescription {
                    Text(next).font(.caption).foregroundStyle(.secondary)
                }
                homeActions
                    .disabled(saving)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var studyTint: Color {
        colorScheme == .dark ? Color(red: 0.42, green: 0.79, blue: 0.75)
                             : Color(red: 0.12, green: 0.43, blue: 0.41)
    }

    private var plan: some View {
        let complete = context?.todayCompleted == true
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 11) {
                bookEmblem
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 5) {
                        Text("今日任务").font(.caption.weight(.semibold)).foregroundStyle(studyTint)
                        if complete {
                            Image(systemName: "checkmark.circle.fill").font(.caption)
                                .foregroundStyle(.green).accessibilityLabel("今日任务已完成")
                                .accessibilityIdentifier("homeTodayCompleted")
                        }
                        if let mode = context?.effective.mode, mode != .normal {
                            Text(mode.label).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 2)
                        if let openPlan {
                            Button(action: openPlan) {
                                Image(systemName: "slider.horizontal.3")
                                    .font(.system(size: 12, weight: .medium))
                                    .frame(width: 26, height: 20).contentShape(Rectangle())
                            }
                            .buttonStyle(.plain).foregroundStyle(.secondary).disabled(saving)
                            .help("调整学习计划").accessibilityLabel("调整学习计划")
                            .accessibilityIdentifier("homeOpenPlan")
                        }
                    }
                    if let openWords {
                        Button(action: openWords) {
                            HStack(spacing: 4) {
                                deckTitle.lineLimit(2).fixedSize(horizontal: false, vertical: true)
                                Image(systemName: "chevron.right").font(.caption2.weight(.medium)).foregroundStyle(.secondary)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).help("浏览当前词表")
                        .accessibilityLabel("浏览词表，\(deckName)").accessibilityIdentifier("homeOpenWords")
                    } else {
                        deckTitle.lineLimit(2).fixedSize(horizontal: false, vertical: true)
                    }
                    if let bookProgress {
                        Text(bookProgressLabel(bookProgress))
                            .font(.caption.monospacedDigit()).foregroundStyle(studyTint)
                    }
                    if let context, context.effective.mode == .normal {
                        Text("每日新词 \(context.effective.budget.effectiveDailyGoal) 词 · 每组 \(context.effective.budget.effectiveGroupSize) 词")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            if let context {
                if context.absenceDays >= 3 {
                    Text("已有 \(context.absenceDays) 天未学习。")
                        .font(.caption).foregroundStyle(.secondary)
                }
                if !complete, !context.reviewAvailable, !context.learningAvailable, context.canStartExtraGroup != true,
                   let reason = context.blockedReason {
                    Text(reason).font(.caption).foregroundStyle(.secondary)
                }
            } else if let error {
                Text(error).font(.caption).foregroundStyle(.secondary)
            } else if ledger == nil {
                ProgressView("读取本机学习记录…").controlSize(.small)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background {
            RoundedRectangle(cornerRadius: 11, style: .continuous)
                .fill(Color(nsColor: .controlBackgroundColor).opacity(colorScheme == .dark ? 0.48 : 0.72))
            RoundedRectangle(cornerRadius: 11, style: .continuous)
                .fill(LinearGradient(colors: [studyTint.opacity(0.10), .clear],
                                     startPoint: .leading, endPoint: .trailing))
        }
        .overlay { RoundedRectangle(cornerRadius: 11, style: .continuous).strokeBorder(studyTint.opacity(0.17), lineWidth: 0.7) }
    }

    private var deckTitle: Text {
        let title = Text(deckName).font(.system(size: 16, weight: .semibold))
        guard let deckDetail else { return title }
        let detail = Text(deckDetail).font(.callout).foregroundStyle(.secondary)
        return Text("\(title)   \(detail)")
    }

    private var bookProgress: MiniWordProgress? {
        guard let progress = context?.wordProgress, progress.bookId == bookId else { return nil }
        return progress
    }

    private func bookProgressLabel(_ progress: MiniWordProgress) -> String {
        let scope = bookId == nil ? "词表" : "全书"
        return "\(scope)已学 \(progress.completed.formatted()) / \(progress.total.formatted()) 词"
    }

    private var bookEmblem: some View {
        let progress = bookProgress?.fraction ?? 0
        return ZStack {
            Circle().fill(studyTint.opacity(0.08))
            Circle().strokeBorder(studyTint.opacity(0.19), lineWidth: 2.5)
            if progress > 0 {
                Circle().inset(by: 1.25).trim(from: 0, to: progress)
                    .stroke(studyTint, style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
                    .rotationEffect(.degrees(-90))
            }
            Image(systemName: "book.fill").font(.system(size: 18, weight: .medium)).foregroundStyle(studyTint)
        }
        .frame(width: 44, height: 44)
        .accessibilityHidden(true)
        .help(bookProgress.map(bookProgressLabel) ?? deckName)
    }

    private func todayActivity(_ activity: MiniTodayActivity, date: Date, timezone: TimeZone) -> some View {
        let completed = context?.completedNewCount ?? activity.completedNewWords
        let dateStyle = Date.FormatStyle(timeZone: timezone).month(.defaultDigits).day().locale(Locale(identifier: "zh_CN"))
        return VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 7) {
                Text("今日记录").font(.subheadline.weight(.semibold))
                Text(date, format: dateStyle)
                    .font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                    .accessibilityIdentifier("homeStudyDate")
            }
            HStack(spacing: 0) {
                activityStat(completed == nil ? "新词记忆" : "完成新词",
                             value: completed ?? activity.learnedWords, unit: "词")
                    .help(completed == nil ? "今天完成记忆的新词，按单词与释义去重"
                          : "完成记忆、拼写及翻译确认的新词；不等待后台评价")
                Divider().frame(height: 26).accessibilityHidden(true)
                activityStat("复习练习", value: activity.reviewedWords, unit: "词")
                    .help("今天实际判断或拼写过的复习词，重复练习只计一次")
                Divider().frame(height: 26).accessibilityHidden(true)
                if let openTranslationReview {
                    Button(action: openTranslationReview) {
                        activityStat("翻译点评", value: activity.writingAnswers, unit: "题", opensDetail: true)
                    }
                    .buttonStyle(.plain)
                    .help("查看今天提交的译文和 AI 点评")
                    .accessibilityLabel("今日翻译点评").accessibilityValue("\(activity.writingAnswers) 题")
                    .accessibilityIdentifier("homeTranslationReview")
                } else {
                    activityStat("写作提交", value: activity.writingAnswers, unit: "题")
                }
            }
        }
        .accessibilityIdentifier("homeTodayActivity")
    }

    private var nextTaskDescription: String? {
        guard legacyReview == nil else { return nil }
        let pending: MiniDailyDay?
        if let context {
            pending = ledger?.days.first { $0.id == context.pendingDayId }
        } else { pending = day.flatMap { Calendar.current.isDateInToday($0.startedAt) ? $0 : nil } }
        guard let pending, pending.phase != .finished else { return nil }
        let stage: String
        switch pending.phase {
        case .review:
            stage = pending.memoryWindow != nil ? "复习重学" : (pending.review?.phase == .spelling ? "复习拼写" : "复习判断")
        case .learning:
            if let visit = pending.memoryWindow?.visit {
                stage = ["初见记忆", "语境回忆", "词义回忆"][visit.stage]
            } else if let memory = pending.memory, memory.round <= 3 {
                stage = ["初见记忆", "语境回忆", "词义回忆"][max(0, memory.round - 1)]
            } else {
                stage = pending.nextUnstudiedWord == nil ? "新词拼写" : "新词记忆"
            }
        case .translation: stage = "写作练习"
        case .finished: return nil
        }
        return "接着" + stage
    }

    @ViewBuilder
    private var homeActions: some View {
        if let context {
            let reviewReady = legacyReview != nil || context.reviewAvailable
            let reviewTitle = legacyReview.map { "继续复习 \($0.totalCount)" } ?? "待复习 \(context.dueCount)"
            HStack(spacing: 10) {
                homeButton(reviewTitle, image: "arrow.clockwise", prominent: reviewReady) { start(.review) }
                    .disabled(!reviewReady)
                    .help(reviewReady ? "复习到期单词" : "当前没有到期复习词")
                    .accessibilityIdentifier("startDailyReview")
                if context.showsExtraLearning {
                    homeButton(context.learningButtonTitle, image: "plus", prominent: !reviewReady) { startExtraGroup?(context.date) }
                        .disabled(context.canStartExtraGroup != true || startExtraGroup == nil)
                        .help(context.extraGroupWordCount.map { "加练 \($0) 个新词" } ?? "加练一组新词")
                        .accessibilityIdentifier("startExtraStudyGroup")
                } else {
                    homeButton(context.learningButtonTitle, image: context.activeExtraGroupWordCount == nil ? "book" : "plus",
                               prominent: !reviewReady) { start(.learn) }
                        .disabled(!context.learningAvailable)
                        .help(context.activeExtraGroupWordCount != nil ? "继续这组加练" :
                                (reviewReady && context.learningAvailable ? "先完成到期复习，再学新词" : "按今日计划学习新词"))
                        .accessibilityIdentifier("startDailyStudy")
                }
            }
        } else if preview, let day {
            let reviewReady = legacyReview != nil || day.phase == .review
            let reviewCount = legacyReview?.totalCount ?? (reviewReady ? day.reviewWords.count : 0)
            HStack(spacing: 10) {
                homeButton("待复习 \(reviewCount)", image: "arrow.clockwise", prominent: reviewReady) { start(.review) }
                    .disabled(!reviewReady)
                    .accessibilityIdentifier("startDailyReview")
                homeButton("学新词 \(day.flow?.dailyNewGoal ?? day.learningWords.count)", image: "book", prominent: !reviewReady) { start(.learn) }
                    .disabled(day.learningWords.isEmpty || day.phase == .finished)
                    .accessibilityIdentifier("startDailyStudy")
            }
        } else if error != nil {
            Button("重试读取") { start(.learn) }
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("startDailyStudy")
        }
    }

    @ViewBuilder
    private func homeButton(_ title: String, image: String, prominent: Bool, action: @escaping () -> Void) -> some View {
        let button = Button(action: action) { Label(title, systemImage: image) }
        if prominent { button.buttonStyle(.borderedProminent) } else { button.buttonStyle(.bordered) }
    }

    private func activityStat(_ title: String, value: Int, unit: String, opensDetail: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 3) {
                Text("\(value)").font(.system(size: 21, weight: .semibold, design: .rounded)).monospacedDigit()
                Text(unit).font(.caption).foregroundStyle(.secondary)
            }
            HStack(spacing: 3) {
                Text(title)
                if opensDetail { Image(systemName: "chevron.right").font(.system(size: 8, weight: .semibold)) }
            }
            .font(.caption).foregroundStyle(opensDetail ? Color.accentColor : .secondary)
        }
        .padding(.leading, 10).padding(.vertical, 3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(title)
        .accessibilityValue("\(value) \(unit)")
    }

    private func weeklyActivity(_ activity: MiniActivityGrid) -> some View {
        let totals = activity.weeks.compactMap { week -> Int? in
            let days = week.days.filter { !$0.isPadding && !$0.isFuture }
            return days.isEmpty ? nil : days.reduce(0) { $0 + $1.count }
        }
        let peak = max(1, totals.max() ?? 0)
        return HStack(alignment: .bottom, spacing: 1.5) {
            ForEach(totals.indices, id: \.self) { index in
                let count = totals[index]
                Capsule().fill(count > 0 ? studyTint : Color.secondary.opacity(0.3))
                    .frame(width: 2.5, height: 2 + 10 * CGFloat(count) / CGFloat(peak))
            }
        }
        .frame(height: 12, alignment: .bottom)
        .accessibilityHidden(true).help("近四个月每周的学习活动")
    }

    private func heatmap(_ activity: MiniActivityGrid) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            GeometryReader { geometry in
                let weekCount = CGFloat(max(activity.weeks.count, 1))
                let available = geometry.size.width - 11 - weekCount * 3
                let cellSize = max(1, min(10, floor(available / weekCount)))
                activityWeeks(activity, cellSize: cellSize)
                    .frame(maxWidth: .infinity)
            }
            .frame(height: 101)
            .accessibilityElement(children: .contain)
            .accessibilityLabel("最近四个日历月学习热力图，周一至周日从上到下")

            HStack(spacing: 3) {
                Spacer(minLength: 0)
                Text("少")
                ForEach(Self.activityLevels.indices, id: \.self) { index in
                    RoundedRectangle(cornerRadius: 2)
                        .fill(Self.activityLevels[index].color)
                        .frame(width: 8, height: 8)
                }
                Text("多")
            }
            .font(.system(size: 8))
            .foregroundStyle(.secondary)
            .accessibilityHidden(true)
        }
        .padding(7)
        .background(.quaternary.opacity(0.28), in: RoundedRectangle(cornerRadius: 6))
    }

    private func activityWeeks(_ activity: MiniActivityGrid, cellSize: CGFloat) -> some View {
        HStack(alignment: .top, spacing: 3) {
            VStack(spacing: 3) {
                Color.clear.frame(height: 10)
                ForEach(0..<7) { index in
                    let labels = [0: "一", 2: "三", 4: "五"]
                    Text(labels[index, default: ""])
                        .font(.system(size: 8))
                        .foregroundStyle(.secondary)
                        .frame(height: cellSize)
                }
            }
            .frame(width: 11)
            .accessibilityHidden(true)

            ForEach(activity.weeks) { week in
                VStack(spacing: 3) {
                    Color.clear
                        .frame(width: cellSize, height: 10)
                        .overlay(alignment: week.isLast ? .trailing : .leading) {
                            if let month = week.month {
                                Text("\(month)月")
                                    .font(.system(size: 8))
                                    .foregroundStyle(.secondary)
                                    .fixedSize()
                            }
                        }
                        .accessibilityHidden(true)
                    ForEach(week.days) { cell in
                        activityCell(cell, size: cellSize, timezone: activity.timezone)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func activityCell(_ cell: MiniActivityGrid.Day, size: CGFloat, timezone: TimeZone) -> some View {
        if cell.isPadding {
            Color.clear.frame(width: size, height: size).accessibilityHidden(true)
        } else {
            let date = cell.date.formatted(Date.FormatStyle(timeZone: timezone).year().month().day().weekday())
            let description = cell.isFuture ? "日期尚未到来" :
                "Review \(cell.reviewedWords) · New \(cell.newWords) · All \(cell.reviewedWords + cell.newWords)"
            RoundedRectangle(cornerRadius: 2)
                .fill(cell.isFuture ? Color.secondary.opacity(0.06) : activityColor(cell.count))
                .frame(width: size, height: size)
                .overlay {
                    if cell.isToday {
                        RoundedRectangle(cornerRadius: 2).strokeBorder(Color.primary.opacity(0.6), lineWidth: 0.75)
                    }
                }
                .contentShape(Rectangle())
                .onHover { hovering in
                    if hovering {
                        hoveredActivityDate = cell.id
                    } else if hoveredActivityDate == cell.id {
                        hoveredActivityDate = nil
                    }
                }
                .anchorPreference(key: MiniActivityHoverKey.self, value: .bounds) { anchor in
                    hoveredActivityDate == cell.id ? .init(anchor: anchor, date: date, description: description) : nil
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(date)
                .accessibilityValue(description)
        }
    }

    private func activityTooltip(_ hover: MiniActivityHover) -> some View {
        GeometryReader { geometry in
            let cell = geometry[hover.anchor]
            let viewport = CGRect(origin: .zero, size: geometry.size)
            let width: CGFloat = 164
            let height: CGFloat = 36
            let inset: CGFloat = 4
            let halfWidth = width / 2
            let halfHeight = height / 2
            let above = cell.minY - halfHeight - inset
            let below = cell.maxY + halfHeight + inset
            if viewport.intersects(cell), viewport.width >= width + inset * 2, viewport.height >= height + inset * 2 {
                VStack(alignment: .leading, spacing: 2) {
                    Text(hover.date).font(.system(size: 9, weight: .medium)).foregroundStyle(.secondary)
                    Text(hover.description).font(.system(size: 10, weight: .medium).monospacedDigit())
                }
                .lineLimit(1)
                .minimumScaleFactor(0.82)
                .padding(.horizontal, 8)
                .frame(width: width, height: height)
                .background {
                    RoundedRectangle(cornerRadius: 6).fill(Color(nsColor: .windowBackgroundColor))
                        .shadow(color: .black.opacity(0.16), radius: 4, y: 1)
                }
                .overlay {
                    RoundedRectangle(cornerRadius: 6).strokeBorder(.quaternary)
                }
                .position(x: min(max(cell.midX, halfWidth + inset), viewport.width - halfWidth - inset),
                          y: min(above >= halfHeight + inset ? above : below, viewport.height - halfHeight - inset))
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private static let activityLevels: [(minimum: Int, color: Color)] = [
        (0, Color.secondary.opacity(0.16)),
        (1, Color.blue.opacity(0.24)),
        (50, Color.blue.opacity(0.45)),
        (150, Color.blue.opacity(0.68)),
        (300, .blue),
    ]

    private func activityColor(_ count: Int) -> Color {
        Self.activityLevels.last { $0.minimum <= count }?.color ?? .clear
    }
}

private struct MiniActivityHover {
    let anchor: Anchor<CGRect>
    let date: String
    let description: String
}

private struct MiniActivityHoverKey: PreferenceKey {
    static var defaultValue: MiniActivityHover? { nil }

    static func reduce(value: inout MiniActivityHover?, nextValue: () -> MiniActivityHover?) {
        value = value ?? nextValue()
    }
}

private struct MiniActivityGrid {
    struct Week: Identifiable {
        let id: Date
        let month: Int?
        let days: [Day]
        let isLast: Bool
    }

    struct Day: Identifiable {
        var id: Date { date }
        let date: Date
        let count: Int
        let reviewedWords: Int
        let newWords: Int
        let isToday: Bool
        let isFuture: Bool
        let isPadding: Bool
    }

    let weeks: [Week]
    let activeDays: Int
    let timezone: TimeZone

    init(ledger: MiniDailyLedger, now: Date, calendar: Calendar) {
        timezone = calendar.timeZone
        let today = calendar.startOfDay(for: now)
        guard let currentMonth = calendar.dateInterval(of: .month, for: today),
              let firstDate = calendar.date(byAdding: .month, value: -3, to: currentMonth.start) else {
            weeks = []
            activeDays = 0
            return
        }
        let daysSinceMonday = (calendar.component(.weekday, from: firstDate) + 5) % 7
        guard let firstMonday = calendar.date(byAdding: .day, value: -daysSinceMonday, to: firstDate),
              let dayCount = calendar.dateComponents([.day], from: firstMonday, to: currentMonth.end).day else {
            weeks = []
            activeDays = 0
            return
        }
        let weekCount = (dayCount + 6) / 7

        let activityByDay = MiniTodayActivity.byDay(ledger: ledger, from: firstDate, through: now, calendar: calendar)
        var counts: [Date: Int] = [:]
        func count(_ time: Date) {
            guard time >= firstDate, time <= now else { return }
            counts[calendar.startOfDay(for: time), default: 0] += 1
        }
        for day in ledger.days {
            for session in [day.review, day.learning].compactMap({ $0 }) {
                for event in session.judgmentEvents { count(event.selectedAt) }
                for attempt in session.spellingAttempts { count(attempt.submittedAt) }
            }
            if let flow = day.flow {
                for group in flow.groups {
                    for attempt in group.spelling.spellingAttempts { count(attempt.submittedAt) }
                }
                for event in flow.window.events { count(event.confirmedAt) }
                if let selected = flow.window.visit?.selectedAt { count(selected) }
            } else {
                for exposure in day.studiedWords { count(exposure.at) }
            }
            if let relearning = day.review?.relearning {
                for event in relearning.events { count(event.confirmedAt) }
                if let selected = relearning.visit?.selectedAt { count(selected) }
            }
            for attempt in day.translation { count(attempt.submittedAt) }
        }

        weeks = (0..<weekCount).compactMap { index in
            let days: [Day] = (0..<7).compactMap { weekday in
                guard let offset = calendar.date(byAdding: .day, value: index * 7 + weekday, to: firstMonday) else { return nil }
                let date = calendar.startOfDay(for: offset)
                let isPadding = date < firstDate || date >= currentMonth.end
                let activity = activityByDay[date]
                return Day(date: date, count: counts[date, default: 0],
                           reviewedWords: activity?.reviewedWords ?? 0,
                           newWords: activity?.completedNewWords ?? activity?.learnedWords ?? 0,
                           isToday: date == today, isFuture: date > today, isPadding: isPadding)
            }
            guard let first = days.first else { return nil }
            let monthStart = days.first { !$0.isPadding && calendar.component(.day, from: $0.date) == 1 }
            let month = monthStart.map { calendar.component(.month, from: $0.date) }
            return Week(id: first.date, month: month, days: days, isLast: index == weekCount - 1)
        }
        activeDays = counts.count
    }
}
