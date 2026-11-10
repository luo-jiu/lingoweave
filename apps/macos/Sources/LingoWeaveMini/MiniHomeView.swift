import SwiftUI

struct MiniHomeView: View {
    let day: MiniDailyDay?
    let ledger: MiniDailyLedger?
    let start: () -> Void
    var error: String? = nil
    var hasLegacyReview = false

    var body: some View {
        let calendar = Calendar.current
        let now = Date.now
        let activity = ledger.map { MiniActivityGrid(ledger: $0, now: now, calendar: calendar) }

        VStack(spacing: 8) {
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    plan(now: now, calendar: calendar)
                    if let activity {
                        heatmap(activity)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 1)
                .padding(.bottom, 2)
            }

            if let action = actionLabel(now: now, calendar: calendar) {
                Button(action, action: start)
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("startDailyStudy")
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("miniHome")
    }

    @ViewBuilder
    private func plan(now: Date, calendar: Calendar) -> some View {
        if let day {
            let isToday = calendar.isDate(day.startedAt, inSameDayAs: now)
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(isToday ? "今日学习" : "上次任务")
                        .font(.headline)
                    Spacer(minLength: 4)
                    Text(planStatus(day, isToday: isToday))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                if day.translationCount > 0 {
                    HStack(spacing: 6) {
                        progressStat("复习", done: passedWords(day.review), total: day.reviewWords.count, unit: "词")
                        progressStat("新词", done: passedWords(day.learning), total: day.learningWords.count, unit: "词")
                        progressStat("翻译", done: day.translation.count { $0.feedback != nil }, total: day.translationCount, unit: "题")
                    }
                }
            }
        } else {
            VStack(alignment: .leading, spacing: 4) {
                Text("今日学习").font(.headline)
                if let error {
                    Text(error).font(.caption).foregroundStyle(.secondary)
                } else if ledger == nil {
                    ProgressView("读取本机学习记录…").controlSize(.small)
                } else {
                    Text("还没有今日任务").font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }

    private func planStatus(_ day: MiniDailyDay, isToday: Bool) -> String {
        if day.translationCount == 0 { return isToday ? "暂无待学或待复习的词" : "暂无学习任务" }
        if day.phase == .finished { return "已完成" }
        if day.paused { return "已暂停" }
        if !isToday { return day.startedAt.formatted(.dateTime.month(.defaultDigits).day()) + " · 未完成" }
        if hasStarted(day) { return "进行中" }
        return "待开始"
    }

    private func actionLabel(now: Date, calendar: Calendar) -> String? {
        if hasLegacyReview { return "继续复习" }
        guard let day else { return error == nil ? (ledger == nil ? nil : "开始学习") : "重试读取" }
        let isToday = calendar.isDate(day.startedAt, inSameDayAs: now)
        if day.phase == .finished { return isToday ? nil : "开始今日任务" }
        if !isToday { return "继续上次任务" }
        return hasStarted(day) || day.paused ? "继续学习" : "开始学习"
    }

    private func hasStarted(_ day: MiniDailyDay) -> Bool {
        day.review?.judgmentEvents.isEmpty == false || day.review?.spellingAttempts.isEmpty == false
            || !day.studiedWords.isEmpty || !day.translation.isEmpty
    }

    private func passedWords(_ session: MiniReviewSession?) -> Int {
        guard let session, session.phase != .judgment else { return 0 }
        return session.totalCount - session.remainingCount
    }

    private func progressStat(_ title: String, done: Int, total: Int, unit: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.caption2).foregroundStyle(.secondary)
            Text("\(done)/\(total)")
                .font(.callout.monospacedDigit().weight(.semibold))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 5))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(title)
        .accessibilityValue("已完成 \(done) \(unit)，共 \(total) \(unit)")
    }

    private func heatmap(_ activity: MiniActivityGrid) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text("学习记录").font(.subheadline.weight(.semibold))
                Spacer(minLength: 4)
                Text(activity.activeDays == 0 ? "近 4 个月无学习记录" : "近 4 个月活跃 \(activity.activeDays) 天")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

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
            for exposure in day.studiedWords { count(exposure.at) }
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
