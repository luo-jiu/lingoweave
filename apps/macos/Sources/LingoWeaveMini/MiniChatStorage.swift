import CryptoKit
import Foundation

/// Only immutable migration copies, unconfirmed requests and drafts remain local.
struct MiniChatStorage {
    private let directory: URL

    init(directory: URL? = nil) {
        self.directory = directory ?? URL.applicationSupportDirectory
            .appending(path: Bundle.main.bundleIdentifier ?? "com.lingoweave.mini", directoryHint: .isDirectory)
    }

    static func conversationId(for word: MiniWord?) -> String {
        guard let word else { return "advisor" }
        let spelling = word.spelling.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let meaning = word.meaning.trimmingCharacters(in: .whitespacesAndNewlines)
        let digest = SHA256.hash(data: Data((spelling + "\u{0}" + meaning).utf8))
        return "word-" + digest.map { String(format: "%02x", $0) }.joined()
    }

    func prepareLegacyImport() throws -> MiniAIImport {
        let requestFile = directory.appending(path: "migration-backup/chat-import-request.json")
        if let data = try readIfPresent(requestFile) {
            return try JSONDecoder().decode(MiniAIImport.self, from: data)
        }
        let original = try readIfPresent(directory.appending(path: "StudyChat.json"))
        let chats = try original.map { try JSONDecoder().decode([MiniWord: [MiniChatMessage]].self, from: $0) } ?? [:]
        var grouped: [String: (word: MiniWord, messages: [MiniChatMessage])] = [:]
        for (word, messages) in chats.sorted(by: { $0.key.chatContext < $1.key.chatContext }) {
            let id = Self.conversationId(for: word)
            if var existing = grouped[id] {
                existing.messages.append(contentsOf: messages)
                grouped[id] = existing
            } else { grouped[id] = (word, messages) }
        }
        let conversations = grouped.map { id, group in
            MiniAIImport.Conversation(id: id, title: group.word.spelling,
                                      word: group.word, messages: group.messages)
        }.sorted { $0.id < $1.id }
        let payload = MiniAIImport(requestId: UUID(), conversations: conversations)
        if let original {
            let backup = directory.appending(path: "migration-backup/study-chat.json")
            if let existing = try readIfPresent(backup) {
                guard existing == original else { throw MiniStudyClientError.backupConflict }
            } else { try writePrivate(original, to: backup) }
        }
        try writePrivate(JSONEncoder().encode(payload), to: requestFile)
        return payload
    }

    func recordImportReceipt(_ snapshot: MiniAISnapshot) throws {
        struct Receipt: Encodable { let requestId: UUID; let revision: Int; let importedAt: Date }
        let request = try prepareLegacyImport()
        try writePrivate(JSONEncoder().encode(Receipt(requestId: request.requestId, revision: snapshot.revision,
                                                       importedAt: .now)),
                         to: directory.appending(path: "migration-backup/chat-import-receipt.json"))
    }

    func pendingRequest() throws -> MiniAIStart? {
        try readIfPresent(pendingFile).map { try JSONDecoder().decode(MiniAIStart.self, from: $0) }
    }

    func savePending(_ request: MiniAIStart) throws {
        if let existing = try pendingRequest(), existing.requestId != request.requestId {
            throw MiniStudyClientError.service("上次 AI 请求尚未确认，请先重试发送。")
        }
        try writePrivate(JSONEncoder().encode(request), to: pendingFile)
    }

    func clearPending(requestId: UUID) throws {
        guard try pendingRequest()?.requestId == requestId else { return }
        try FileManager.default.removeItem(at: pendingFile)
    }

    func loadDrafts() throws -> [String: String] {
        try readIfPresent(draftsFile).map { try JSONDecoder().decode([String: String].self, from: $0) } ?? [:]
    }

    func saveDrafts(_ drafts: [String: String]) throws { try writePrivate(JSONEncoder().encode(drafts), to: draftsFile) }

    private var pendingFile: URL { directory.appending(path: "service-client/pending-ai-request.json") }
    private var draftsFile: URL { directory.appending(path: "service-client/chat-drafts.json") }

    private func readIfPresent(_ file: URL) throws -> Data? {
        do { return try Data(contentsOf: file) }
        catch let error as CocoaError where error.code == .fileReadNoSuchFile || error.code == .fileNoSuchFile { return nil }
    }

    private func writePrivate(_ data: Data, to file: URL) throws {
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        try data.write(to: file, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    }
}
