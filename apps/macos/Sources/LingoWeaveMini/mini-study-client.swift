import Foundation

struct MiniTeachingMemory: Decodable, Sendable, Identifiable {
    let id: UUID
    let key: String
    let value: String
}

struct MiniTeachingSnapshot: Decodable, Sendable {
    let memories: [MiniTeachingMemory]
}

struct MiniStudySnapshot: Decodable, Sendable {
    let schemaVersion: Int
    let revision: Int
    let imported: Bool
    let ledger: MiniDailyLedger
    let reviewRecord: MiniReviewRecord?
    let reviewHistory: [MiniReviewRecord]
    let planning: MiniPlanningState
    let planContext: MiniPlanContext?
    let teaching: MiniTeachingSnapshot?
    let practice: MiniPracticeSnapshot?
    let scheduling: MiniSchedulingSnapshot?
    fileprivate let rebaseEvidence: MiniStudyRebaseEvidence

    private enum CodingKeys: String, CodingKey {
        case schemaVersion, revision, imported, ledger, reviewRecord, reviewHistory, planning, planContext, teaching, practice, scheduling
    }

    init(from decoder: any Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try values.decode(Int.self, forKey: .schemaVersion)
        revision = try values.decode(Int.self, forKey: .revision)
        imported = try values.decode(Bool.self, forKey: .imported)
        ledger = try values.decode(MiniDailyLedger.self, forKey: .ledger)
        reviewRecord = try values.decodeIfPresent(MiniReviewRecord.self, forKey: .reviewRecord)
        reviewHistory = try values.decode([MiniReviewRecord].self, forKey: .reviewHistory)
        planning = try values.decode(MiniPlanningState.self, forKey: .planning)
        planContext = try values.decodeIfPresent(MiniPlanContext.self, forKey: .planContext)
        teaching = try values.decodeIfPresent(MiniTeachingSnapshot.self, forKey: .teaching)
        practice = try values.decodeIfPresent(MiniPracticeSnapshot.self, forKey: .practice)
        scheduling = try values.decodeIfPresent(MiniSchedulingSnapshot.self, forKey: .scheduling)
        rebaseEvidence = try MiniStudyRebaseEvidence(from: decoder)
    }
}

/// Comparison evidence only. Preserve unknown service fields so a future fact cannot
/// accidentally become eligible merely because the current native UI ignores it.
fileprivate struct MiniStudyRebaseEvidence: Decodable, Sendable {
    let facts: Data
    let sentences: [String: [Data]]
    let flow: MiniStudyRebaseValue?
    let focusItems: MiniStudyRebaseValue?
    let assessmentSources: MiniStudyRebaseValue?

    init(from decoder: any Decoder) throws {
        guard case .object(var root) = try MiniStudyRebaseValue(from: decoder),
              case .object(var ledger) = root["ledger"], case .array(let days) = ledger["days"] else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Invalid study snapshot"))
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        var materials: [String: [Data]] = [:]
        var comparableDays: [MiniStudyRebaseValue] = []
        for value in days {
            guard case .object(var day) = value, case .string(let id) = day["id"],
                  case .array(let examples) = day["sentences"], materials[id] == nil else {
                throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Invalid study group"))
            }
            materials[id] = try examples.map { try encoder.encode($0) }
            day.removeValue(forKey: "sentences")
            comparableDays.append(.object(day))
        }
        ledger["days"] = .array(comparableDays)
        root["ledger"] = .object(ledger)
        root.removeValue(forKey: "revision")
        root.removeValue(forKey: "planContext")
        assessmentSources = root["assessmentSources"]
        if case .object(var scheduling) = root["scheduling"] {
            flow = scheduling.removeValue(forKey: "flow")
            root["scheduling"] = .object(scheduling)
        } else { flow = nil }
        if case .object(var teaching) = root["teaching"] {
            focusItems = teaching.removeValue(forKey: "focusItems")
            root["teaching"] = .object(teaching)
        } else { focusItems = nil }
        facts = try encoder.encode(MiniStudyRebaseValue.object(root))
        sentences = materials
    }

    func onlyExtendsMaterials(from previous: Self) -> Bool {
        facts == previous.facts && safeAssessmentExtension(from: previous) && sentences.count == previous.sentences.count
            && previous.sentences.allSatisfy { id, old in
                guard let current = sentences[id], current.count >= old.count else { return false }
                return Array(current.prefix(old.count)) == old
            }
    }

    /// A model assessment may update only its own FSRS projection while the user
    /// answers another card. Require append-only evidence and an exact change chain.
    private func safeAssessmentExtension(from previous: Self) -> Bool {
        if flow == previous.flow { return true }
        guard focusItems == previous.focusItems,
              case .object(var old)? = previous.flow, case .object(var new)? = flow,
              case .array(let oldEvents)? = old.removeValue(forKey: "events"),
              case .array(let events)? = new.removeValue(forKey: "events"),
              case .array(let oldChanges)? = old.removeValue(forKey: "changes"),
              case .array(let changes)? = new.removeValue(forKey: "changes"),
              case .array(let oldCards)? = old.removeValue(forKey: "cards"),
              case .array(let cards)? = new.removeValue(forKey: "cards"), old == new,
              events.count > oldEvents.count, Array(events.prefix(oldEvents.count)) == oldEvents,
              changes.count >= oldChanges.count, Array(changes.prefix(oldChanges.count)) == oldChanges,
              case .array(let sources)? = assessmentSources else { return false }
        let additions = Array(events.dropFirst(oldEvents.count))
        let changed = Array(changes.dropFirst(oldChanges.count))
        guard additions.count == changed.count else { return false }
        var expectedCards = oldCards
        var used = Set<String>()
        for (event, change) in zip(additions, changed) {
            guard case .object(let item) = event, item["kind"] == .string("assessment"),
                  case .string(let id)? = item["id"], used.insert(id).inserted,
                  !oldEvents.contains(where: { $0.field("id") == .string(id) }),
                  let sourceId = item["sourceId"], let word = item["word"],
                  sources.contains(where: { $0.field("id") == sourceId && $0.field("word")?.sameSense(as: word) == true }),
                  case .object(let delta) = change, delta["eventId"] == .string(id),
                  delta["word"]?.sameSense(as: word) == true,
                  case .object(let after)? = delta["after"],
                  case .string(let sense)? = after["senseId"], after["word"]?.sameSense(as: word) == true else { return false }
            let existing = expectedCards.first { $0.field("senseId") == .string(sense) }
            guard delta["before"] == (existing ?? .null) else { return false }
            expectedCards.removeAll { $0.field("senseId") == .string(sense) }
            expectedCards.append(.object(after))
        }
        return expectedCards == cards
    }

}

fileprivate indirect enum MiniStudyRebaseValue: Codable, Equatable, Sendable {
    case object([String: Self]), array([Self]), string(String), number(Decimal), boolean(Bool), null

    init(from decoder: any Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .null }
        else if let item = try? value.decode(Bool.self) { self = .boolean(item) }
        else if let item = try? value.decode(Decimal.self) { self = .number(item) }
        else if let item = try? value.decode(String.self) { self = .string(item) }
        else if let item = try? value.decode([Self].self) { self = .array(item) }
        else { self = .object(try value.decode([String: Self].self)) }
    }

    func field(_ key: String) -> Self? {
        guard case .object(let object) = self else { return nil }
        return object[key]
    }
    func sameSense(as other: Self) -> Bool {
        guard case .string(let spelling)? = field("spelling"), case .string(let meaning)? = field("meaning"),
              case .string(let otherSpelling)? = other.field("spelling"), case .string(let otherMeaning)? = other.field("meaning") else { return false }
        return spelling.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == otherSpelling.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            && meaning.trimmingCharacters(in: .whitespacesAndNewlines) == otherMeaning.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func encode(to encoder: any Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self {
        case .object(let item): try value.encode(item)
        case .array(let item): try value.encode(item)
        case .string(let item): try value.encode(item)
        case .number(let item): try value.encode(item)
        case .boolean(let item): try value.encode(item)
        case .null: try value.encodeNil()
        }
    }
}

struct MiniStudyAction: Codable, Sendable {
    enum Kind: String, Codable, Sendable {
        case begin, pause
        case chooseJudgment = "choose_judgment"
        case advanceJudgment = "advance_judgment"
        case spellingDraft = "spelling_draft"
        case submitSpelling = "submit_spelling"
        case advanceSpelling = "advance_spelling"
        case memoryAdvance = "memory_advance"
        case memoryReveal = "memory_reveal"
        case memoryDraft = "memory_draft"
        case memoryUndo = "memory_undo"
        case windowChoose = "window_choose"
        case windowCorrect = "window_correct"
        case windowAdvance = "window_advance"
        case windowDraft = "window_draft"
        case completeReview = "complete_review"
        case markStudied = "mark_studied"
        case completeLearning = "complete_learning"
        case addSentences = "add_sentences"
        case translationDraft = "translation_draft"
        case submitTranslation = "submit_translation"
        case recordFeedback = "record_feedback"
        case publishWriting = "publish_writing"
        case qualitativeFeedback = "qualitative_feedback"
        case advanceTranslation = "advance_translation"
        case continueToLearning = "continue_to_learning"
        case setLongTermPlan = "set_long_term_plan"
        case setTodayPlan = "set_today_plan"
        case clearTodayPlan = "clear_today_plan"
        case setSessionPlan = "set_session_plan"
        case clearSessionPlan = "clear_session_plan"
        case endSession = "end_session"
        case recordCardView = "record_card_view"
        case hideCard = "hide_card"
        case openDictation = "open_dictation"
        case submitDictation = "submit_dictation"
        case revealDictation = "reveal_dictation"
        case closeDictation = "close_dictation"
        case unmarkStudied = "unmark_studied"
        case clearJudgment = "clear_judgment"
        case beginProbe = "begin_probe"
        case submitProbe = "submit_probe"
        case revealProbe = "reveal_probe"
        case endProbe = "end_probe"
        case advanceLearningCard = "advance_learning_card"
    }

    enum Target: String, Codable, Sendable { case daily, review }
    enum Session: String, Codable, Sendable { case review, learning }

    let type: Kind
    let target: Target
    var dayId: String? = nil
    var recordId: UUID? = nil
    var deck: [MiniWord]? = nil
    var timezone: String? = nil
    var session: Session? = nil
    var word: MiniWord? = nil
    var judgment: MiniReviewJudgment? = nil
    var markWrong: Bool? = nil
    var paused: Bool? = nil
    var draft: String? = nil
    var answer: String? = nil
    var sentences: [MiniStudySentence]? = nil
    var taskId: String? = nil
    var attemptId: UUID? = nil
    var feedback: MiniTranslationFeedback? = nil
    var prompts: [MiniWritingPromptInput]? = nil
    var plan: MiniLongTermPlan? = nil
    var date: String? = nil
    var mode: MiniPlanMode? = nil
    var wordLimit: Int? = nil
    var newWordLimit: Int? = nil
    var recovery: Bool? = nil
    var overrideRest: Bool? = nil
    var dictationId: UUID? = nil
    var probeId: UUID? = nil
    var remainOnCard: Bool? = nil
    var newGroup: Bool? = nil
    var flowVersion: String? = nil
    var round: Int? = nil
    var remembered: Bool? = nil
    var advanceOnCorrect: Bool? = nil
    var dailyNewGoal: Int? = nil
    var groupSize: Int? = nil
    var visitId: UUID? = nil

    static func window(_ type: Kind, dayId: String, session: Session, visit: MiniMemoryWindow.Visit,
                       draft: String) -> Self {
        var action = Self(type: type, target: .daily, dayId: dayId, session: session, word: visit.word)
        action.visitId = visit.id
        if type != .windowCorrect { action.draft = draft }
        return action
    }
}

struct MiniStudyCommand: Codable, Sendable {
    let requestId: UUID
    let expectedRevision: Int
    let action: MiniStudyAction
    let occurredAt: Date?

    init(requestId: UUID = UUID(), expectedRevision: Int, action: MiniStudyAction, occurredAt: Date? = nil) {
        self.requestId = requestId
        self.expectedRevision = expectedRevision
        self.action = action
        if let occurredAt { self.occurredAt = occurredAt }
        else {
            // Match Node Date's millisecond clock and epoch conversion. Retried
            // commands retain their originally supplied occurrence time above.
            let milliseconds = floor(Date.now.timeIntervalSince1970 * 1_000)
            self.occurredAt = Date(timeIntervalSinceReferenceDate: milliseconds / 1_000 - 978_307_200)
        }
    }
}

struct MiniStudyImport: Codable, Sendable {
    let requestId: UUID
    let ledger: MiniDailyLedger
    let reviewRecord: MiniReviewRecord?
    let reviewHistory: [MiniReviewRecord]
    let timezone: String
}

/// The files below are recovery copies and a command outbox, never a writable learning ledger.
struct MiniStudyClient: Sendable {
    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        return URLSession(configuration: configuration)
    }()
    let baseURL: URL
    private let tokenFile: URL
    private let legacyDirectory: URL

    init(baseURL: URL? = nil, tokenFile: URL? = nil, legacyDirectory: URL? = nil) {
        let bundle = Bundle.main
        let directory = legacyDirectory ?? URL.applicationSupportDirectory
            .appending(path: bundle.bundleIdentifier ?? "com.lingoweave.mini", directoryHint: .isDirectory)
        self.legacyDirectory = directory
        #if DEBUG
        let defaultURL = "http://127.0.0.1:4311"
        #else
        let defaultURL = "http://127.0.0.1:4312"
        #endif
        let configuredURL = bundle.object(forInfoDictionaryKey: "LingoWeaveServiceURL") as? String
        self.baseURL = baseURL ?? URL(string: configuredURL ?? defaultURL) ?? URL(fileURLWithPath: "/invalid-mini-service")
        let configuredToken = bundle.object(forInfoDictionaryKey: "LingoWeaveServiceTokenPath") as? String
        self.tokenFile = tokenFile ?? configuredToken.map { URL(fileURLWithPath: $0) }
            ?? directory.appending(path: "service/token")
    }

    func snapshot() async throws -> MiniStudySnapshot {
        try await request(path: "snapshot", body: Optional<Data>.none)
    }

    func planPreview(deck: [MiniWord], timezone: String = TimeZone.current.identifier) async throws -> MiniStudySnapshot {
        struct Preview: Encodable { let deck: [MiniWord]; let timezone: String }
        return try await request(path: "plan-preview", body: JSONEncoder().encode(Preview(deck: deck, timezone: timezone)))
    }

    func importLegacy(_ payload: MiniStudyImport) async throws -> MiniStudySnapshot {
        try await request(path: "import", body: JSONEncoder().encode(payload))
    }

    func perform(_ command: MiniStudyCommand) async throws -> MiniStudySnapshot {
        try await request(path: "commands", body: JSONEncoder().encode(command))
    }

    /// After an explicit revision conflict, a caller may retry once with a new request
    /// identity and the original occurrence time. Uncertain HTTP outcomes keep their
    /// original identity; recovered outbox commands have no before-snapshot to rebase.
    static func eligibleRebase(command: MiniStudyCommand, before: MiniStudySnapshot, after: MiniStudySnapshot) -> Bool {
        if command.action.type == .hideCard {
            return command.occurredAt != nil && command.action.target == .daily && command.action.word != nil
        }
        guard command.occurredAt != nil, command.expectedRevision == before.revision,
              before.schemaVersion == after.schemaVersion, before.imported, after.imported,
              after.revision > before.revision,
              after.rebaseEvidence.onlyExtendsMaterials(from: before.rebaseEvidence),
              command.action.word != nil || command.action.type == .submitTranslation || command.action.type == .advanceTranslation else { return false }
        let action = command.action
        let word = action.word
        if action.type == .recordCardView { return true }
        switch action.type {
        case .chooseJudgment, .advanceJudgment, .submitSpelling, .advanceSpelling, .submitTranslation, .advanceTranslation, .markStudied, .memoryAdvance, .memoryReveal, .memoryDraft, .windowChoose, .windowCorrect, .windowAdvance, .windowDraft: break
        default: return false
        }
        let session: MiniReviewSession?
        switch action.target {
        case .daily:
            guard let id = action.dayId, before.planning.activeDayId == id,
                  let day = before.ledger.days.first(where: { $0.id == id }), !day.paused else { return false }
            if action.type == .submitTranslation || action.type == .advanceTranslation {
                guard day.flow != nil, day.phase == .translation, day.currentTranslation?.id == action.taskId else { return false }
                return action.type == .submitTranslation
                    ? day.currentAttempt == nil && action.answer?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
                    : day.currentAttempt != nil && day.currentAttempt?.confirmedAt == nil
            }
            if [.windowChoose, .windowCorrect, .windowAdvance, .windowDraft].contains(action.type) {
                return day.memoryWindow?.visit?.id == action.visitId && day.memoryWindow?.visit?.word == word
                    && action.session == (day.phase == .review ? .review : .learning)
            }
            if action.type == .memoryAdvance || action.type == .memoryReveal || action.type == .memoryDraft {
                return day.phase == .learning && day.memory?.currentWord == word && day.memory?.round == action.round
            }
            if action.type == .markStudied {
                return day.phase == .learning && action.session == nil && day.nextUnstudiedWord == word
                    && day.sentences.contains(where: { $0.word == word })
            }
            switch action.session {
            case .review: guard day.phase == .review else { return false }; session = day.review
            case .learning:
                guard day.phase == .learning, day.nextUnstudiedWord == nil else { return false }
                session = day.learning
            case nil: return false
            }
        case .review:
            guard action.type != .markStudied, let record = before.reviewRecord,
                  record.id == action.recordId, !record.paused,
                  action.session == nil || action.session == .review else { return false }
            session = record.session
        }
        guard let session, session.currentWord == word else { return false }
        switch action.type {
        case .chooseJudgment: return session.phase == .judgment && session.currentJudgment == nil && action.judgment != nil
        case .advanceJudgment: return session.phase == .judgment && session.currentJudgment != nil
        case .advanceSpelling:
            return session.phase == .spelling && (session.spellingState == .readyToAdvance || session.spellingState == .skipped)
        case .submitSpelling:
            return session.phase == .spelling && session.spellingState != .readyToAdvance
                && action.answer?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
        default: return false
        }
    }

    func prepareLegacyImport() throws -> MiniStudyImport {
        let backup = legacyDirectory.appending(path: "migration-backup", directoryHint: .isDirectory)
        let requestFile = backup.appending(path: "import-request.json")
        if let existing = try readIfPresent(requestFile) {
            return try JSONDecoder().decode(MiniStudyImport.self, from: existing)
        }

        var originals: [(String, Data)] = []
        let ledgerData = try readIfPresent(legacyDirectory.appending(path: "DailyStudy/ledger.json"))
        let reviewData = try readIfPresent(legacyDirectory.appending(path: "Review/current.json"))
        let ledger = try ledgerData.map { try JSONDecoder().decode(MiniDailyLedger.self, from: $0) } ?? MiniDailyLedger()
        let record = try reviewData.map { try JSONDecoder().decode(MiniReviewRecord.self, from: $0) }
        if let ledgerData { originals.append(("daily-study/ledger.json", ledgerData)) }
        if let reviewData { originals.append(("review/current.json", reviewData)) }

        let historyDirectory = legacyDirectory.appending(path: "Review/History", directoryHint: .isDirectory)
        var history: [MiniReviewRecord] = []
        if FileManager.default.fileExists(atPath: historyDirectory.path) {
            let files = try FileManager.default.contentsOfDirectory(at: historyDirectory, includingPropertiesForKeys: nil)
                .filter { $0.pathExtension.lowercased() == "json" }.sorted { $0.lastPathComponent < $1.lastPathComponent }
            for file in files {
                let data = try Data(contentsOf: file)
                history.append(try JSONDecoder().decode(MiniReviewRecord.self, from: data))
                originals.append(("review/history/" + file.lastPathComponent.lowercased(), data))
            }
        }

        let payload = MiniStudyImport(requestId: UUID(), ledger: ledger, reviewRecord: record,
                                      reviewHistory: history, timezone: TimeZone.current.identifier)
        for (path, data) in originals {
            let destination = backup.appending(path: path)
            if let existing = try readIfPresent(destination) {
                guard existing == data else { throw MiniStudyClientError.backupConflict }
            } else {
                try writePrivate(data, to: destination)
            }
        }
        try writePrivate(JSONEncoder().encode(payload), to: requestFile)
        return payload
    }

    func recordImportReceipt(_ snapshot: MiniStudySnapshot) throws {
        struct Receipt: Encodable {
            let requestId: UUID
            let revision: Int
            let importedAt: Date
        }
        let payload = try prepareLegacyImport()
        let receipt = Receipt(requestId: payload.requestId, revision: snapshot.revision, importedAt: .now)
        try writePrivate(JSONEncoder().encode(receipt), to: legacyDirectory.appending(path: "migration-backup/import-receipt.json"))
    }

    func pendingCommand() throws -> MiniStudyCommand? {
        try readIfPresent(pendingFile).map { try JSONDecoder().decode(MiniStudyCommand.self, from: $0) }
    }

    func savePending(_ command: MiniStudyCommand) throws {
        try writePrivate(JSONEncoder().encode(command), to: pendingFile)
    }

    func clearPending(requestId: UUID? = nil) throws {
        if let requestId, let existing = try pendingCommand(), existing.requestId != requestId { return }
        do { try FileManager.default.removeItem(at: pendingFile) }
        catch let error as CocoaError where error.code == .fileNoSuchFile { return }
    }

    func loadDrafts() throws -> [String: String] {
        try readIfPresent(draftsFile).map { try JSONDecoder().decode([String: String].self, from: $0) } ?? [:]
    }

    func saveDrafts(_ drafts: [String: String]) throws {
        try writePrivate(JSONEncoder().encode(drafts), to: draftsFile)
    }

    func pendingCardHides() throws -> [MiniStudyCommand] {
        let commands = try readIfPresent(recoveryDirectory.appending(path: "visibility-outbox.json"))
            .map { try JSONDecoder().decode([MiniStudyCommand].self, from: $0) } ?? []
        guard commands.allSatisfy({ $0.action.type == .hideCard && $0.action.target == .daily && $0.action.word != nil && $0.occurredAt != nil }) else {
            throw MiniStudyClientError.invalidResponse
        }
        return commands
    }

    func saveCardHides(_ commands: [MiniStudyCommand]) throws {
        try writePrivate(JSONEncoder().encode(commands), to: recoveryDirectory.appending(path: "visibility-outbox.json"))
    }

    private var pendingFile: URL { legacyDirectory.appending(path: "service-client/pending-command.json") }
    private var draftsFile: URL { legacyDirectory.appending(path: "service-client/drafts.json") }

    private func request(path: String, body: Data?) async throws -> MiniStudySnapshot {
        let snapshot: MiniStudySnapshot = try await serviceRequest(path: path, body: body)
        guard snapshot.schemaVersion == 1 else { throw MiniStudyClientError.invalidResponse }
        return snapshot
    }

    func serviceRequest<Response: Decodable & Sendable>(path: String, body: Data?) async throws -> Response {
        try JSONDecoder().decode(Response.self, from: await serviceData(path: path, body: body))
    }

    var recoveryDirectory: URL { legacyDirectory.appending(path: "service-client", directoryHint: .isDirectory) }

    func serviceData(path: String, body: Data? = nil) async throws -> Data {
        guard baseURL.scheme == "http", ["127.0.0.1", "localhost", "[::1]"].contains(baseURL.host) else {
            throw MiniStudyClientError.configuration
        }
        let token = try String(contentsOf: tokenFile, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty, token.count <= 4_096, !token.contains(where: \.isNewline) else {
            throw MiniStudyClientError.configuration
        }
        var request = URLRequest(url: baseURL.appending(path: "api/mini/" + path),
                                 cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
        request.httpMethod = body == nil ? "GET" : "POST"
        request.httpBody = body
        request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let delays: [Duration] = body == nil ? [] : [.milliseconds(150), .milliseconds(350), .milliseconds(700)]
        var retry = 0
        while true {
            do {
                return try await responseData(for: request)
            } catch {
                let transient: Bool
                switch error {
                case let network as URLError: transient = network.code != .cancelled
                case MiniStudyClientError.unavailable: transient = true
                default: transient = false
                }
                guard transient, retry < delays.count, !Task.isCancelled else { throw error }
                try await Task.sleep(for: delays[retry])
                retry += 1
            }
        }
    }

    private func responseData(for request: URLRequest) async throws -> Data {
        let (data, response) = try await Self.session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw MiniStudyClientError.invalidResponse }
        if response.statusCode == 409 { throw MiniStudyClientError.conflict }
        if response.statusCode == 401 || response.statusCode == 403 { throw MiniStudyClientError.unauthorized }
        if response.statusCode >= 500 { throw MiniStudyClientError.unavailable }
        guard (200..<300).contains(response.statusCode) else {
            if let failure = try? JSONDecoder().decode(MiniServiceFailure.self, from: data) {
                throw MiniStudyClientError.service(failure.error.message)
            }
            throw MiniStudyClientError.rejected
        }
        return data
    }

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

private struct MiniServiceFailure: Decodable {
    struct Detail: Decodable { let message: String }
    let error: Detail
}

enum MiniStudyClientError: LocalizedError {
    case configuration, invalidResponse, unauthorized, conflict, rejected, backupConflict, unavailable
    case service(String)

    var errorDescription: String? {
        switch self {
        case .configuration: "本机学习服务配置不可用，请重新启动应用。"
        case .invalidResponse: "学习服务返回的数据暂不可用，已有记录已保留。"
        case .unauthorized: "无法验证本机学习服务，请重新启动应用。"
        case .conflict: "学习状态已更新，已重新读取进度。请确认后再操作。"
        case .rejected: "学习服务未接受这次操作，已有记录已保留。"
        case .backupConflict: "旧记录与迁移备份不一致，请先检查本机记录。"
        case .unavailable: "本机学习服务暂不可用。"
        case .service(let message): message
        }
    }
}
