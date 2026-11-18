import Foundation

struct MiniMemoryViewport: Equatable, Sendable {
    enum Preset: String, CaseIterable, Identifiable, Sendable {
        case month = "30 天", quarter = "90 天", halfYear = "180 天", overview = "总览"
        var id: String { rawValue }
        var days: Double {
            switch self { case .month: 30; case .quarter: 90; case .halfYear: 180; case .overview: 730 }
        }
    }
    var preset: Preset = .quarter
    var zoom = 1.0
    var offsetDays = 0.0
    var anchor = Date.now
    var spanDays: Double { max(7, min(730, preset.days / (zoom.isFinite ? min(8, max(1, zoom)) : 1))) }
    var range: ClosedRange<Date> {
        let offset = offsetDays.isFinite ? offsetDays : 0
        let pastFraction = preset == .overview ? 0.5 : 1.0 / 3
        let start = max(Date(timeIntervalSince1970: 0), anchor.addingTimeInterval((offset - spanDays * pastFraction) * 86400))
        return start...start.addingTimeInterval(spanDays * 86400)
    }
    var key: String { "\(range.lowerBound.timeIntervalSinceReferenceDate)/\(range.upperBound.timeIntervalSinceReferenceDate)" }
    mutating func pan(_ fraction: Double) { offsetDays += spanDays * fraction }
    mutating func reset(at: Date = .now) { anchor = at; zoom = 1; offsetDays = 0 }
    mutating func focus(_ date: Date) {
        let pastFraction = preset == .overview ? 0.5 : 1.0 / 3
        offsetDays = date.timeIntervalSince(anchor) / 86400 - spanDays * (0.5 - pastFraction)
    }
}

enum MiniMemoryDimension: String, CaseIterable, Identifiable, Sendable {
    case meaning = "词义", spelling = "拼写"
    var id: String { rawValue }
}

struct MiniMemoryWord: Decodable, Sendable, Identifiable {
    struct Ability: Decodable, Sendable {
        let retrievability: Double
        let stability: Double
        let difficulty: Double
        let lastReviewAt: Date
        let reps: Int
        let lapses: Int
    }
    enum Status: String, Decodable, Sendable {
        case learning, due, scheduled, unmeasured
        var label: String {
            switch self { case .learning, .unmeasured: "积累中"; case .due: "已到期"; case .scheduled: "已安排" }
        }
    }
    let senseId: String
    let word: MiniWord
    let source: String
    let status: Status
    let dueAt: Date?
    let idealDueAt: Date?
    let firstSeenAt: Date?
    let lastReviewAt: Date?
    let reviewCount: Int
    let meaning: Ability?
    let spelling: Ability?
    var id: String { senseId }
    func ability(_ dimension: MiniMemoryDimension) -> Ability? { dimension == .meaning ? meaning : spelling }
}

struct MiniMemoryOverview: Decodable, Sendable {
    struct Summary: Decodable, Sendable {
        let wordCount: Int
        let completedWordCount: Int
        let measuredWordCount: Int
        let dueCount: Int
        let scheduledCount: Int
        let learningCount: Int
        let excludedLegacyCount: Int
    }
    struct Load: Decodable, Sendable, Identifiable {
        let day: String
        let at: Date
        let count: Int
        var id: String { day }
    }
    let schemaVersion: Int
    let revision: Int
    let asOf: Date
    let timezone: String
    let from: Date
    let to: Date
    let notices: [String]
    let summary: Summary
    let words: [MiniMemoryWord]
    let load: [Load]
}

struct MiniMemoryDetail: Decodable, Sendable {
    struct Point: Decodable, Sendable {
        let at: Date
        let meaning: Double?
        let spelling: Double?
        let meaningSegment: String?
        let spellingSegment: String?
        let projected: Bool
        func value(_ dimension: MiniMemoryDimension) -> Double? { dimension == .meaning ? meaning : spelling }
        func segment(_ dimension: MiniMemoryDimension) -> String? { dimension == .meaning ? meaningSegment : spellingSegment }
    }
    struct Event: Decodable, Sendable, Identifiable {
        let id: String
        let kind: String
        let occurredAt: Date
        let recordedAt: Date
        let evidence: String
        let meaning: String?
        let spelling: String?
        let reasons: [String]
        var title: String {
            switch kind { case "completion": "完成学习"; case "review": "复习记录"; case "assessment": "学习评价"; case "probe": "独立检验"; default: "学习记录" }
        }
        var evidenceLabel: String {
            switch evidence { case "learning": "学习事实"; case "self_report": "本人自评"; case "objective": "作答证据"; case "model": "AI 评价"; default: "记录" }
        }
    }
    let schemaVersion: Int
    let revision: Int
    let asOf: Date
    let timezone: String
    let from: Date
    let to: Date
    let notices: [String]
    let word: MiniMemoryWord
    let points: [Point]
    let events: [Event]
    let downsampled: Bool
    let eventsTruncated: Bool
}

struct MiniMemoryClient: Sendable {
    struct Query: Encodable, Sendable {
        let timezone: String
        let from: Double
        let to: Double
        var senseId: String? = nil
        init(viewport: MiniMemoryViewport, timezone: String = TimeZone.current.identifier, senseId: String? = nil) {
            self.timezone = timezone
            from = viewport.range.lowerBound.timeIntervalSinceReferenceDate
            to = viewport.range.upperBound.timeIntervalSinceReferenceDate
            self.senseId = senseId
        }
    }
    let study: MiniStudyClient
    func overview(_ viewport: MiniMemoryViewport) async throws -> MiniMemoryOverview {
        let result: MiniMemoryOverview = try await study.serviceRequest(path: "memory/overview", body: JSONEncoder().encode(Query(viewport: viewport)))
        guard result.schemaVersion == 1 else { throw MiniStudyClientError.invalidResponse }
        return result
    }
    func detail(_ senseId: String, viewport: MiniMemoryViewport) async throws -> MiniMemoryDetail {
        let result: MiniMemoryDetail = try await study.serviceRequest(path: "memory/detail", body: JSONEncoder().encode(Query(viewport: viewport, senseId: senseId)))
        guard result.schemaVersion == 1, result.word.senseId == senseId else { throw MiniStudyClientError.invalidResponse }
        return result
    }
}
