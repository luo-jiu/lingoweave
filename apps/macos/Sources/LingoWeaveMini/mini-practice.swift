import Foundation

struct MiniDictationAttempt: Decodable, Sendable, Identifiable {
    let id: UUID
    let answer: String
    let correct: Bool
    let submittedAt: Date
}

struct MiniDictation: Decodable, Sendable, Identifiable {
    let id: UUID
    let target: MiniStudyAction.Target
    let dayId: String?
    let recordId: UUID?
    let session: MiniStudyAction.Session?
    let word: MiniWord
    let openedAt: Date
    let closedAt: Date?
    let revealedAt: Date?
    let attempts: [MiniDictationAttempt]
}

struct MiniPracticeSnapshot: Decodable, Sendable {
    let activeDictationId: UUID?
    let dictations: [MiniDictation]

    var activeDictation: MiniDictation? {
        dictations.last { $0.id == activeDictationId && $0.closedAt == nil }
    }
}

struct MiniMemoryCard: Decodable, Sendable, Identifiable {
    var id: String { senseId }
    let senseId: String
    let word: MiniWord
    let ability: String
    let introducedAt: Date
    let dueAt: Date
    let lastServedAt: Date?
    let nextProbeAt: Date?
    let practicePriority: Int?
    let priorityUpdatedAt: Date?
    let state: String
    let fsrs: MiniFsrsCard?
}

struct MiniFsrsCard: Decodable, Sendable {
    let due: Date
    let stability: Double
    let difficulty: Double
    let reps: Int
    let lapses: Int
    let state: Int
}

struct MiniProbe: Decodable, Sendable, Identifiable {
    enum Status: String, Decodable, Sendable { case active, answered, ended }
    let id: UUID
    let word: MiniWord
    let openedAt: Date
    let status: Status
    let endedAt: Date?
    let revealedAt: Date?
    let answer: String?
    let submittedAt: Date?
    let correct: Bool?
    let classification: MiniMeasurementClassification?
    let reason: String?
    let rating: String?
    let dueAt: Date?
}

struct MiniSchedulingSnapshot: Decodable, Sendable {
    let policyVersion: String
    let model: String
    let cards: [MiniMemoryCard]
    let probes: [MiniProbe]
    let activeProbeId: UUID?

    var activeProbe: MiniProbe? { probes.last { $0.id == activeProbeId && $0.status != .ended } }
    var orderedCards: [MiniMemoryCard] {
        cards.sorted {
            if $0.dueAt != $1.dueAt { return $0.dueAt < $1.dueAt }
            return $0.senseId < $1.senseId
        }
    }
}

enum MiniProbePrompt {
    static func text(for word: MiniWord) -> String? {
        let prompt = word.meaning.replacingOccurrences(of: #"[^\p{Han}\p{P}\p{N}\s]"#, with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines.union(.punctuationCharacters))
        return prompt.range(of: #"\p{Han}"#, options: .regularExpression) == nil ? nil : prompt
    }
}

enum MiniMeasurementClassification: String, Decodable, Sendable {
    case pendingReview = "pending_review"
    case unmeasured
    case supported
    case tooSoon = "too_soon"
    case independentSuccess = "independent_success"
    case independentFailure = "independent_failure"

    var label: String {
        switch self {
        case .pendingReview: "待核对"
        case .unmeasured: "尚未作答"
        case .supported: "有提示的练习"
        case .tooSoon: "距最近提示时间较短"
        case .independentSuccess: "独立回忆正确"
        case .independentFailure: "独立回忆需巩固"
        }
    }
}
