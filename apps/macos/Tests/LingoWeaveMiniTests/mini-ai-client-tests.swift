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
        try tests.testAISelectionAndQueuedAssessment()
        try await tests.testLessonReadRecovery()
        try tests.testFrameIntroductionsRespectStudyOrder()
        try tests.testDialogueRequestsPreserveLearnerAuthorship()
        print("10 mini AI client, model selection, curriculum entry and material tests passed.")
        let environment = ProcessInfo.processInfo.environment
        if let address = environment["MINI_TEST_AI_SERVICE_URL"], let url = URL(string: address),
           let token = environment["MINI_TEST_AI_TOKEN_PATH"] {
            try await tests.testLiveAI(baseURL: url, tokenFile: URL(fileURLWithPath: token))
            print("Swift → HTTP AI task, tool receipt and recovery integration passed.")
        }
    }

    private func testLessonReadRecovery() async throws {
        let delays = Array(repeating: Duration.zero, count: 3)
        var requests = 0
        let progress = try await MiniDailyAI.readWithRetry(delays: delays) {
            requests += 1
            if requests == 1 { throw URLError(.networkConnectionLost) }
            return 25
        }
        expect(progress == 25 && requests == 2, "Observation recovers after a temporary connection failure")
        requests = 0
        do {
            try await MiniDailyAI.readWithRetry(delays: delays) {
                requests += 1
                throw MiniStudyClientError.unavailable
            }
            preconditionFailure("An offline service must eventually return control for manual retry")
        } catch MiniStudyClientError.unavailable {
            expect(requests == 4, "Temporary failures have at most three automatic retries")
        }
        requests = 0
        do {
            try await MiniDailyAI.readWithRetry(delays: delays) {
                requests += 1
                throw MiniStudyClientError.unauthorized
            }
            preconditionFailure("An invalid credential cannot succeed with the same request")
        } catch MiniStudyClientError.unauthorized {
            expect(requests == 1, "An authorization failure requires intervention before retry")
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

    private func testAISelectionAndQueuedAssessment() throws {
        let catalog = MiniChatRuntime(available: true, authenticated: true, models: [
            MiniChatModel(id: "example", name: "Example", supportedReasoningEfforts: ["medium", "high"], defaultReasoningEffort: "high")
        ], error: nil)
        let supported = MiniAISelection(model: "example", effort: "medium")
        expect(catalog.selectionIssue(supported) == nil, "The exact supported combination can be selected")
        expect(catalog.selectionIssue(.initial) != nil, "A missing saved model stays unavailable")
        expect(catalog.selectionIssue(.init(model: "example", effort: "xhigh")) != nil,
               "Selecting a model that lacks the saved effort requires an explicit choice")
        let unavailable = MiniChatRuntime(available: false, authenticated: false, models: catalog.models, error: "offline")
        expect(unavailable.selectionIssue(supported) != nil, "A stale catalog cannot approve a choice while disconnected")

        var action = MiniStudyAction(type: .advanceTranslation, target: .daily, dayId: "example")
        action.taskId = "translation"
        let old = try JSONEncoder().encode(action)
        expect(try JSONDecoder().decode(MiniStudyAction.self, from: old).aiSelection == nil,
               "Older queued actions remain readable")
        action.aiSelection = supported
        let command = MiniStudyCommand(expectedRevision: 7, action: action)
        let outbox = try JSONEncoder().encode(command)
        let replay = try JSONDecoder().decode(MiniStudyCommand.self, from: outbox)
        expect(replay.requestId == command.requestId && replay.action.aiSelection == supported,
               "A queued background assessment retains its original model and effort through replay")
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
        let patterns = MiniPatternClient(study: study)
        expect(try await patterns.phrases(kind: .sentence).total == 0,
               "Preparing a lesson cannot place an unseen example in the phrase library")
        var view = MiniStudyAction(type: .recordCardView, target: .daily, dayId: dayId, session: .learning, word: word)
        view.visibleSentence = learningSentence
        state = try await perform(view)
        let seenSentence = try await patterns.phrases(query: word.meaning, kind: .sentence)
        expect(seenSentence.items.first?.expression == learningSentence?.english && seenSentence.total == 1,
               "Looking at a muted card captures its actual English example for later lookup")
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
        let initial = try await patterns.batch(timezone: "Asia/Shanghai")
        guard let card = initial.next else { preconditionFailure("Expected a new isolated frame batch") }
        let notes = try await patterns.phrases(query: "on the table", kind: .feedback)
        expect(notes.total == 1 && notes.items.first?.status == .feedback,
               "An expression saved in feedback can be looked up independently of practiced frames")
        expect(try await patterns.learnedPatterns().total == 0,
               "The home pattern library excludes visible word examples, translation feedback and unviewed starter frames")
        for _ in 0..<2 { try await patterns.recordView(batchId: initial.batchId, patternId: card.id, timezone: "Asia/Shanghai") }
        let seen = try await patterns.learnedPatterns(query: card.meaning)
        expect(seen.total == 1 && seen.items.first?.status == .viewed && seen.items.first?.exampleEnglish == card.example,
               "Viewing the same frame twice yields one searchable bilingual entry without a practice attempt")
        let miss = MiniPatternSubmission(timezone: "Asia/Shanghai", batchId: initial.batchId, patternId: card.id,
                                         answer: "Unrelated sentence.", usedHint: false, continueAfterFeedback: false)
        let result = try await patterns.practice(miss)
        expect(!result.correct && !result.reference.isEmpty && result.snapshot.next?.id == card.id,
               "An unmatched cue gives feedback but does not silently complete the card")
        let retry = try await patterns.practice(miss)
        expect(retry.reference == result.reference && retry.snapshot.completedIds == result.snapshot.completedIds,
               "Repeating the actual transport request is idempotent")
        let confirmed = try await patterns.practice(MiniPatternSubmission(timezone: miss.timezone,
              batchId: initial.batchId, patternId: card.id, answer: miss.answer, usedHint: true, continueAfterFeedback: true))
        expect(!confirmed.correct && confirmed.snapshot.completedIds.contains(card.id),
               "Reading a reference can continue study without inventing a correct answer")
        let practiced = try await patterns.learnedPatterns(query: card.frame)
        expect(practiced.items.first?.status == .practiced && practiced.items.first?.id == seen.items.first?.id,
               "Returning after practice updates the original frame and preserves its identity")
        let patternPage = try await patterns.learnedPatterns(limit: 1)
        let pastEnd = try await patterns.learnedPatterns(offset: 1, limit: 1)
        expect(patternPage.total == 1 && patternPage.items.first?.id == seen.items.first?.id
               && pastEnd.total == 1 && pastEnd.items.isEmpty,
               "Frame-only pagination and counts exclude feedback and word example matches")
        let firstPage = try await patterns.phrases(limit: 1)
        let secondPage = try await patterns.phrases(offset: 1, limit: 1)
        expect(firstPage.total >= 3 && firstPage.items.count == 1 && secondPage.items.count == 1
               && firstPage.items.first?.id != secondPage.items.first?.id,
               "Browsing can continue across pages without repeating the last entry")
        expect(try await patterns.batch(timezone: miss.timezone).next?.id != card.id,
               "A new native read resumes at the server's next unpracticed card")
        expect(try await study.snapshot().revision == state.revision, "Pattern practice never advances word learning")
        let scene = "dialogue:" + UUID().uuidString.lowercased()
        let reply = "I need a bag."
        for turn in [MiniAIStart(kind: .dialogue, conversationId: scene),
                     MiniAIStart(kind: .dialogue, conversationId: scene, message: reply),
                     MiniAIStart(kind: .dialogue, conversationId: scene, dialogueStep: "reflect")] {
            let result = try await finishRequest(turn, client: ai)
            expect(result.kind == .dialogue && result.status == .completed && result.receipts.isEmpty &&
                   result.dialogueStep == turn.dialogueStep, "Dialogue returns a read-only turn or reflection")
        }
        let dialogue = try await reconnected.snapshot().messages.filter { $0.conversationId == scene }
        expect(dialogue.filter { $0.role == .user }.map(\.text) == [reply] && dialogue.filter { $0.role == .assistant }.count == 3,
               "Reopening the scene shows original learner input and never invents an opening or closing message")
        expect(try await study.snapshot().revision == state.revision, "Dialogue and reflection do not alter study facts")
    }

    private func testFrameIntroductionsRespectStudyOrder() throws {
        func context(due: Int = 0, pending: String? = nil, mode: MiniPlanMode = .normal,
                     remaining: Int = 10, canStart: Bool = true) -> MiniPlanContext {
            MiniPlanContext(date: "2026-11-18", timezone: "Asia/Shanghai",
                effective: .init(mode: mode, wordLimit: 10, newWordLimit: 10), todayOverride: nil, dueCount: due,
                newCount: 100, lastActivityAt: nil, absenceDays: 0, recoverySuggested: false, recoveryWordLimit: 3,
                pendingDayId: pending, pendingGroups: [], canStart: canStart, canContinue: pending != nil, blockedReason: nil,
                remainingNewCount: remaining, hasDueReviews: due > 0)
        }
        let start = MiniPatternStartIntent(dayId: nil)
        expect(start.offersIntroduction(context()), "A fresh word start offers a frame introduction")
        expect(!start.offersIntroduction(context(due: 1)), "Due reviews always come first")
        expect(!start.offersIntroduction(context(pending: "existing")), "Do not interrupt a saved group")
        expect(!start.offersIntroduction(context(mode: .reviewOnly)), "No curriculum gate on review-only days")
        expect(!start.offersIntroduction(context(mode: .rest)), "No curriculum gate on rest days")
        expect(!start.offersIntroduction(context(remaining: 0)), "Do not open frames after the goal is reached")
        let today = context(pending: "today", canStart: false)
        expect(today.hasTaskAfterReview && !start.offersIntroduction(today),
               "Returning from a review side group within the day resumes today's in-progress learning")
        let freshDay = context()
        expect(freshDay.hasTaskAfterReview && start.offersIntroduction(freshDay),
               "After overnight unfinished work, today's fresh plan can proceed directly into today's frames")
        expect(context(mode: .normal).hasTaskAfterReview && context(due: 1, mode: .reviewOnly).hasTaskAfterReview,
               "The next planned step can be a fresh task or another due-review batch")
        expect(!context(mode: .rest).hasTaskAfterReview && !context(canStart: false).hasTaskAfterReview,
               "Rest and exhausted plans stop at the end of review without beginning another group")
        for mode in [MiniPlanMode.normal, .reviewOnly] {
            let more = context(due: 270, mode: mode)
            expect(more.afterCompletingReview(activePhase: .review) == .activeReview,
                   "A committed next review group stays open without starting it a second time")
            expect(more.afterCompletingReview(activePhase: .learning) == .begin,
                   "Any remaining due words take priority over a prepared learning group")
        }
        expect(today.afterCompletingReview(activePhase: .learning) == .activeStudy,
               "The final side group can resume the prepared original day despite the change of id")
        expect(context(mode: .reviewOnly).afterCompletingReview(activePhase: .finished) == .home,
               "Review-only mode finishes when every due group is complete")
        var reviewStart = start
        reviewStart.entry = .review
        expect(!reviewStart.offersIntroduction(freshDay) &&
               freshDay.afterCompletingReview(activePhase: .learning, intent: .review) == .home,
               "A dedicated review finishes at home even when the server has a new-word group ready")
        var rest = context(due: 7, mode: .rest, canStart: false)
        rest.canStartReview = true
        rest.canStartLearning = false
        rest.canStartExtraGroup = true
        var extra = start
        extra.extraGroupForDate = rest.date
        expect(rest.reviewAvailable && !rest.learningAvailable &&
               rest.afterCompletingReview(activePhase: .finished, intent: .review) == .begin &&
               !extra.offersIntroduction(rest),
               "Rest-day due reviews remain available between batches and precede optional new-word practice")
        var cleared = context(mode: .rest, canStart: false)
        cleared.canStartReview = false
        cleared.canStartLearning = false
        cleared.canStartExtraGroup = true
        expect(!reviewStart.offersIntroduction(cleared) && extra.offersIntroduction(cleared) &&
               !start.offersIntroduction(cleared) &&
               cleared.afterCompletingReview(activePhase: .finished, intent: .review) == .home,
               "On a rest day only explicitly requested extra practice opens starter patterns")
        cleared.canStartLearning = true
        expect(cleared.learningAvailable &&
               cleared.afterCompletingReview(activePhase: .learning, intent: .learn) == .activeStudy,
               "A granted rest-day new-word group can continue after reviews without authorizing a second group")
        extra.extraGroupForDate = "2026-11-17"
        expect(!extra.offersIntroduction(cleared), "Yesterday's extra-group click cannot start today's pattern introduction")
        var explicit = start
        explicit.dayId = "previous"
        expect(!explicit.offersIntroduction(context()), "Explicitly continuing a task keeps its position")
    }

    private func testDialogueRequestsPreserveLearnerAuthorship() throws {
        let scene = "dialogue:" + UUID().uuidString.lowercased()
        let encoder = JSONEncoder()
        for input in [MiniAIStart(kind: .dialogue, conversationId: scene),
                      MiniAIStart(kind: .dialogue, conversationId: scene, message: "I need a bag."),
                      MiniAIStart(kind: .dialogue, conversationId: scene, dialogueStep: "reflect")] {
            let copy = try JSONDecoder().decode(MiniAIStart.self, from: encoder.encode(input))
            expect(copy.conversationId == scene && copy.kind == .dialogue && copy.dayId == nil && copy.word == nil,
                   "The scene can never be interpreted as a daily study or advisor submission")
            expect(copy.message == input.message && copy.dialogueStep == input.dialogueStep,
                   "Start and reflection have no synthetic learner utterance")
        }
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
