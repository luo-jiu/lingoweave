import Foundation

@main
struct MiniAIClientTests {
    private let word = MiniWord(spelling: "apple", meaning: "苹果")

    static func main() async throws {
        let tests = Self()
        try tests.testChatMigrationKeepsOriginalBytesAndIdentity()
        try tests.testDamagedChatStopsMigration()
        try tests.testPendingAIAndDraftRecovery()
        try tests.testQualitativeAndLegacyFeedback()
        try tests.testWritingPromptsKeepSubmittedMaterial()
        try tests.testServerTaskAndReceiptDecoding()
        print("6 mini AI client recovery and material tests passed.")
        let environment = ProcessInfo.processInfo.environment
        if let address = environment["MINI_TEST_AI_SERVICE_URL"], let url = URL(string: address),
           let token = environment["MINI_TEST_AI_TOKEN_PATH"] {
            try await tests.testLiveAI(baseURL: url, tokenFile: URL(fileURLWithPath: token))
            print("Swift → HTTP AI task, tool receipt and recovery integration passed.")
        }
    }

    private func testChatMigrationKeepsOriginalBytesAndIdentity() throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let messages = [MiniChatMessage(role: .user, text: "  请解释 apple。  "),
                        MiniChatMessage(role: .assistant, text: "apple 表示苹果。")]
        let alternate = MiniWord(spelling: " APPLE ", meaning: "苹果", phonetic: "other")
        let additional = MiniChatMessage(role: .user, text: "同一义项的另一条原记录")
        let source = try JSONEncoder().encode([word: messages, alternate: [additional]])
        let file = directory.appending(path: "StudyChat.json")
        try source.write(to: file)
        let storage = MiniChatStorage(directory: directory)
        let request = try storage.prepareLegacyImport()
        expect(request.conversations.count == 1, "Pronunciation variants of the same sense merge without losing any original message")
        expect(Set(request.conversations[0].messages.map(\.id)) == Set(messages.map(\.id) + [additional.id]), "Original message identities remain stable")
        expect(request.conversations[0].messages.first { $0.id == messages[0].id }?.text == messages[0].text, "Original text is never trimmed")
        expect(request.conversations[0].id == MiniChatStorage.conversationId(for: word), "Imported and new messages share one stable conversation")
        expect(try storage.prepareLegacyImport().requestId == request.requestId, "Import retries reuse the original request identity")
        expect(try Data(contentsOf: directory.appending(path: "migration-backup/study-chat.json")) == source,
               "The backup preserves original bytes")
        expect(try Data(contentsOf: file) == source, "Migration never rewrites the source archive")
        expect(MiniChatStorage.conversationId(for: alternate) == request.conversations[0].id,
               "Pronunciation changes do not fork the same word sense chat")
    }

    private func testDamagedChatStopsMigration() throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let source = Data("broken chat".utf8)
        try source.write(to: directory.appending(path: "StudyChat.json"))
        do {
            _ = try MiniChatStorage(directory: directory).prepareLegacyImport()
            preconditionFailure("A damaged archive must stop migration")
        } catch is DecodingError {
            expect(!FileManager.default.fileExists(atPath: directory.appending(path: "migration-backup/chat-import-request.json").path),
                   "A damaged archive never creates an empty successful import")
            expect(try Data(contentsOf: directory.appending(path: "StudyChat.json")) == source, "The damaged original remains untouched")
        }
    }

    private func testPendingAIAndDraftRecovery() throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let storage = MiniChatStorage(directory: directory)
        let request = MiniAIStart(kind: .feedback, dayId: "2026-11-13~original", attemptId: UUID())
        try storage.savePending(request)
        let recovered = try MiniChatStorage(directory: directory).pendingRequest()
        expect(recovered?.requestId == request.requestId && recovered?.attemptId == request.attemptId,
               "Uncertain feedback submission retains the original request and answer reference")
        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any]
        expect(encoded?["answer"] == nil && encoded?["history"] == nil && encoded?["prompt"] == nil,
               "AI task inputs reference platform facts instead of copying editable answers")
        expect(encoded?["attemptId"] as? String == request.attemptId?.uuidString.lowercased()
               && encoded?["requestId"] as? String == request.requestId.uuidString.lowercased(),
               "UUID references use the canonical server identity across Swift encoding and retries")
        try storage.clearPending(requestId: UUID())
        expect(try storage.pendingRequest()?.requestId == request.requestId, "A late acknowledgement cannot remove another pending request")
        try storage.clearPending(requestId: request.requestId)
        expect(try storage.pendingRequest() == nil, "A matching receipt removes the outbox item")
        let drafts = ["advisor": "  今天少学一点  "]
        try storage.saveDrafts(drafts)
        expect(try MiniChatStorage(directory: directory).loadDrafts() == drafts, "Unsubmitted chat drafts survive reopening")
        expect(!FileManager.default.fileExists(atPath: directory.appending(path: "StudyChat.json").path),
               "Draft recovery never creates another writable chat archive")
    }

    private func testQualitativeAndLegacyFeedback() throws {
        let fresh = MiniTranslationFeedback(comment: "主要意思清楚。", tip: "注意位置介词。", usefulPhrase: "in my bag · 在我的包里",
                                            strengths: ["人物关系准确"], improvements: ["可补上地点"], keyPoints: ["in 表示在里面"],
                                            referenceTranslation: "苹果在我的包里。")
        let decoded = try JSONDecoder().decode(MiniTranslationFeedback.self, from: JSONEncoder().encode(fresh))
        expect(decoded.outcome == nil && decoded.strengths == fresh.strengths, "New feedback keeps qualitative points without a grade")
        let legacy = Data(#"{"outcome":"partial","comment":"保留原点评","tip":"旧提示","usefulPhrase":"an apple"}"#.utf8)
        let old = try JSONDecoder().decode(MiniTranslationFeedback.self, from: legacy)
        expect(old.outcome == .partial && old.comment == "保留原点评", "Historical graded feedback remains readable without rewriting it")
    }

    private func testWritingPromptsKeepSubmittedMaterial() throws {
        var ledger = MiniDailyLedger()
        var day = ledger.beginOrResume(deck: [word])
        let learned = MiniStudySentence(word: word, english: "I eat an apple.", chinese: "我吃一个苹果。")
        expect(day.addSentences([learned]) && day.markStudied(word), "The fixture follows the actual new-word gate")
        guard var session = day.learning else { preconditionFailure("Missing learning session") }
        expect(session.submitSpelling(word.spelling) && session.advanceSpelling(), "The fixture records a real spelling attempt")
        day.learning = session
        expect(day.completeLearning(), "Only finished spelling enters writing")
        day.writingMode = "prepared"
        expect(day.currentTranslation == nil && MiniDailyAI.preparationKind(for: day) == .writing,
               "A new writing task waits for separately prepared material")
        let prompt = MiniWritingPrompt(id: UUID(), sentence: .init(word: word, english: "The apple is in my bag.", chinese: "苹果在我的包里。"),
                                       direction: .englishToChinese, focusIds: [UUID()], createdAt: .now)
        day.writingPrompts = [prompt]
        expect(day.currentTranslation?.materialId == prompt.id && day.currentTranslation?.sentence != learned,
               "Writing uses a distinct prompt with a stable material identity")
        expect(day.submitTranslation("苹果在我的包里。") != nil, "Save the actual original answer")
        day.writingPrompts = [MiniWritingPrompt(id: UUID(), sentence: learned, direction: .englishToChinese, focusIds: [], createdAt: .now)]
        let restored = try JSONDecoder().decode(MiniDailyDay.self, from: JSONEncoder().encode(day))
        expect(restored.currentTranslation?.materialId == prompt.id && restored.currentTranslation?.sentence == prompt.sentence,
               "An existing attempt keeps its exact material even if later prompts differ")
    }

    private func testServerTaskAndReceiptDecoding() throws {
        let requestId = UUID()
        let jobId = UUID()
        let payload: [String: Any] = [
            "schemaVersion": 1, "revision": 4, "imported": true, "conversations": [],
            "messages": [["id": UUID().uuidString, "conversationId": "advisor", "role": "user", "text": "今天少学",
                          "createdAt": NSNull(), "jobId": jobId.uuidString]],
            "jobs": [["id": jobId.uuidString, "requestId": requestId.uuidString, "kind": "advisor", "status": "interrupted",
                      "conversationId": "advisor", "model": "gpt-6.1-sol", "effort": "xhigh", "progress": "读取学习记录",
                      "text": "", "error": "服务已中断", "createdAt": 800_000_000.25, "updatedAt": 800_000_001,
                      "threadId": NSNull(), "receipts": [["requestId": UUID().uuidString, "tool": "learning_set_plan",
                                                          "revision": 12, "summary": "今日容量已保存为 3 词"]]]],
        ]
        let snapshot = try JSONDecoder().decode(MiniAISnapshot.self, from: JSONSerialization.data(withJSONObject: payload))
        expect(snapshot.messages[0].createdAt == nil, "Unknown legacy message time remains unknown")
        expect(snapshot.jobs[0].status == .interrupted && !snapshot.jobs[0].status.isActive, "Recovery displays the actual persisted task state")
        expect(snapshot.jobs[0].createdAt == Date(timeIntervalSinceReferenceDate: 800_000_000.25), "AI times use the same Swift epoch as learning facts")
        expect(snapshot.jobs[0].receipts[0].revision == 12, "Only a server receipt proves a business write committed")
    }

    private func testLiveAI(baseURL: URL, tokenFile: URL) async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let study = MiniStudyClient(baseURL: baseURL, tokenFile: tokenFile, legacyDirectory: directory)
        let ai = MiniAIClient(study: study)
        _ = try await study.importLegacy(study.prepareLegacyImport())
        let storage = MiniChatStorage(directory: directory)
        let imported = try await ai.importLegacy(storage.prepareLegacyImport())
        try storage.recordImportReceipt(imported)
        let runtime = try await ai.runtime()
        expect(runtime.available && runtime.authenticated && runtime.models.contains { $0.id == "gpt-6.1-sol" },
               "The native client reads the server runtime catalog")
        let request = MiniAIStart(kind: .advisor, message: "今天少学")
        try storage.savePending(request)
        let started = try await ai.start(request)
        let repeated = try await ai.start(request)
        expect(started.id == repeated.id, "Repeating a start acknowledgement does not create another job")
        try storage.clearPending(requestId: request.requestId)
        let completed = try await finish(started, client: ai)
        expect(completed.status == .completed && !completed.receipts.isEmpty,
               "The advisor reports real committed tool receipts")
        let plan = try await study.planPreview(deck: [word])
        expect(plan.planContext?.effective.wordLimit == 3, "The advisor changes the same server-owned plan shown by mini")
        var state = try await study.snapshot()
        func perform(_ action: MiniStudyAction) async throws -> MiniStudySnapshot {
            try await study.perform(MiniStudyCommand(expectedRevision: state.revision, action: action))
        }
        var begin = MiniStudyAction(type: .begin, target: .daily)
        begin.deck = [word]
        begin.timezone = TimeZone.current.identifier
        state = try await perform(begin)
        guard let dayId = state.planning.activeDayId else { preconditionFailure("Missing AI integration group") }
        let prepared = try await finishRequest(MiniAIStart(kind: .prepare, dayId: dayId), client: ai)
        expect(prepared.status == .completed && !prepared.receipts.isEmpty, "Preparation finishes through the shared server runtime and tool")
        state = try await study.snapshot()
        let learningSentence = state.ledger.days.first { $0.id == dayId }?.sentences.first
        expect(learningSentence != nil, "Validated AI learning material is actually saved")
        state = try await perform(MiniStudyAction(type: .markStudied, target: .daily, dayId: dayId, word: word))
        var spelling = MiniStudyAction(type: .submitSpelling, target: .daily, dayId: dayId, session: .learning, word: word)
        spelling.answer = word.spelling
        for _ in 0..<4 {
            guard state.ledger.days.first(where: { $0.id == dayId })?.learning?.phase != .finished else { break }
            state = try await perform(spelling)
        }
        state = try await perform(MiniStudyAction(type: .completeLearning, target: .daily, dayId: dayId))
        let writing = try await finishRequest(MiniAIStart(kind: .writing, dayId: dayId), client: ai)
        expect(writing.status == .completed && !writing.receipts.isEmpty, "Writing material has its own saved task")
        state = try await study.snapshot()
        guard let day = state.ledger.days.first(where: { $0.id == dayId }), let task = day.currentTranslation else {
            preconditionFailure("Missing independently prepared writing task")
        }
        expect(task.sentence != learningSentence && task.materialId != nil, "Writing changes context and retains stable material identity")
        let schedule = day.scheduleUpdates
        var answer = MiniStudyAction(type: .submitTranslation, target: .daily, dayId: dayId)
        answer.taskId = task.id
        answer.answer = task.reference
        state = try await perform(answer)
        guard let attempt = state.ledger.days.first(where: { $0.id == dayId })?.currentAttempt else {
            preconditionFailure("Missing the real user's saved translation")
        }
        let feedback = try await finishRequest(MiniAIStart(kind: .feedback, dayId: dayId, attemptId: attempt.id), client: ai)
        expect(feedback.status == .completed && !feedback.receipts.isEmpty, "Feedback is committed by the same backend runtime")
        state = try await study.snapshot()
        let graded = state.ledger.days.first { $0.id == dayId }
        expect(graded?.currentAttempt?.feedback?.outcome == nil && graded?.currentAttempt?.feedback?.strengths != nil,
               "New writing feedback is qualitative")
        expect(graded?.scheduleUpdates == schedule && graded?.currentAttempt?.answer == answer.answer,
               "Feedback never changes scheduling or the original submitted answer")
        let reconnected = MiniAIClient(study: MiniStudyClient(baseURL: baseURL, tokenFile: tokenFile, legacyDirectory: directory))
        let snapshot = try await reconnected.snapshot()
        expect(snapshot.messages.filter { $0.role == .user && $0.text == request.message }.count == 1,
               "The original user message persists once across client recreation")
        expect(snapshot.jobs.contains { $0.id == completed.id && $0.receipts.count == completed.receipts.count },
               "Reopening keeps the real job status and committed receipts")
    }

    private func finish(_ initial: MiniAIJob, client: MiniAIClient) async throws -> MiniAIJob {
        var job = initial
        let deadline = ContinuousClock.now + .seconds(15)
        while job.status.isActive, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(50))
            job = try await client.job(job.id)
        }
        expect(!job.status.isActive, "The isolated test runtime finishes within its bounded deadline")
        return job
    }

    private func finishRequest(_ request: MiniAIStart, client: MiniAIClient) async throws -> MiniAIJob {
        let job = try await client.start(request)
        return try await finish(job, client: client)
    }

    private func expect(_ value: Bool, _ message: String) { precondition(value, message) }
    private func temporaryDirectory() throws -> URL {
        let directory = URL.temporaryDirectory.appending(path: "lingoweave-ai-client-" + UUID().uuidString.lowercased())
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }
}
