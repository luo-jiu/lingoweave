import Foundation

/// A read model of the server's versioned window. Native never advances this queue.
struct MiniMemoryWindow: Codable, Equatable, Sendable {
    struct Member: Codable, Equatable, Sendable {
        let word: MiniWord
        let stage: Int
        let admittedAt: Date
        let lastVisit: Int?
    }
    struct Visit: Codable, Equatable, Sendable, Identifiable {
        let id: UUID
        let word: MiniWord
        let stage: Int
        let openedAt: Date
        let initial: Bool?
        let selectedAt: Date?
        let revealedAt: Date?
        let correctedAt: Date?
        let draft: String

        var showsFullCard: Bool { stage == 0 || revealedAt != nil }
        var awaitingConfirmation: Bool { stage > 0 && initial != nil }
        var canCorrect: Bool { initial == true && correctedAt == nil }
        var willRemember: Bool { initial == true && correctedAt == nil }
        var advancesAutomatically: Bool { (stage == 0 && initial == true) || correctedAt != nil }
        var completedStages: Int {
            guard initial != nil else { return stage }
            return willRemember ? stage + 1 : 0
        }
    }
    struct Event: Codable, Equatable, Sendable, Identifiable {
        let id: UUID
        let word: MiniWord
        let stage: Int
        let openedAt: Date
        let initial: Bool?
        let selectedAt: Date?
        let revealedAt: Date?
        let correctedAt: Date?
        let draft: String
        let remembered: Bool
        let confirmedAt: Date
        let sequence: Int
    }
    let version: String
    let size: Int
    let gap: Int
    let members: [Member]
    let visit: Visit?
    let events: [Event]
    let sequence: Int
    let forceUnseen: Bool
}

struct MiniLearningFlow: Codable, Equatable, Sendable {
    struct Group: Codable, Equatable, Sendable, Identifiable {
        let id: UUID
        let index: Int
        let words: [MiniWord]
        let startedAt: Date
        let finishedAt: Date
        let spelling: MiniReviewSession
        let translationAttemptIds: [UUID]
    }
    struct Completion: Codable, Equatable, Sendable {
        let word: MiniWord
        let attemptId: UUID
        let at: Date
        let date: String
    }
    let version: String
    let targetDate: String
    let dailyNewGoal: Int
    let completedBeforeRun: Int
    let groupSize: Int
    let candidates: [MiniWord]
    let candidateIndex: Int
    let window: MiniMemoryWindow
    let groupId: UUID
    let groupIndex: Int
    let groupStartedAt: Date
    let groupTarget: Int
    let groupWords: [MiniWord]
    let translationWords: [MiniWord]
    let groups: [Group]
    let completed: [Completion]
    let goalReached: Bool
}
