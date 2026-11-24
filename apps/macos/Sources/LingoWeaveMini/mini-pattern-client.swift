import Foundation

struct MiniPatternStartIntent: Equatable {
    var dayId: String?
    var entry: MiniStudyIntent = .learn
    var extraGroupForDate: String? = nil

    func offersIntroduction(_ context: MiniPlanContext?) -> Bool {
        guard let context, entry == .learn, dayId == nil, !context.reviewAvailable,
              context.effective.mode != .reviewOnly else { return false }
        if let extraGroupForDate { return extraGroupForDate == context.date && context.canStartExtraGroup == true }
        return context.effective.mode == .normal && context.pendingDayId == nil &&
            context.learningAvailable && context.newCount > 0
    }
}

struct MiniSentencePattern: Decodable, Identifiable, Sendable {
    let id: String
    let level: String
    let frame: String
    let meaning: String
    let example: String
    let translation: String
    let cue: String
    let substitution: String
}

struct MiniPatternBatch: Decodable, Sendable {
    let date: String
    let level: String
    let batchId: String
    let batch: [MiniSentencePattern]
    let completedIds: [String]
    let practicedCount: Int
    let totalCount: Int
    let canDialogue: Bool
    var next: MiniSentencePattern? { batch.first { !completedIds.contains($0.id) } }
}

struct MiniPatternResult: Decodable, Sendable {
    let correct: Bool
    let reference: String
    let snapshot: MiniPatternBatch
}

struct MiniPatternSubmission: Encodable, Sendable {
    var requestId = UUID().uuidString.lowercased()
    var timezone = TimeZone.current.identifier
    let batchId: String
    let patternId: String
    let answer: String
    let usedHint: Bool
    let continueAfterFeedback: Bool
}

struct MiniPatternClient: Sendable {
    var study = MiniStudyClient()
    func batch(timezone: String = TimeZone.current.identifier) async throws -> MiniPatternBatch {
        try await study.serviceRequest(path: "patterns", body: nil, query: [.init(name: "timezone", value: timezone)])
    }
    func practice(_ payload: MiniPatternSubmission) async throws -> MiniPatternResult {
        try await study.serviceRequest(path: "patterns/practice", body: JSONEncoder().encode(payload))
    }
    func recordView(batchId: String, patternId: String, timezone: String = TimeZone.current.identifier) async throws {
        struct Receipt: Decodable, Sendable { let recorded: Bool }
        let body = ["batchId": batchId, "patternId": patternId, "timezone": timezone]
        let _: Receipt = try await study.serviceRequest(path: "patterns/view", body: JSONEncoder().encode(body))
    }

    func learnedPatterns(query: String = "", offset: Int = 0, limit: Int = 50) async throws -> MiniPhrasePage {
        try await phrases(query: query, kind: .pattern, offset: offset, limit: limit)
    }

    func phrases(query: String = "", kind: MiniLearnedPhrase.Kind? = nil, offset: Int = 0,
                 limit: Int = 50) async throws -> MiniPhrasePage {
        var items = [URLQueryItem(name: "offset", value: String(offset)), .init(name: "limit", value: String(limit))]
        if !query.isEmpty { items.append(.init(name: "q", value: query)) }
        if let kind { items.append(.init(name: "kind", value: kind.rawValue)) }
        return try await study.serviceRequest(path: "phrases", body: nil, query: items)
    }
}

struct MiniPhrasePage: Decodable, Sendable {
    let total: Int
    let items: [MiniLearnedPhrase]
}

struct MiniLearnedPhrase: Decodable, Identifiable, Sendable {
    enum Kind: String, Decodable, Sendable {
        case pattern, focus, sentence, feedback
    }
    enum Status: String, Decodable, Sendable {
        case viewed, attempted, practiced, encountered, feedback
    }
    let id: String
    let kind: Kind
    let status: Status
    let expression: String
    let explanation: String?
    let exampleEnglish: String?
    let exampleChinese: String?
    let words: [String]
    let lastSeenAt: Date

    var patternStatusLabel: String? {
        switch status {
        case .viewed: return "看过"
        case .attempted: return "尝试过"
        case .practiced: return "练过"
        case .encountered, .feedback: return nil
        }
    }
}
