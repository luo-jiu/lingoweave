import Foundation

struct MiniAssessmentJob: Decodable, Sendable, Identifiable {
    enum Status: String, Decodable, Sendable {
        case queued, running, completed, failed
        var label: String {
            switch self {
            case .queued: "等待评价"
            case .running: "正在评价"
            case .completed: "已评价"
            case .failed: "评价失败"
            }
        }
    }
    struct Receipt: Decodable, Sendable {
        struct Scheduling: Decodable, Sendable {
            let beforeDueAt: Date?
            let afterDueAt: Date?
            let reasons: [String]?
        }
        let disposition: String
        let reason: String
        let scheduling: Scheduling
    }
    let id: UUID
    let word: MiniWord
    let status: Status
    let updatedAt: Date
    let error: String?
    let receipt: Receipt?
}

struct MiniAssessmentSnapshot: Decodable, Sendable {
    let schemaVersion: Int
    let pendingCount: Int
    let runningCount: Int
    let failedCount: Int
    let jobs: [MiniAssessmentJob]
    var processingCount: Int { pendingCount + runningCount }
}

struct MiniAssessmentDetail: Decodable, Sendable {
    struct Source: Decodable, Sendable {
        struct Question: Decodable, Sendable {
            let direction: MiniTranslationDirection
            let english: String
            let chinese: String
        }
        struct Discussion: Decodable, Sendable, Identifiable {
            let id: UUID
            let role: String
            let text: String
        }
        let question: Question
        let answer: String
        let submittedAt: Date
        let discussion: [Discussion]
    }
    struct Application: Decodable, Sendable {
        struct Observation: Decodable, Sendable {
            let outcome: String
            let explanation: String
        }
        struct Result: Decodable, Sendable {
            let meaning: Observation
            let spelling: Observation
            let usage: Observation
            let summary: String
            let strengths: [String]
            let improvements: [String]
            let referenceTranslation: String
            let uncertainties: [String]
        }
        struct Trace: Decodable, Sendable {
            let model: String
            let effort: String
            let rulesVersion: String
            let assessedAt: Date
        }
        let result: Result
        let trace: Trace
    }
    let job: MiniAssessmentJob
    let source: Source
    let application: Application?
}

struct MiniAssessmentClient: Sendable {
    let study: MiniStudyClient
    func translations(date: String, timezone: String) async throws -> MiniTranslationReview {
        try await study.serviceRequest(path: "translations/review", body: nil, query: [
            URLQueryItem(name: "date", value: date), URLQueryItem(name: "timezone", value: timezone)
        ])
    }
    func gradeMissing(date: String, timezone: String) async throws -> MiniTranslationReview {
        struct Request: Encodable { let date: String; let timezone: String }
        return try await study.serviceRequest(path: "translations/review/grade-missing",
            body: JSONEncoder().encode(Request(date: date, timezone: timezone)))
    }
    func snapshot() async throws -> MiniAssessmentSnapshot {
        try await study.serviceRequest(path: "assessments/snapshot", body: nil)
    }
    func detail(_ id: UUID) async throws -> MiniAssessmentDetail {
        try await study.serviceRequest(path: "assessments/" + id.uuidString.lowercased(), body: nil)
    }
    func retry(_ id: UUID, requestId: UUID) async throws -> MiniAssessmentJob {
        struct Request: Encodable { let requestId: String; let jobId: String }
        return try await study.serviceRequest(path: "assessments/retry", body: JSONEncoder().encode(
            Request(requestId: requestId.uuidString.lowercased(), jobId: id.uuidString.lowercased())))
    }
}

struct MiniTranslationReview: Decodable, Sendable {
    enum ExpressionGrade: String, Decodable, Sendable {
        case natural, understandable
        case offMeaning = "off_meaning"
    }
    enum Verdict: String {
        case correct = "翻译正确", natural = "表达地道", understandable = "可以润色", offMeaning = "偏离原意"
        var description: String {
            switch self {
            case .correct: "译文传达了原文的意思。"
            case .natural: "表达自然，保持这样的写法即可。"
            case .understandable: "意思传达清楚，措辞还可以更自然。"
            case .offMeaning: "译文偏离原意，需要重新对照原题。"
            }
        }
    }
    enum ExpressionGradeStatus: String, Decodable, Sendable { case queued, failed }

    struct Commentary: Decodable, Sendable {
        let summary: String
        let strengths: [String]
        let improvements: [String]
        let keyPoints: [String]
        let referenceTranslation: String
    }

    struct Entry: Decodable, Identifiable, Sendable {
        enum Status: String, Decodable, Sendable {
            case submitted, queued, running, failed, ready

            var label: String {
                switch self {
                case .submitted: "已提交"
                case .queued: "等待点评"
                case .running: "点评中"
                case .failed: "待重试"
                case .ready: "已点评"
                }
            }
        }
        let attemptId: UUID
        let word: MiniWord
        let direction: MiniTranslationDirection
        let question: String
        let answer: String
        let submittedAt: Date
        let status: Status
        let commentary: Commentary?
        let retryJobId: UUID?
        var expressionGrade: ExpressionGrade? = nil
        var expressionGradeStatus: ExpressionGradeStatus? = nil
        var id: UUID { attemptId }
        var directionLabel: String { direction == .englishToChinese ? "英译中" : "中译英" }
        var verdict: Verdict? {
            switch expressionGrade {
            case .natural: direction == .englishToChinese ? .correct : .natural
            case .understandable: direction == .englishToChinese ? nil : .understandable
            case .offMeaning: .offMeaning
            case nil: nil
            }
        }
        var needsMeaningGrade: Bool {
            direction == .englishToChinese && status == .ready && verdict == nil
        }
        var visibleCommentary: Commentary? { needsMeaningGrade ? nil : commentary }
        var alternativeChineseTranslation: String? {
            guard verdict == .correct, let reference = visibleCommentary?.referenceTranslation else { return nil }
            let ignored = CharacterSet.punctuationCharacters.union(.whitespacesAndNewlines)
            let letters = reference.unicodeScalars.filter { !ignored.contains($0) }
            let original = answer.unicodeScalars.filter { !ignored.contains($0) }
            guard !letters.isEmpty, !letters.elementsEqual(original) else { return nil }
            return reference
        }
        var canGradeExpression: Bool {
            status == .ready && verdict == nil && expressionGradeStatus != .queued
        }
    }
    let date: String
    let timezone: String
    let entries: [Entry]
    var processing: Bool {
        entries.contains { $0.status == .queued || $0.status == .running || $0.expressionGradeStatus == .queued }
    }
    var retryableJobs: [UUID] { entries.filter { $0.status == .failed }.compactMap(\.retryJobId) }

    static func dateKey(_ date: Date, timezone: TimeZone) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timezone
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }
}

/// Static UI examples only; no runtime, learning command or score is submitted.
struct MiniAssessmentPreview {
    let snapshot: MiniAssessmentSnapshot
    let detail: MiniAssessmentDetail

    #if DEBUG
    static func make(_ stage: MiniDevStage) -> Self? {
        let status: MiniAssessmentJob.Status
        switch stage {
        case .translationGrading: status = .running
        case .translationError: status = .failed
        case .translationFeedback: status = .completed
        default: return nil
        }
        let job = MiniAssessmentJob(id: UUID(), word: MiniWord.starter[0], status: status, updatedAt: .now,
                                    error: status == .failed ? "开发预览：评价连接中断，已保存的原答不受影响。" : nil, receipt: nil)
        let source = MiniAssessmentDetail.Source(question: .init(direction: .englishToChinese,
                                                                  english: "She eats an apple after lunch.", chinese: "她午饭后吃一个苹果。"),
                                                  answer: "她在午饭后吃了一个苹果。", submittedAt: .now, discussion: [])
        let observation = MiniAssessmentDetail.Application.Observation(outcome: "uncertain", explanation: "开发预览示例，正式评价会引用已保存的学习证据。")
        let application = MiniAssessmentDetail.Application(result: .init(meaning: observation, spelling: observation, usage: observation,
                                                                          summary: "开发预览：原答、评价理由和采用结果会在这里保存供追溯。", strengths: [], improvements: [],
                                                                          referenceTranslation: "她午饭后吃一个苹果。", uncertainties: []),
                                                            trace: .init(model: "开发示例", effort: "xhigh", rulesVersion: "mini-assessment-v1", assessedAt: .now))
        return Self(snapshot: .init(schemaVersion: 1, pendingCount: 0, runningCount: status == .running ? 1 : 0,
                                    failedCount: status == .failed ? 1 : 0, jobs: [job]),
                    detail: .init(job: job, source: source, application: status == .completed ? application : nil))
    }
    #endif
}
