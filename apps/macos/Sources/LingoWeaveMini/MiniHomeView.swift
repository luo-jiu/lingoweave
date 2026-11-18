import SwiftUI

struct MiniHomeView: View {
    let day: MiniDailyDay?
    let ledger: MiniDailyLedger?
    let start: () -> Void
    var error: String? = nil
    var hasLegacyReview = false
    var context: MiniPlanContext? = nil
    var saving = false
    var startRecovery: (() -> Void)? = nil
    var overrideRest: (() -> Void)? = nil
    var openPlan: (() -> Void)? = nil
    var continueGroup: ((String) -> Void)? = nil
    var deckName = "自定义词表"
    var assessmentClient: MiniAssessmentClient? = nil
    var assessmentUpdated: (() async -> Void)? = nil
    var assessmentPreview: MiniAssessmentSnapshot? = nil
    var assessmentPreviewDetail: MiniAssessmentDetail? = nil
    @State private var showingRetainedGroups = false
    @State private var showingActivity = false

    var body: some View {
        var calendar = Calendar.current
        if let timezone = context?.timezone, let zone = TimeZone(identifier: timezone) { calendar.timeZone = zone }
        let now = Date.now
        let activity = ledger.map { MiniActivityGrid(ledger: $0, now: now, calendar: calendar) }

        return VStack(spacing: 8) {
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    plan
                    if let ledger {
                        todayActivity(MiniTodayActivity(ledger: ledger, now: now, calendar: calendar))
                    }
                    if let context, !context.pendingGroups.isEmpty {
                        retainedGroups(context)
                    }
                    if assessmentClient != nil || assessmentPreview != nil {
                        MiniAssessmentHomeView(client: assessmentClient, preview: assessmentPreview,
                                               previewDetail: assessmentPreviewDetail, didUpdate: assessmentUpdated)
                            .id(assessmentPreview?.jobs.first?.status.rawValue ?? "live")
                    }
                    if let activity {
                        DisclosureGroup(isExpanded: $showingActivity) {
                            heatmap(activity)
                        } label: {
                            HStack {
                                Text("学习记录")
                                Spacer(minLength: 4)
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

            VStack(spacing: 4) {
                if let next = nextTaskDescription {
                    Text(next).font(.caption).foregroundStyle(.secondary)
                }
                homeActions(now: now, calendar: calendar)
                    .disabled(saving)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("miniHome")
    }

    @ViewBuilder
    private var plan: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline) {
                Text("学习计划").font(.headline)
                Spacer(minLength: 4)
                if let context {
                    Text(context.effective.mode.label).font(.caption).foregroundStyle(.secondary)
                }
                if let openPlan {
                    Button("调整", action: openPlan)
                        .font(.caption)
                        .buttonStyle(.plain)
                        .foregroundStyle(Color.accentColor)
                        .disabled(saving)
                        .accessibilityIdentifier("homeOpenPlan")
                }
            }
            Text(deckName).font(.callout).lineLimit(2)
            if let context {
                if context.effective.mode != .rest {
                    Text("每日新词 \(context.effective.budget.effectiveDailyGoal) 词 · 每组 \(context.effective.budget.effectiveGroupSize) 词")
                        .font(.caption).foregroundStyle(.secondary)
                }
                if context.recoverySuggested {
                    Text("已有 \(context.absenceDays) 天未学习，可以先从 \(context.recoveryWordLimit) 个词恢复。")
                        .font(.caption).foregroundStyle(.secondary)
                }
                if let reason = context.blockedReason {
                    Text(reason).font(.caption).foregroundStyle(.secondary)
                }
            } else if let error {
                Text(error).font(.caption).foregroundStyle(.secondary)
            } else if ledger == nil {
                ProgressView("读取本机学习记录…").controlSize(.small)
            }
        }
    }

    private func todayActivity(_ activity: MiniTodayActivity) -> some View {
        let completed = context?.completedNewCount ?? activity.completedNewWords
        return VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text("今日记录").font(.subheadline.weight(.semibold))
                Spacer(minLength: 4)
                if let context {
                    Text("到期复习 \(context.dueCount) 词").font(.caption).foregroundStyle(.secondary)
                }
            }
            HStack(spacing: 6) {
                activityStat(completed == nil ? "新词记忆" : "完成新词",
                             value: completed ?? activity.learnedWords, unit: "词")
                    .help(completed == nil ? "今天完成记忆的新词，按单词与释义去重"
                          : "完成记忆、拼写及翻译确认的新词；不等待后台评价")
                activityStat("复习练习", value: activity.reviewedWords, unit: "词")
                    .help("今天实际判断或拼写过的复习词，重复练习只计一次")
                activityStat("写作提交", value: activity.writingAnswers, unit: "题")
                    .help("今天实际提交的翻译答案，等待反馈的答案也计入")
            }
        }
        .accessibilityIdentifier("homeTodayActivity")
    }

    private var nextTaskDescription: String? {
        guard !hasLegacyReview, context?.effective.mode != .rest else { return nil }
        let pending: MiniDailyDay?
        if let context {
            pending = ledger?.days.first { $0.id == context.pendingDayId }
        } else { pending = day }
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

    private func retainedGroups(_ context: MiniPlanContext) -> some View {
        DisclosureGroup(isExpanded: $showingRetainedGroups) {
            VStack(alignment: .leading, spacing: 5) {
                ForEach(context.pendingGroups) { group in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(group.label + (ledger?.days.first { $0.id == group.dayId }?.flow == nil ? " · 旧流程" : "")).font(.caption)
                        Spacer(minLength: 3)
                        if group.canContinue, let continueGroup {
                            Button("继续") { continueGroup(group.dayId) }
                                .font(.caption)
                                .disabled(saving)
                        } else {
                            Text("进度保留").font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                    if let reason = group.blockedReason {
                        Text(reason).font(.caption2).foregroundStyle(.secondary)
                    }
                }
            }
            .padding(.top, 3)
        } label: {
            HStack {
                Text("保留任务")
                Spacer(minLength: 4)
                Text("\(context.pendingGroups.count) 组").foregroundStyle(.secondary)
            }
        }
        .font(.caption)
        .accessibilityIdentifier("homeRetainedGroups")
    }

    @ViewBuilder
    private func homeActions(now: Date, calendar: Calendar) -> some View {
        if let context {
            if context.effective.mode == .rest {
                if let overrideRest {
                    Button("今天临时学一次", action: overrideRest)
                        .accessibilityIdentifier("overrideRestDay")
                }
            } else if context.recoverySuggested, context.canContinue || context.canStart, let startRecovery {
                Button("先恢复少量学习", action: startRecovery)
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("startRecoveryStudy")
                if context.pendingDayId != nil, context.canContinue {
                    Button("按原容量继续", action: start)
                }
            } else if hasLegacyReview || context.canContinue || context.canStart {
                Button(hasLegacyReview ? "继续复习" : (context.pendingDayId != nil ? "继续学习" : "开始学习"), action: start)
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("startDailyStudy")
            } else if let openPlan, context.blockedReason != nil {
                Button("调整学习计划", action: openPlan)
            }
        } else if let action = actionLabel(now: now, calendar: calendar) {
            Button(action, action: start)
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("startDailyStudy")
        }
    }

    private func actionLabel(now: Date, calendar: Calendar) -> String? {
        if hasLegacyReview { return "继续复习" }
        guard let day else { return error == nil ? (ledger == nil ? nil : "开始学习") : "重试读取" }
        let isToday = calendar.isDate(day.startedAt, inSameDayAs: now)
        if day.phase == .finished { return isToday ? nil : "开始今日任务" }
        if !isToday { return "继续学习" }
        return hasStarted(day) || day.paused ? "继续学习" : "开始学习"
    }

    private func hasStarted(_ day: MiniDailyDay) -> Bool {
        day.review?.judgmentEvents.isEmpty == false || day.review?.spellingAttempts.isEmpty == false
            || !day.studiedWords.isEmpty || !day.translation.isEmpty || day.flow?.window.events.isEmpty == false
    }

    private func activityStat(_ title: String, value: Int, unit: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.caption2).foregroundStyle(.secondary)
            Text("\(value) \(unit)")
                .font(.callout.monospacedDigit().weight(.semibold))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 5))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(title)
        .accessibilityValue("\(value) \(unit)")
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
                ForEach([0, 1, 5, 10, 20], id: \.self) { count in
                    RoundedRectangle(cornerRadius: 2).fill(activityColor(count)).frame(width: 8, height: 8)
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
                        activityCell(cell, size: cellSize)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func activityCell(_ cell: MiniActivityGrid.Day, size: CGFloat) -> some View {
        if cell.isPadding {
            Color.clear.frame(width: size, height: size).accessibilityHidden(true)
        } else {
            let date = cell.date.formatted(.dateTime.year().month().day().weekday())
            let description = cell.isFuture ? "日期尚未到来" : "\(cell.count) 次学习操作"
            RoundedRectangle(cornerRadius: 2)
                .fill(cell.isFuture ? Color.secondary.opacity(0.06) : activityColor(cell.count))
                .frame(width: size, height: size)
                .overlay {
                    if cell.isToday {
                        RoundedRectangle(cornerRadius: 2).strokeBorder(Color.primary.opacity(0.6), lineWidth: 0.75)
                    }
                }
                .help("\(date) · \(description)")
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(date)
                .accessibilityValue(description)
        }
    }

    private func activityColor(_ count: Int) -> Color {
        switch count {
        case 0: Color.secondary.opacity(0.16)
        case 1..<5: Color.blue.opacity(0.24)
        case 5..<10: Color.blue.opacity(0.45)
        case 10..<20: Color.blue.opacity(0.68)
        default: Color.blue
        }
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
        let isToday: Bool
        let isFuture: Bool
        let isPadding: Bool
    }

    let weeks: [Week]
    let activeDays: Int

    init(ledger: MiniDailyLedger, now: Date, calendar: Calendar) {
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
                guard let date = calendar.date(byAdding: .day, value: index * 7 + weekday, to: firstMonday) else { return nil }
                let isPadding = date < firstDate || date >= currentMonth.end
                return Day(date: date, count: counts[date, default: 0], isToday: date == today,
                           isFuture: date > today, isPadding: isPadding)
            }
            guard let first = days.first else { return nil }
            let monthStart = days.first { !$0.isPadding && calendar.component(.day, from: $0.date) == 1 }
            let month = monthStart.map { calendar.component(.month, from: $0.date) }
            return Week(id: first.date, month: month, days: days, isLast: index == weekCount - 1)
        }
        activeDays = counts.count
    }
}
