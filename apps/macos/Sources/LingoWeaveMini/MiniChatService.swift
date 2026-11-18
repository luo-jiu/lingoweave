import Foundation

/// Kept only to decode the original per-word chat archive during migration.
struct MiniChatMessage: Codable, Identifiable, Sendable {
    let id: UUID
    let role: Role
    let text: String

    enum Role: String, Codable, Sendable { case user, assistant }

    init(id: UUID = UUID(), role: Role, text: String) {
        self.id = id
        self.role = role
        self.text = text
    }
}

struct MiniChatModel: Decodable, Identifiable, Sendable {
    let id: String
    let name: String
    let supportedReasoningEfforts: [String]?
    let defaultReasoningEffort: String?

    var efforts: [String] { supportedReasoningEfforts ?? [] }
    var defaultEffort: String? { defaultReasoningEffort }
}

struct MiniChatRuntime: Decodable, Sendable {
    let available: Bool
    let authenticated: Bool
    let models: [MiniChatModel]
    let error: String?
}

/// Runtime discovery uses the same authenticated Node service as all AI jobs.
struct MiniChatService: Sendable {
    private let client: MiniAIClient

    init(client: MiniAIClient = MiniAIClient()) { self.client = client }

    func runtime() async throws -> MiniChatRuntime { try await client.runtime() }
}
