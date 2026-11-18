import Foundation

@main
struct MiniPracticeClientTests {
    static func main() throws {
        try testPracticeRecovery()
        try testProbeRecovery()
        try testPracticeCommandOutbox()
        try testVocabularyActivationRecovery()
        try testVocabularyCatalogBookRelationships()
        try testCustomVocabularyOrder()
        print("6 mini practice, scheduling and vocabulary recovery tests passed.")
    }

    private static func testPracticeRecovery() throws {
        let id = UUID(), attempt = UUID()
        let data = Data("""
        {"activeDictationId":"\(id)","dictations":[{
          "id":"\(id)","target":"daily","dayId":"saved-group","session":"learning",
          "word":{"spelling":"apple","meaning":"苹果","phonetic":""},"openedAt":812345678,
          "attempts":[{"id":"\(attempt)","answer":"  APPLE  ","correct":true,"submittedAt":812345679}]
        }]}
        """.utf8)
        let value = try JSONDecoder().decode(MiniPracticeSnapshot.self, from: data)
        precondition(value.activeDictation?.id == id && value.activeDictation?.dayId == "saved-group")
        precondition(value.activeDictation?.attempts.first?.answer == "  APPLE  ")
        precondition(value.activeDictation?.revealedAt == nil && value.activeDictation?.closedAt == nil)
    }

    private static func testProbeRecovery() throws {
        let id = UUID()
        let data = Data("""
        {"policyVersion":"mini-fsrs-v1","model":"FSRS-6","activeProbeId":"\(id)",
         "cards":[{"senseId":"sense-a","word":{"spelling":"apple","meaning":"苹果","phonetic":""},
           "ability":"spelling","introducedAt":812345000,"dueAt":812345680,"lastServedAt":null,
           "state":"learning","fsrs":{"due":812345680,"stability":1.1,"difficulty":5.2,"reps":1,"lapses":0,"state":1}}],
         "probes":[{"id":"\(id)","word":{"spelling":"apple","meaning":"苹果","phonetic":""},
           "openedAt":812345678,"status":"answered","answer":"  apple  ","submittedAt":812345679,
           "correct":true,"classification":"too_soon","reason":"Recent answer exposure"}]}
        """.utf8)
        let value = try JSONDecoder().decode(MiniSchedulingSnapshot.self, from: data)
        precondition(value.activeProbe?.answer == "  apple  " && value.activeProbe?.classification == .tooSoon)
        precondition(value.activeProbe?.rating == nil && value.activeProbe?.revealedAt == nil)
        precondition(value.cards.first?.fsrs?.reps == 1 && value.cards.first?.dueAt == Date(timeIntervalSinceReferenceDate: 812345680))
        precondition(MiniProbePrompt.text(for: MiniWord(spelling: "apple", meaning: "apple /ˈæpəl/ n. 苹果")) == "苹果")
        precondition(MiniProbePrompt.text(for: MiniWord(spelling: "apple", meaning: "apple")) == nil)
    }

    private static func testPracticeCommandOutbox() throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let client = MiniStudyClient(legacyDirectory: directory)
        var action = MiniStudyAction(type: .submitDictation, target: .daily, dayId: "saved-group", session: .learning)
        action.dictationId = UUID()
        action.answer = "  APPLE  "
        let command = MiniStudyCommand(expectedRevision: 8, action: action, occurredAt: Date(timeIntervalSinceReferenceDate: 812345679.125))
        try client.savePending(command)
        let recovered = try client.pendingCommand()
        precondition(recovered?.requestId == command.requestId && recovered?.occurredAt == command.occurredAt)
        precondition(recovered?.action.dictationId == action.dictationId && recovered?.action.answer == "  APPLE  ")
        let immediate = MiniStudyCommand(expectedRevision: 8, action: action)
        guard let immediateAt = immediate.occurredAt else { preconditionFailure("Missing command occurrence time") }
        let milliseconds = immediateAt.timeIntervalSince1970 * 1_000
        precondition(abs(milliseconds - milliseconds.rounded()) < 0.001)
        let exact = Date(timeIntervalSinceReferenceDate: 812345679.125456)
        precondition(MiniStudyCommand(expectedRevision: 8, action: action, occurredAt: exact).occurredAt == exact)
        let hidden = MiniStudyCommand(expectedRevision: 8,
                                      action: MiniStudyAction(type: .hideCard, target: .daily, word: MiniWord(spelling: "apple", meaning: "苹果")),
                                      occurredAt: Date(timeIntervalSinceReferenceDate: 812345680.125))
        try client.saveCardHides([hidden])
        let recoveredHides = try client.pendingCardHides()
        precondition(recoveredHides.first?.requestId == hidden.requestId && recoveredHides.first?.occurredAt == hidden.occurredAt)
        var begin = MiniStudyAction(type: .begin, target: .daily)
        begin.newGroup = true
        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(begin)) as? [String: Any]
        precondition(encoded?["newGroup"] as? Bool == true && encoded?["dayId"] == nil)
    }

    private static func testVocabularyActivationRecovery() throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let study = MiniStudyClient(legacyDirectory: directory)
        let client = MiniVocabularyClient(study: study)
        let request = MiniVocabularyActivation(expectedRevision: 3, deckId: nil)
        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any]
        precondition(encoded?["requestId"] as? String == request.requestId.uuidString.lowercased())
        precondition(encoded?["deckId"] is NSNull && encoded?["order"] == nil)
        try client.savePending(request)
        let saved = try client.pending()
        precondition(saved?.requestId == request.requestId && saved?.order == nil)
        guard let saved else { preconditionFailure("Missing legacy activation") }
        let replayed = try JSONSerialization.jsonObject(with: JSONEncoder().encode(saved)) as? [String: Any]
        precondition(replayed?["order"] == nil)
        try client.clearPending(UUID())
        let afterDifferentReceipt = try client.pending()
        precondition(afterDifferentReceipt?.requestId == request.requestId)
        try client.clearPending(request.requestId)
        let cleared = try client.pending()
        precondition(cleared == nil)

        let ordered = MiniVocabularyActivation(expectedRevision: 4, deckId: "oxford-a1", order: .source)
        try client.savePending(ordered)
        let recoveredOrder = try client.pending()
        precondition(recoveredOrder?.requestId == ordered.requestId && recoveredOrder?.order == .source)
        let orderedBody = try JSONSerialization.jsonObject(with: JSONEncoder().encode(ordered)) as? [String: Any]
        precondition(orderedBody?["order"] as? String == "source" && orderedBody?["deckId"] as? String == "oxford-a1")
        try client.clearPending(ordered.requestId)
    }

    private static func testVocabularyCatalogBookRelationships() throws {
        let data = Data("""
        {"schemaVersion":1,"revision":5,"activeDeckId":"oxford-a1","activeOrder":"source",
         "books":[{"id":"oxford","name":"牛津 3000","wordCount":2,
                   "levels":[{"level":"A1","deckId":"oxford-a1","wordCount":1}]},
                  {"id":"notes","name":"随手记","wordCount":1,"levels":[]}],
         "decks":[{"id":"oxford","name":"牛津 3000 · 全部","wordCount":2,"level":null,"bookId":"oxford"},
                  {"id":"oxford-a1","name":"牛津 3000 · A1","wordCount":1,"level":"A1","bookId":"oxford"},
                  {"id":"notes","name":"随手记","wordCount":1,"level":null,"bookId":"notes"}],
         "activeWords":[{"spelling":"apple","meaning":"苹果","phonetic":""}],"sources":[]}
        """.utf8)
        let catalog = try JSONDecoder().decode(MiniVocabularyCatalog.self, from: data)
        precondition(catalog.books.count == 2 && catalog.activeBook?.id == "oxford")
        precondition(catalog.activeSelectionName == "牛津 3000 · A1 · 顺序")
        precondition(catalog.activeBook?.deckId(for: "A1") == "oxford-a1")
        let notes = catalog.books.first { $0.id == "notes" }
        precondition(notes?.levels.isEmpty == true && notes?.deckId(for: "A1") == "notes")

        let legacy = Data("""
        {"schemaVersion":1,"revision":3,"activeDeckId":"oxford-a1",
         "decks":[{"id":"oxford","name":"牛津 3000","wordCount":2,"level":null},
                  {"id":"oxford-a1","name":"牛津 3000 · A1","wordCount":1,"level":"A1"}],
         "activeWords":[{"spelling":"apple","meaning":"苹果","phonetic":""}],"sources":[]}
        """.utf8)
        let recovered = try JSONDecoder().decode(MiniVocabularyCatalog.self, from: legacy)
        precondition(recovered.activeOrder == .random && recovered.books.count == 1)
        precondition(recovered.activeBook?.id == "oxford" && recovered.activeDeck?.level == "A1")

        let corrupted = String(decoding: data, as: UTF8.self)
            .replacingOccurrences(of: "\"deckId\":\"oxford-a1\"", with: "\"deckId\":\"notes\"")
        do {
            _ = try JSONDecoder().decode(MiniVocabularyCatalog.self, from: Data(corrupted.utf8))
            preconditionFailure("A level must refer to its own matching deck")
        } catch is DecodingError { }
    }

    private static func testCustomVocabularyOrder() throws {
        func catalog(_ order: MiniVocabularyOrder) throws -> MiniVocabularyCatalog {
            let data = Data("""
            {"schemaVersion":1,"revision":2,"activeDeckId":null,"activeOrder":"\(order.rawValue)",
             "books":[],"decks":[],"activeWords":[],"sources":[]}
            """.utf8)
            return try JSONDecoder().decode(MiniVocabularyCatalog.self, from: data)
        }
        let words = ["apple", "book", "car", "dog", "egg", "fish"].map { MiniWord(spelling: $0, meaning: "释义 " + $0) }
        let sequential = try catalog(.source)
        precondition(sequential.orderedCustomWords(words) == words)
        let random = try catalog(.random)
        let shuffled = random.orderedCustomWords(words)
        precondition(shuffled != words && Set(shuffled) == Set(words) && shuffled.count == words.count)
        precondition(random.orderedCustomWords(words) == shuffled)
        let withDifferentPhonetics = words.map { MiniWord(spelling: $0.spelling, meaning: $0.meaning, phonetic: "changed") }
        precondition(random.orderedCustomWords(withDifferentPhonetics).map(\.spelling) == shuffled.map(\.spelling))
        let duplicate = MiniWord(spelling: " APPLE ", meaning: "释义 apple", phonetic: "second")
        let duplicates = random.orderedCustomWords([words[0], duplicate])
        precondition(duplicates == [words[0], duplicate])
    }

    private static func temporaryDirectory() throws -> URL {
        let directory = URL.temporaryDirectory.appending(path: "lingoweave-practice-client-" + UUID().uuidString.lowercased())
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }
}
