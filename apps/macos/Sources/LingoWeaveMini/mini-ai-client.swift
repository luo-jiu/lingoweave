import Foundation

struct MiniAIReceipt: Decodable, Sendable, Identifiable {
    let requestId: UUID
    let tool: String
    let revision: Int
    let summary: String
    var id: UUID { requestId }
}

struct MiniAIJob: Decodable, Sendable, Identifiable {
    enum Kind: String, Codable, Sendable { case prepare, writing, feedback, advisor }
    enum Status: String, Decodable, Sendable {
        case queued, running, completed, failed, cancelled, interrupted
        var isActive: Bool { self == .queued || self == .running }
        var label: String {
            switch self {
            case .queued: "等待处理"
            case .running: "正在处理"
            case .completed: "已完成"
            case .failed: "处理失败"
            case .cancelled: "已停止"
            case .interrupted: "已中断"
            }
        }
    }

    let id: UUID
    let requestId: UUID
    let kind: Kind
    let status: Status
    let dayId: String?
    let attemptId: UUID?
    let conversationId: String
    let model: String
    let effort: String
    let progress: String
    let text: String
    let receipts: [MiniAIReceipt]
    let error: String?
    let createdAt: Date
    let updatedAt: Date
    let threadId: String?
}

struct MiniAIMessage: Decodable, Sendable, Identifiable {
    let id: UUID
    let conversationId: String
    let role: MiniChatMessage.Role
    let text: String
    let createdAt: Date?
    let jobId: UUID?
}

struct MiniAIConversation: Decodable, Sendable, Identifiable {
    let id: String
    let title: String
    let word: MiniWord?
}

struct MiniAISnapshot: Decodable, Sendable {
    let schemaVersion: Int
    let revision: Int
    let imported: Bool
    let conversations: [MiniAIConversation]
    let messages: [MiniAIMessage]
    let jobs: [MiniAIJob]
}

struct MiniAIStart: Codable, Sendable {
    let requestId: UUID
    let kind: MiniAIJob.Kind
    let timezone: String
    var dayId: String? = nil
    var attemptId: UUID? = nil
    var word: MiniWord? = nil
    let conversationId: String
    var message: String? = nil
    let model: String
    let effort: String

    private enum CodingKeys: String, CodingKey {
        case requestId, kind, timezone, dayId, attemptId, word, conversationId, message, model, effort
    }

    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(requestId.uuidString.lowercased(), forKey: .requestId)
        try values.encode(kind, forKey: .kind)
        try values.encode(timezone, forKey: .timezone)
        try values.encodeIfPresent(dayId, forKey: .dayId)
        try values.encodeIfPresent(attemptId?.uuidString.lowercased(), forKey: .attemptId)
        try values.encodeIfPresent(word, forKey: .word)
        try values.encode(conversationId, forKey: .conversationId)
        try values.encodeIfPresent(message, forKey: .message)
        try values.encode(model, forKey: .model)
        try values.encode(effort, forKey: .effort)
    }

    init(requestId: UUID = UUID(), kind: MiniAIJob.Kind, timezone: String = TimeZone.current.identifier,
         dayId: String? = nil, attemptId: UUID? = nil, word: MiniWord? = nil,
         conversationId: String = "advisor", message: String? = nil,
         model: String = "gpt-6.1-sol", effort: String = "xhigh") {
        self.requestId = requestId
        self.kind = kind
        self.timezone = timezone
        self.dayId = dayId
        self.attemptId = attemptId
        self.word = word
        self.conversationId = conversationId
        self.message = message
        self.model = model
        self.effort = effort
    }
}

struct MiniAIImport: Codable, Sendable {
    struct Conversation: Codable, Sendable {
        let id: String
        let title: String
        let word: MiniWord?
        let messages: [MiniChatMessage]
    }
    let requestId: UUID
    let conversations: [Conversation]
}

struct MiniAIClient: Sendable {
    private let study: MiniStudyClient

    init(study: MiniStudyClient = MiniStudyClient()) { self.study = study }

    func snapshot() async throws -> MiniAISnapshot {
        let snapshot: MiniAISnapshot = try await study.serviceRequest(path: "ai/snapshot", body: nil)
        guard snapshot.schemaVersion == 1 else { throw MiniStudyClientError.invalidResponse }
        return snapshot
    }

    func runtime() async throws -> MiniChatRuntime {
        try await study.serviceRequest(path: "ai/runtime", body: nil)
    }

    func start(_ request: MiniAIStart) async throws -> MiniAIJob {
        try await study.serviceRequest(path: "ai/start", body: JSONEncoder().encode(request))
    }

    func job(_ id: UUID) async throws -> MiniAIJob {
        try await study.serviceRequest(path: "ai/jobs/" + id.uuidString.lowercased(), body: nil)
    }

    func cancel(_ id: UUID) async throws -> MiniAIJob { try await control(path: "cancel", id: id) }
    func retry(_ id: UUID) async throws -> MiniAIJob { try await control(path: "retry", id: id) }

    private func control(path: String, id: UUID) async throws -> MiniAIJob {
        struct Control: Encodable { let requestId: String; let jobId: String }
        return try await study.serviceRequest(path: "ai/" + path,
                                              body: JSONEncoder().encode(Control(requestId: UUID().uuidString.lowercased(),
                                                                                jobId: id.uuidString.lowercased())))
    }

    func importLegacy(_ payload: MiniAIImport) async throws -> MiniAISnapshot {
        try await study.serviceRequest(path: "ai/import", body: JSONEncoder().encode(payload))
    }

    func clear(conversationId: String) async throws -> MiniAISnapshot {
        struct Clear: Encodable { let requestId: UUID; let conversationId: String }
        return try await study.serviceRequest(path: "ai/clear",
                                              body: JSONEncoder().encode(Clear(requestId: UUID(), conversationId: conversationId)))
    }
}
