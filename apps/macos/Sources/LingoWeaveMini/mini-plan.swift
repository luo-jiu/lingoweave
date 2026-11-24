import Foundation

struct MiniPlanBudget: Codable, Equatable, Sendable {
    var wordLimit: Int
    var newWordLimit: Int
    var dailyNewGoal: Int? = nil
    var groupSize: Int? = nil

    var effectiveDailyGoal: Int { dailyNewGoal ?? newWordLimit }
    var effectiveGroupSize: Int { groupSize ?? 20 }
}

struct MiniLongTermPlan: Codable, Equatable, Sendable {
    var weekdays: [Int]
    var wordLimit: Int
    var newWordLimit: Int
    var dailyNewGoal: Int? = nil
    var groupSize: Int? = nil

    var budget: MiniPlanBudget { .init(wordLimit: wordLimit, newWordLimit: newWordLimit,
                                     dailyNewGoal: dailyNewGoal, groupSize: groupSize) }
}

enum MiniPlanMode: String, Codable, CaseIterable, Sendable {
    case normal, reviewOnly, rest

    var label: String {
        switch self {
        case .normal: "正常学习"
        case .reviewOnly: "只复习"
        case .rest: "新词休息日"
        }
    }
}

enum MiniStudyIntent: String, Codable, Sendable {
    case review, learn
}

struct MiniDailyPlanOverride: Codable, Equatable, Sendable {
    let date: String
    let timezone: String
    var mode: MiniPlanMode
    var wordLimit: Int
    var newWordLimit: Int
    var dailyNewGoal: Int? = nil
    var groupSize: Int? = nil

    var budget: MiniPlanBudget { .init(wordLimit: wordLimit, newWordLimit: newWordLimit,
                                     dailyNewGoal: dailyNewGoal, groupSize: groupSize) }
}

struct MiniPlanSession: Codable, Equatable, Sendable {
    let id: UUID
    let dayId: String
    let timezone: String
    let startedAt: Date
    let wordLimit: Int
    let newWordLimit: Int
    let servedWords: [MiniWord]
    let endedAt: Date?
    let pauseReason: String?
    var intent: MiniStudyIntent? = nil

    var budget: MiniPlanBudget { .init(wordLimit: wordLimit, newWordLimit: newWordLimit) }
}

struct MiniPlanningState: Codable, Equatable, Sendable {
    let longTerm: MiniLongTermPlan
    let dailyOverrides: [MiniDailyPlanOverride]
    let nextSessionOverride: MiniPlanBudget?
    let sessions: [MiniPlanSession]
    let activeDayId: String?

    var currentSession: MiniPlanSession? { sessions.last { $0.endedAt == nil } }
}

struct MiniPendingGroup: Codable, Equatable, Sendable {
    let dayId: String
    let phase: MiniDailyDay.Phase
    let paused: Bool
    let startedAt: Date
    let canContinue: Bool
    let blockedReason: String?
}

struct MiniEffectivePlan: Codable, Equatable, Sendable {
    let mode: MiniPlanMode
    let wordLimit: Int
    let newWordLimit: Int
    var dailyNewGoal: Int? = nil
    var groupSize: Int? = nil

    var budget: MiniPlanBudget { .init(wordLimit: wordLimit, newWordLimit: newWordLimit,
                                     dailyNewGoal: dailyNewGoal, groupSize: groupSize) }
}

struct MiniWordProgress: Codable, Equatable, Sendable {
    let lifetime: Int
    let bookId: String?
    let completed: Int
    let total: Int

    var fraction: Double { total > 0 ? min(1, Double(completed) / Double(total)) : 0 }
}

struct MiniPlanContext: Codable, Equatable, Sendable {
    enum ReviewContinuation { case activeReview, activeStudy, begin, home }
    let date: String
    let timezone: String
    let effective: MiniEffectivePlan
    let todayOverride: MiniDailyPlanOverride?
    let dueCount: Int
    let newCount: Int
    let lastActivityAt: Date?
    let absenceDays: Int
    let recoverySuggested: Bool
    let recoveryWordLimit: Int
    let pendingDayId: String?
    let pendingGroups: [MiniPendingGroup]
    let canStart: Bool
    let canContinue: Bool
    let blockedReason: String?
    var completedNewCount: Int? = nil
    var wordProgress: MiniWordProgress? = nil
    var remainingNewCount: Int? = nil
    var hasDueReviews: Bool? = nil
    var todayCompleted: Bool? = nil
    var canStartExtraGroup: Bool? = nil
    var extraGroupWordCount: Int? = nil
    var activeExtraGroupWordCount: Int? = nil
    var canStartReview: Bool? = nil
    var canStartLearning: Bool? = nil

    var reviewAvailable: Bool {
        canStartReview ?? (dueCount > 0 || hasDueReviews == true || hasPendingReview)
    }

    var hasPendingReview: Bool { pendingGroups.contains { $0.phase == .review && $0.canContinue } }
    var hasPendingLearning: Bool {
        pendingGroups.contains { ($0.phase == .learning || $0.phase == .translation) && $0.canContinue }
    }

    var learningAvailable: Bool {
        canStartLearning ?? (effective.mode == .normal &&
            (hasPendingLearning || ((remainingNewCount ?? effective.budget.effectiveDailyGoal) > 0 && newCount > 0 && canStart)))
    }

    var showsExtraLearning: Bool {
        !learningAvailable && effective.mode != .reviewOnly &&
            (canStartExtraGroup == true || effective.mode == .rest || todayCompleted == true)
    }

    var learningButtonTitle: String {
        if effective.mode == .reviewOnly { return "学新词 0" }
        if let size = activeExtraGroupWordCount { return "加练 \(size)" }
        if showsExtraLearning {
            return extraGroupWordCount.map { "加练 \($0)" } ?? "加练"
        }
        if effective.mode == .rest { return "加练" }
        return "学新词 \(effective.budget.effectiveDailyGoal)"
    }

    var todayBudgetForEditing: MiniPlanBudget {
        var budget = todayOverride?.budget ?? effective.budget
        budget.groupSize = budget.groupSize ?? effective.groupSize
        budget.dailyNewGoal = budget.dailyNewGoal ?? effective.dailyNewGoal
        return budget
    }

    func includesDate(_ time: Date) -> Bool {
        guard let zone = TimeZone(identifier: timezone) else { return false }
        return time.formatted(Date.ISO8601FormatStyle(timeZone: zone).year().month().day()) == date
    }

    func matchesLocalDay(at time: Date, in zone: TimeZone) -> Bool {
        timezone == zone.identifier && includesDate(time)
    }

    var dayInterval: DateInterval? {
        guard let zone = TimeZone(identifier: timezone),
              let start = try? Date.ISO8601FormatStyle(timeZone: zone).year().month().day().parse(date)
        else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        return calendar.dateInterval(of: .day, for: start)
    }

    func includesDay(_ day: MiniDailyDay) -> Bool {
        day.archivedAt == nil && (day.flow?.targetDate ?? String(day.id.prefix(10))) == date
    }

    func reviewGroupIndex(for day: MiniDailyDay, in ledger: MiniDailyLedger) -> Int? {
        guard day.phase == .review, includesDay(day),
              let index = ledger.days.firstIndex(where: { $0.id == day.id }) else { return nil }
        return 1 + ledger.days[..<index].count { includesDay($0) && !$0.reviewWords.isEmpty }
    }

    var hasTaskAfterReview: Bool {
        if canStartReview != nil || canStartLearning != nil { return reviewAvailable || learningAvailable }
        guard canStart || canContinue else { return false }
        switch effective.mode {
        case .normal: return true
        case .reviewOnly:
            return dueCount > 0 || hasDueReviews == true ||
                pendingGroups.contains { $0.dayId == pendingDayId && $0.phase == .review && $0.canContinue }
        case .rest: return false
        }
    }

    func afterCompletingReview(activePhase: MiniDailyDay.Phase?, intent: MiniStudyIntent = .learn) -> ReviewContinuation {
        if activePhase == .review { return .activeReview }
        if intent == .review { return reviewAvailable ? .begin : .home }
        if hasDueReviews == true || dueCount > 0 { return hasTaskAfterReview ? .begin : .home }
        if effective.mode != .reviewOnly, activePhase == .learning || activePhase == .translation {
            return .activeStudy
        }
        return hasTaskAfterReview ? .begin : .home
    }
}
