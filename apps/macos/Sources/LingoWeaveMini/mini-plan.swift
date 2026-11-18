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
        case .rest: "今天不学"
        }
    }
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

struct MiniPendingGroup: Codable, Equatable, Sendable, Identifiable {
    var id: String { dayId }
    let dayId: String
    let phase: MiniDailyDay.Phase
    let paused: Bool
    let startedAt: Date
    let canContinue: Bool
    let blockedReason: String?

    var label: String {
        let stage: String
        switch phase {
        case .review: stage = "复习"
        case .learning: stage = "新词"
        case .translation: stage = "写作"
        case .finished: stage = "已完成"
        }
        return startedAt.formatted(.dateTime.month(.defaultDigits).day()) + " · " + stage
    }
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

struct MiniPlanContext: Codable, Equatable, Sendable {
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
    var remainingNewCount: Int? = nil
    var hasDueReviews: Bool? = nil
}
