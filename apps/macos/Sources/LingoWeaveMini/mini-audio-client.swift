import Foundation

enum MiniAudioTarget: Codable, Equatable, Sendable {
    case word(MiniWord)
    case sentence(MiniStudySentence)

    private enum CodingKeys: String, CodingKey { case kind, word, sentence }
    private enum Kind: String, Codable { case word, sentence }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        switch try values.decode(Kind.self, forKey: .kind) {
        case .word: self = .word(try values.decode(MiniWord.self, forKey: .word))
        case .sentence: self = .sentence(try values.decode(MiniStudySentence.self, forKey: .sentence))
        }
    }

    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .word(let word):
            try values.encode(Kind.word, forKey: .kind)
            try values.encode(word, forKey: .word)
        case .sentence(let sentence):
            try values.encode(Kind.sentence, forKey: .kind)
            try values.encode(sentence, forKey: .sentence)
        }
    }

    var word: MiniWord {
        switch self { case .word(let word): word; case .sentence(let sentence): sentence.word }
    }

    /// Only a local request coalescing key; asset identity is assigned by the server.
    var requestKey: String {
        let word = word
        let identity = [word.spelling.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
                        word.meaning.trimmingCharacters(in: .whitespacesAndNewlines), word.phonetic]
        switch self {
        case .word: return String(reflecting: ["word"] + identity)
        case .sentence(let sentence): return String(reflecting: ["sentence"] + identity + [sentence.english])
        }
    }
}

enum MiniAudioContext: Codable, Equatable, Sendable {
    case daily(dayId: String, session: MiniStudyAction.Session?)
    case translation(dayId: String, taskId: String)
    case review(recordId: UUID)
    private enum CodingKeys: String, CodingKey { case target, dayId, recordId, session, taskId }
    private enum Target: String, Codable { case daily, review }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        switch try values.decode(Target.self, forKey: .target) {
        case .daily:
            let dayId = try values.decode(String.self, forKey: .dayId)
            if let taskId = try values.decodeIfPresent(String.self, forKey: .taskId) {
                self = .translation(dayId: dayId, taskId: taskId)
            } else {
                self = .daily(dayId: dayId, session: try values.decodeIfPresent(MiniStudyAction.Session.self, forKey: .session))
            }
        case .review: self = .review(recordId: try values.decode(UUID.self, forKey: .recordId))
        }
    }

    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .translation(let dayId, let taskId):
            try values.encode(Target.daily, forKey: .target)
            try values.encode(dayId, forKey: .dayId)
            try values.encode(taskId, forKey: .taskId)
        case .daily(let dayId, let session):
            try values.encode(Target.daily, forKey: .target)
            try values.encode(dayId, forKey: .dayId)
            try values.encodeIfPresent(session, forKey: .session)
        case .review(let recordId):
            try values.encode(Target.review, forKey: .target)
            try values.encode(recordId.uuidString.lowercased(), forKey: .recordId)
            try values.encode(MiniStudyAction.Session.review, forKey: .session)
        }
    }
}

struct MiniAudioAsset: Decodable, Sendable, Identifiable {
    let id: UUID
    let targetKey: String
    let target: MiniAudioTarget
    let text: String
    let voice: String
    let durationSeconds: Double
}

struct MiniAudioJob: Decodable, Sendable, Identifiable {
    enum Status: String, Decodable, Sendable {
        case queued, running, completed, failed, interrupted
        var isActive: Bool { self == .queued || self == .running }
    }
    let id: UUID
    let target: MiniAudioTarget
    let status: Status
    let progress: String
    let error: String?
    let assetId: UUID?
}

struct MiniAudioResult: Decodable, Sendable {
    let targetKey: String
    let asset: MiniAudioAsset?
    let job: MiniAudioJob?
    let reused: Bool
}

struct MiniAudioSnapshot: Decodable, Sendable {
    let schemaVersion: Int
    let revision: Int
    let assets: [MiniAudioAsset]
    let jobs: [MiniAudioJob]
    let playbacks: [MiniAudioPlaybackReceipt]
}

struct MiniAudioPlaybackReceipt: Decodable, Sendable, Identifiable {
    enum Status: String, Decodable, Sendable { case authorized, started }
    let id: UUID
    let requestId: UUID
    let assetId: UUID
    let visitId: UUID
    let status: Status
    let authorizedAt: Date
    let startedAt: Date?
    let learningRevision: Int?
}

struct MiniAudioRequest: Encodable, Sendable {
    enum Operation: String, Encodable, Sendable { case ensure, regenerate }
    let requestId: UUID
    let target: MiniAudioTarget
    let operation: Operation
    let voice: String?

    init(requestId: UUID = UUID(), target: MiniAudioTarget, operation: Operation = .ensure, voice: String? = nil) {
        self.requestId = requestId; self.target = target; self.operation = operation; self.voice = voice
    }

    private enum CodingKeys: String, CodingKey { case requestId, target, operation, voice }
    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(requestId.uuidString.lowercased(), forKey: .requestId)
        try values.encode(target, forKey: .target)
        try values.encode(operation, forKey: .operation)
        try values.encodeIfPresent(voice, forKey: .voice)
    }
}

struct MiniAudioPlaybackRequest: Encodable, Sendable {
    enum Mode: String, Encodable, Sendable { case automatic, manual }
    let requestId: UUID
    let assetId: UUID
    let visitId: UUID
    let mode: Mode
    let context: MiniAudioContext?
    let spellingSubmissionId: UUID?

    init(requestId: UUID, assetId: UUID, visitId: UUID, mode: Mode, context: MiniAudioContext?,
         spellingSubmissionId: UUID? = nil) {
        self.requestId = requestId
        self.assetId = assetId
        self.visitId = visitId
        self.mode = mode
        self.context = context
        self.spellingSubmissionId = spellingSubmissionId
    }

    private enum CodingKeys: String, CodingKey { case requestId, assetId, visitId, mode, context, spellingSubmissionId }
    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(requestId.uuidString.lowercased(), forKey: .requestId)
        try values.encode(assetId.uuidString.lowercased(), forKey: .assetId)
        try values.encode(visitId.uuidString.lowercased(), forKey: .visitId)
        try values.encode(mode, forKey: .mode)
        try values.encodeIfPresent(context, forKey: .context)
        try values.encodeIfPresent(spellingSubmissionId?.uuidString.lowercased(), forKey: .spellingSubmissionId)
    }
}

struct MiniAudioPlaybackStart: Codable, Sendable, Equatable {
    let requestId: UUID
    let playbackId: UUID
    let occurredAt: Date
    private enum CodingKeys: String, CodingKey { case requestId, playbackId, occurredAt }
    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(requestId.uuidString.lowercased(), forKey: .requestId)
        try values.encode(playbackId.uuidString.lowercased(), forKey: .playbackId)
        try values.encode(occurredAt, forKey: .occurredAt)
    }
}

protocol MiniAudioServing: Sendable {
    func request(_ input: MiniAudioRequest, retryTransport: Bool) async throws -> MiniAudioResult
    func job(_ id: UUID) async throws -> MiniAudioJob
    func snapshot() async throws -> MiniAudioSnapshot
    func file(_ id: UUID) async throws -> Data
    func authorize(_ input: MiniAudioPlaybackRequest) async throws -> MiniAudioPlaybackReceipt
    func started(_ input: MiniAudioPlaybackStart) async throws -> MiniAudioPlaybackReceipt
}

struct MiniAudioClient: MiniAudioServing {
    private let study: MiniStudyClient
    init(study: MiniStudyClient = MiniStudyClient()) { self.study = study }
    func request(_ input: MiniAudioRequest, retryTransport: Bool = true) async throws -> MiniAudioResult {
        try await study.serviceRequest(path: "audio/request", body: JSONEncoder().encode(input), retryTransport: retryTransport)
    }
    func job(_ id: UUID) async throws -> MiniAudioJob {
        try await study.serviceRequest(path: "audio/jobs/" + id.uuidString.lowercased(), body: nil)
    }
    func snapshot() async throws -> MiniAudioSnapshot {
        let result: MiniAudioSnapshot = try await study.serviceRequest(path: "audio/snapshot", body: nil)
        guard result.schemaVersion == 1 else { throw MiniStudyClientError.invalidResponse }
        return result
    }
    func file(_ id: UUID) async throws -> Data {
        let data = try await study.serviceData(path: "audio/assets/" + id.uuidString.lowercased() + "/file")
        guard data.count > 44, data.count < 30_000_000,
              data.prefix(4) == Data("RIFF".utf8), data.dropFirst(8).prefix(4) == Data("WAVE".utf8) else {
            throw MiniStudyClientError.invalidResponse
        }
        return data
    }
    func authorize(_ input: MiniAudioPlaybackRequest) async throws -> MiniAudioPlaybackReceipt {
        try await study.serviceRequest(path: "audio/playback", body: JSONEncoder().encode(input))
    }
    func started(_ input: MiniAudioPlaybackStart) async throws -> MiniAudioPlaybackReceipt {
        try await study.serviceRequest(path: "audio/playback/started", body: JSONEncoder().encode(input))
    }
}

struct MiniAudioRecovery: Sendable {
    let directory: URL
    init(directory: URL = MiniStudyClient().recoveryDirectory) { self.directory = directory }
    private var file: URL { directory.appending(path: "audio-started-outbox.json") }

    func load() throws -> [MiniAudioPlaybackStart] {
        do { return try JSONDecoder().decode([MiniAudioPlaybackStart].self, from: Data(contentsOf: file)) }
        catch let error as CocoaError where error.code == .fileReadNoSuchFile || error.code == .fileNoSuchFile { return [] }
    }
    func save(_ values: [MiniAudioPlaybackStart]) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        try JSONEncoder().encode(values).write(to: file, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    }
}
