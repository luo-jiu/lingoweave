import Foundation

@main
struct MiniStudyClientTests {
    static func main() async throws {
        let tests = Self()
        try tests.testLegacyBackupAndImportIdentity()
        try tests.testDamagedHistoryStopsImport()
        try tests.testPendingCommandRecovery()
        try tests.testImmediateReviewInputs()
        try tests.testAutomaticSpellingProjection()
        try tests.testQueuedMemoryWindowFeedback()
        try await tests.testSlowReviewJournal()
        try tests.testBrowseViewportRecovery()
        try tests.testUnsubmittedDraftRecovery()
        try tests.testSnapshotKeepsSwiftDatesAndFacts()
        try tests.testPlanCommandRecoveryKeepsScope()
        try tests.testServerPlanContextDecodesWithoutLocalInference()
        try tests.testBackgroundMaterialsAllowOnlyUnchangedLearningActions()
        try tests.testRebaseRejectsChangedFactsAndReplacedMaterials()
        try tests.testWindowReadModelAndCommandRecovery()
        try tests.testAssessmentAuditDecodesWithoutInventingScores()
        try tests.testDailyTranslationCommentary()
        try tests.testAssessmentRebaseRequiresAnExactAppendOnlyChangeChain()
        print("18 mini service client recovery and translation review tests passed.")
        let environment = ProcessInfo.processInfo.environment
        if let address = environment["MINI_TEST_SERVICE_URL"], let url = URL(string: address),
           let token = environment["MINI_TEST_TOKEN_PATH"] {
            try await tests.testLiveService(baseURL: url, tokenFile: URL(fileURLWithPath: token))
            print("Swift → HTTP → SQLite mini study integration passed.")
            try await tests.testBackgroundSaveRetries(baseURL: url, tokenFile: URL(fileURLWithPath: token))
            print("3 background save retry checks passed with stable request identity and a three-retry limit.")
        }
        if let address = environment["MINI_TEST_FLOW_SERVICE_URL"], let url = URL(string: address),
           let token = environment["MINI_TEST_FLOW_TOKEN_PATH"] {
            try await tests.testLiveWindowFlow(baseURL: url, tokenFile: URL(fileURLWithPath: token))
            print("Swift → HTTP interleaved window, grouped spelling and asynchronous translation passed.")
        }
        if let address = environment["MINI_TEST_GROUPS_SERVICE_URL"], let url = URL(string: address),
           let token = environment["MINI_TEST_GROUPS_TOKEN_PATH"] {
            try await tests.testLiveDailyRestart(baseURL: url, tokenFile: URL(fileURLWithPath: token))
            print("Swift → HTTP overnight restart, same-day resume and review-first integration passed.")
        }
    }

    private let word = MiniWord(spelling: "apple", meaning: "苹果", phonetic: "/ˈæpəl/")

    private func testLegacyBackupAndImportIdentity() throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        var ledger = MiniDailyLedger()
        _ = ledger.beginOrResume(deck: [word])
        let ledgerData = try JSONEncoder().encode(ledger)
        var session = MiniReviewSession(words: [word])
        session.chooseJudgment(.fuzzy)
        let review = MiniReviewRecord(session: session, paused: true, nextWordIndex: 4)
        let recordData = try JSONEncoder().encode(review)
        try write(ledgerData, to: root.appending(path: "DailyStudy/ledger.json"))
        try write(recordData, to: root.appending(path: "Review/current.json"))
        try write(recordData, to: root.appending(path: "Review/History/" + review.id.uuidString + ".json"))

        let client = MiniStudyClient(legacyDirectory: root)
        let imported = try client.prepareLegacyImport()
        expect(imported.ledger == ledger, "Migration preserves the full daily ledger")
        expect(imported.reviewRecord?.id == review.id && imported.reviewRecord?.paused == true,
               "Pending standalone review is imported without restarting it")
        expect(imported.reviewHistory.map(\.id) == [review.id], "Archived review records remain available")
        expect(try Data(contentsOf: root.appending(path: "migration-backup/daily-study/ledger.json")) == ledgerData,
               "Daily backup is an exact original-byte copy")
        expect(try Data(contentsOf: root.appending(path: "migration-backup/review/current.json")) == recordData,
               "Review backup is an exact original-byte copy")
        expect(try Data(contentsOf: root.appending(path: "DailyStudy/ledger.json")) == ledgerData,
               "Import never deletes or rewrites source files")
        expect(try client.prepareLegacyImport().requestId == imported.requestId,
               "Retrying an import reuses its original request identity")
    }

    private func testBackgroundSaveRetries(baseURL: URL, tokenFile: URL) async throws {
        struct Request: Encodable { let requestId: String; let mode: String }
        struct Result: Decodable, Sendable { let requestId: String; let attempts: Int }
        let client = MiniStudyClient(baseURL: baseURL, tokenFile: tokenFile)
        for mode in ["eventual", "exhausted", "conflict"] {
            let id = UUID().uuidString.lowercased()
            let body = try JSONEncoder().encode(Request(requestId: id, mode: mode))
            do {
                let result: Result = try await client.serviceRequest(path: "test-save-retries", body: body)
                expect(mode == "eventual" && result.requestId == id && result.attempts == 4,
                       "Three transient failures retry the exact original request")
            } catch MiniStudyClientError.unavailable {
                expect(mode == "exhausted", "Only exhausted transient requests may stop after retries")
            } catch MiniStudyClientError.conflict {
                expect(mode == "conflict", "A revision conflict remains a caller decision")
            }
            let observed: Result = try await client.serviceRequest(path: "test-save-retries/" + id, body: nil)
            expect(observed.requestId == id && observed.attempts == (mode == "conflict" ? 1 : 4),
                   "Retries stop after three additional attempts, and conflicts never loop")
        }
    }

    private func testDamagedHistoryStopsImport() throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let broken = Data("not json".utf8)
        try write(broken, to: root.appending(path: "Review/History/broken.json"))
        do {
            _ = try MiniStudyClient(legacyDirectory: root).prepareLegacyImport()
            preconditionFailure("A damaged history record must block the whole import")
        } catch is DecodingError {
            expect(!FileManager.default.fileExists(atPath: root.appending(path: "migration-backup/import-request.json").path),
                   "No partial import payload is created")
            expect(try Data(contentsOf: root.appending(path: "Review/History/broken.json")) == broken,
                   "Damaged history remains untouched")
        }
    }

    private func testPendingCommandRecovery() throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let client = MiniStudyClient(legacyDirectory: root)
        var action = MiniStudyAction(type: .submitSpelling, target: .daily, dayId: "2026-11-13", session: .learning, word: word)
        action.answer = "  aple  "
        let first = MiniStudyCommand(expectedRevision: 7, action: action)
        try client.savePending(first)
        let recovered = try MiniStudyClient(legacyDirectory: root).pendingCommand()
        expect(recovered?.requestId == first.requestId && recovered?.expectedRevision == 7,
               "Relaunch preserves the original retry identity and state version")
        expect(recovered?.action.answer == "  aple  ", "Outbox keeps the original submitted answer unchanged")
        expect(recovered?.occurredAt == first.occurredAt && first.occurredAt != nil,
               "Retrying a recorded command preserves when the user actually acted")
        let second = MiniStudyCommand(expectedRevision: 8, action: action)
        try client.savePending(second)
        try client.clearPending(requestId: first.requestId)
        expect(try client.pendingCommand()?.requestId == second.requestId, "A late acknowledgement cannot erase a newer pending command")
        try client.clearPending(requestId: second.requestId)
        expect(try client.pendingCommand() == nil, "A matching receipt clears the outbox")
    }

    private func testImmediateReviewInputs() throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let second = MiniWord(spelling: "bag", meaning: "袋子")
        let initial = MiniReviewSession(words: [word, second], startingWithSpelling: true)
        var card = initial
        var pending: [MiniReviewInput] = []
        func input(_ type: MiniStudyAction.Kind, answer: String? = nil) -> MiniReviewInput {
            var action = MiniStudyAction(type: type, target: .daily, dayId: "2026-11-20", session: .review, word: card.currentWord)
            action.answer = answer
            guard let result = MiniReviewInput(action: action, session: card) else { preconditionFailure("Expected a valid review input") }
            pending.append(result)
            return result
        }
        let miss = input(.submitSpelling, answer: "aple")
        expect(miss.present(in: &card) && card.spellingState == .correcting, "Show an incorrect first answer without a receipt")
        expect(!miss.present(in: &card), "A repeated or delayed submission cannot count a second attempt")
        let correction = input(.submitSpelling, answer: " APPLE ")
        expect(correction.present(in: &card) && card.spellingState == .readyToAdvance, "A fast correction turns green while its first answer is pending")
        let next = input(.advanceSpelling)
        expect(next.present(in: &card) && card.currentWord == second, "Use the server-provided next word before the preceding receipt")
        let right = input(.submitSpelling, answer: "bag")
        expect(right.present(in: &card) && card.spellingState == .readyToAdvance, "The new word accepts input before the preceding save completes")
        let round = input(.advanceSpelling)
        expect(!round.present(in: &card) && card.currentWord == second, "Leave assigning the next spelling round to the service")
        expect(initial.spellingAttempts.isEmpty, "Visual feedback does not mutate the acknowledged snapshot")

        let client = MiniStudyClient(legacyDirectory: root)
        try client.saveReviewInputs(pending)
        let recovered = try MiniStudyClient(legacyDirectory: root).pendingReviewInputs()
        expect(recovered.map(\.id) == pending.map(\.id) && recovered.map(\.occurredAt) == pending.map(\.occurredAt),
               "Relaunch retains each original input identity, order and occurrence time")
        expect(recovered.map(\.action.answer) == ["aple", " APPLE ", nil, "bag", nil], "Preserve the exact original answers")
        var afterReceipt = initial
        expect(afterReceipt.submitSpelling("aple", at: miss.occurredAt), "Reconcile against a saved first answer")
        for item in recovered.dropFirst() { item.present(in: &afterReceipt) }
        expect(afterReceipt == card, "Removing a confirmed prefix preserves the newer displayed result")
        expect(!MiniReviewSession.matchesSpelling("STRASSE", word: "Straße"), "Do not turn a distinct spelling green through localized comparison")
    }

    private func testAutomaticSpellingProjection() throws {
        let words = [word, MiniWord(spelling: "bag", meaning: "袋子")]
        var displayed = MiniReviewSession(windowWords: words, seed: UUID())
        guard let first = displayed.currentWord, let second = words.first(where: { $0 != first }) else {
            preconditionFailure("Missing spelling queue")
        }
        let at = Date(timeIntervalSinceReferenceDate: 812_345_678)
        func input(_ answer: String) -> MiniReviewInput {
            var action = MiniStudyAction(type: .submitSpelling, target: .daily, dayId: "2026-11-20",
                                         session: .review, word: displayed.currentWord)
            action.answer = answer
            action.advanceOnCorrect = false
            action.advanceAfterCorrect = true
            guard let result = MiniReviewInput(action: action, session: displayed, at: at) else {
                preconditionFailure("Missing spelling input")
            }
            return result
        }
        let wrong = input("wrong")
        expect(wrong.present(in: &displayed) && displayed.currentWord == first &&
               displayed.spellingState == .correcting, "A wrong answer still shows its correction in simple mode")
        let correction = input(first.spelling)
        let restored = try JSONDecoder().decode(MiniReviewInput.self, from: JSONEncoder().encode(correction))
        expect(restored.action.advanceAfterCorrect == true, "Retry preserves the appearance's opt-in as part of the original input")
        expect(restored.present(in: &displayed) && displayed.currentWord == second &&
               displayed.spellingState == .awaitingFirst &&
               displayed.spellingAttempts.map(\.correct) == [false, true],
               "A correct correction advances immediately to the already assigned card and retains both attempts")
        let boundary = input(second.spelling)
        expect(boundary.present(in: &displayed) && displayed.currentWord == second &&
               displayed.spellingState == .readyToAdvance,
               "The shuffle at the next spelling round waits for the service receipt")
    }

    private func testQueuedMemoryWindowFeedback() throws {
        let at = Date(timeIntervalSinceReferenceDate: 812_345_678)
        var ledger = MiniDailyLedger()
        let day = ledger.beginOrResume(deck: [word], at: at)
        let groupId = UUID()
        func visit(_ id: UUID = UUID(), stage: Int = 1) -> MiniMemoryWindow.Visit {
            .init(id: id, word: word, stage: stage, openedAt: at, initial: nil, selectedAt: nil,
                  revealedAt: nil, correctedAt: nil, draft: "")
        }
        func snapshot(_ visit: MiniMemoryWindow.Visit, revision: Int) throws -> MiniStudySnapshot {
            var copy = ledger
            let window = MiniMemoryWindow(version: "v2", size: 5, gap: 3, members: [], visit: visit,
                                          events: [], sequence: 0, forceUnseen: false)
            copy.days[0].flow = MiniLearningFlow(version: "v2", targetDate: day.id, dailyNewGoal: 10, completedBeforeRun: 0,
                                                  groupSize: 10, candidates: [word], candidateIndex: 1, window: window, groupId: groupId,
                                                  groupIndex: 1, groupStartedAt: at, groupTarget: 1, groupWords: [],
                                                  translationWords: [], groups: [], completed: [], goalReached: false)
            return try rebaseSnapshot(ledger: copy, revision: revision)
        }
        var displayed = visit()
        let confirmed = displayed
        func action(_ kind: MiniStudyAction.Kind) -> MiniStudyAction {
            .window(kind, dayId: day.id, session: .learning, visit: displayed, draft: "")
        }
        var pick = action(.windowChoose)
        pick.remembered = true
        guard let choice = MiniReviewInput(action: pick, visit: displayed, at: at) else { preconditionFailure("Expected recall choice") }
        expect(choice.present(in: &displayed) && displayed.showsFullCard && displayed.completedStages == 2,
               "The current word reveals its card and gains a dot immediately while its receipt is pending")
        let shown = displayed
        let view = MiniStudyAction(type: .recordCardView, target: .daily, dayId: day.id, session: .learning, word: word)
        guard let exposure = MiniReviewInput(action: view, visit: displayed),
              let correction = MiniReviewInput(action: action(.windowCorrect), visit: displayed) else { preconditionFailure("Expected revealed card") }
        expect(correction.present(in: &displayed) && displayed.completedStages == 0 && displayed.advancesAutomatically,
               "A quick correction after recall clears the dots before saving")
        guard let advance = MiniReviewInput(action: action(.windowAdvance), visit: displayed) else { preconditionFailure("Expected automatic advance") }
        expect(!advance.present(in: &displayed), "Only the service chooses the next word")

        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let client = MiniStudyClient(legacyDirectory: root)
        try client.saveReviewInputs([choice, exposure, correction, advance])
        let recovered = try client.pendingReviewInputs()
        expect(recovered.map(\.id) == [choice.id, exposure.id, correction.id, advance.id],
               "Rapid actions and the revealed exposure recover in their original order")
        let first = try snapshot(confirmed, revision: 1)
        let revealed = try snapshot(shown, revision: 2)
        let corrected = try snapshot(displayed, revision: 3)
        let later = try snapshot(visit(), revision: 4)
        expect(choice.matches(first) && !exposure.matches(first) && exposure.matches(revealed)
               && correction.matches(revealed) && !correction.matches(corrected) && advance.matches(corrected),
               "Each queued action is sent only after its exact predecessor's state has arrived")
        expect(recovered.allSatisfy { !$0.matches(later) }, "A new visit to the same word cannot receive even a delayed observation")
        let full = visit(stage: 0)
        var familiar = MiniStudyAction.window(.windowFamiliar, dayId: day.id, session: .learning, visit: full, draft: "")
        expect(MiniReviewInput(action: familiar, visit: full) != nil, "A new full card accepts familiar while its observation is pending")
        familiar.session = .review
        expect(MiniReviewInput(action: familiar, visit: full) == nil, "Familiar does not skip review relearning")
    }

    private func testSlowReviewJournal() async throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let client = MiniStudyClient(legacyDirectory: root)
        var card = MiniReviewSession(words: [word], startingWithSpelling: true)
        var action = MiniStudyAction(type: .submitSpelling, target: .review, recordId: UUID(), word: word)
        action.answer = "aple"
        guard let first = MiniReviewInput(action: action, session: card), first.present(in: &card) else {
            preconditionFailure("Expected an incorrect answer")
        }
        action.answer = "apple"
        guard let correction = MiniReviewInput(action: action, session: card) else {
            preconditionFailure("Expected a correction")
        }
        let (started, signal) = AsyncStream<Bool>.makeStream()
        let release = DispatchSemaphore(value: 0)
        let journal = MiniReviewJournal { inputs in
            if inputs.map(\.id) == [first.id] {
                signal.yield(true)
                signal.finish()
                precondition(release.wait(timeout: .now() + 5) == .success, "A blocked write must leave the caller free to accept the correction")
            }
            try client.saveReviewInputs(inputs)
        }
        journal.replace([first])
        var writes = started.makeAsyncIterator()
        expect(await writes.next() == true, "The disk writer starts independently")
        journal.replace([first, correction])
        journal.replace([correction])
        release.signal()
        expect(await journal.flushed(), "The latest queued state reaches disk")
        let recovered = try MiniStudyClient(legacyDirectory: root).pendingReviewInputs()
        expect(recovered.map(\.id) == [correction.id] && recovered.first?.action.answer == "apple",
               "An older slow write cannot overwrite a later submission or resurrect an acknowledged one")
    }

    private func testUnsubmittedDraftRecovery() throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let client = MiniStudyClient(legacyDirectory: root)
        let drafts = ["translation/2026-11-13/0": "  我还没有提交。  "]
        try client.saveDrafts(drafts)
        expect(try MiniStudyClient(legacyDirectory: root).loadDrafts() == drafts,
               "Unsubmitted input survives relaunch independently of committed facts")
        expect(!FileManager.default.fileExists(atPath: root.appending(path: "DailyStudy/ledger.json").path),
               "Draft recovery does not create a second writable learning ledger")
    }

    private func testBrowseViewportRecovery() throws {
        var viewport = MiniBrowseViewport()
        let rows = (0..<90).map { MiniWord(spelling: "word\($0)", meaning: "释义\($0)") }
        let otherSense = MiniWord(spelling: rows[0].spelling, meaning: "另一义项")
        let layout = rows + [rows[0], otherSense]
        let at = Date(timeIntervalSinceReferenceDate: 800_000_123)
        let commands = viewport.update(layout, visible: true, revision: 17, at: at)
        expect(commands.map { $0.action.words?.count } == [64, 27], "Large windows are bounded and exact duplicates are removed")
        let duplicate = viewport.update(layout.reversed(), visible: true, revision: 18)
        expect(duplicate.isEmpty, "Reordering the same visible words is not another exposure")
        let scrolled = viewport.update([rows[0]], visible: true, revision: 18)
        expect(scrolled.flatMap { $0.action.words ?? [] }.count == 90, "Only words that actually leave are recorded")
        expect(viewport.update([rows[0]], visible: false, revision: 18).first?.action.words == [rows[0]], "Window hiding ends the remaining visible row")
        expect(viewport.update([rows[1]], visible: false, revision: 18).isEmpty, "A background layout is not learner exposure")
        expect(viewport.update(viewport.rows, visible: true, revision: 18).first?.action.words == [rows[1]], "Reopening records the currently displayed word")
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let client = MiniStudyClient(legacyDirectory: root)
        try client.saveBrowseViews(commands)
        let replay = try MiniStudyClient(legacyDirectory: root).pendingBrowseViews()
        expect(replay.map(\.requestId) == commands.map(\.requestId) && replay.allSatisfy { $0.occurredAt == at },
               "Unacknowledged batches keep their exact original identity and times")
    }

    private func testSnapshotKeepsSwiftDatesAndFacts() throws {
        var ledger = MiniDailyLedger()
        let time = Date(timeIntervalSinceReferenceDate: 800_000_000.25)
        _ = ledger.beginOrResume(deck: [word], at: time)
        let ledgerObject = try JSONSerialization.jsonObject(with: JSONEncoder().encode(ledger))
        let payload: [String: Any] = [
            "schemaVersion": 1, "revision": 9, "imported": true,
            "ledger": ledgerObject, "reviewRecord": NSNull(), "reviewHistory": [],
            "planning": planningObject,
        ]
        let snapshot = try JSONDecoder().decode(MiniStudySnapshot.self, from: JSONSerialization.data(withJSONObject: payload))
        expect(snapshot.revision == 9 && snapshot.imported, "Native decodes the authoritative service envelope")
        expect(snapshot.ledger.days.first?.startedAt == time, "Service dates preserve the Swift epoch and subsecond facts")
        expect(snapshot.ledger.days.first?.learningWords == [word], "Snapshot preserves the frozen word cohort")
    }

    private var planningObject: [String: Any] {
        ["longTerm": ["weekdays": [1, 2, 3, 4, 5, 6, 7], "wordLimit": 10, "newWordLimit": 5],
         "dailyOverrides": [], "nextSessionOverride": NSNull(), "sessions": [], "activeDayId": NSNull()]
    }

    private func testPlanCommandRecoveryKeepsScope() throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let client = MiniStudyClient(legacyDirectory: root)
        var action = MiniStudyAction(type: .setTodayPlan, target: .daily)
        action.date = "2026-11-13"
        action.timezone = "Pacific/Auckland"
        action.mode = .rest
        action.wordLimit = 2
        action.newWordLimit = 0

        let original = MiniStudyCommand(expectedRevision: 13, action: action)
        try client.savePending(original)
        let recovered = try client.pendingCommand()
        expect(recovered?.requestId == original.requestId && recovered?.expectedRevision == 13,
               "A plan retry preserves its identity and expected version")
        expect(recovered?.action.date == "2026-11-13" && recovered?.action.timezone == "Pacific/Auckland"
               && recovered?.action.mode == .rest && recovered?.action.wordLimit == 2,
               "A today's-only retry keeps the original local date, timezone, scope and requested capacity")
        expect(recovered?.occurredAt == original.occurredAt, "A recovered plan command does not pretend it was just requested")
    }

    private func testServerPlanContextDecodesWithoutLocalInference() throws {
        let payload: [String: Any] = [
            "schemaVersion": 1, "revision": 3, "imported": true,
            "ledger": ["days": []], "reviewRecord": NSNull(), "reviewHistory": [], "planning": planningObject,
            "planContext": [
                "date": "2026-11-14", "timezone": "Pacific/Auckland",
                "effective": ["mode": "reviewOnly", "wordLimit": 3, "newWordLimit": 0],
                "todayOverride": NSNull(), "dueCount": 17, "newCount": 23,
                "lastActivityAt": 800_000_000.25, "absenceDays": 4,
                "recoverySuggested": true, "recoveryWordLimit": 2,
                "pendingDayId": "2026-11-14", "canStart": false, "canContinue": true, "blockedReason": NSNull(),
                "pendingGroups": [["dayId": "2026-11-14~8ea55acf-a131-46f7-a15c-854f7ba58114", "phase": "learning",
                                   "paused": true, "startedAt": 800_000_000.25, "canContinue": false,
                                   "blockedReason": "今天只安排到期复习。"],
                                  ["dayId": "2026-11-14", "phase": "review", "paused": false,
                                   "startedAt": 800_000_001.25, "canContinue": true, "blockedReason": NSNull()]],
            ],
        ]
        let snapshot = try JSONDecoder().decode(MiniStudySnapshot.self, from: JSONSerialization.data(withJSONObject: payload))
        expect(snapshot.planContext?.date == "2026-11-14" && snapshot.planContext?.timezone == "Pacific/Auckland",
               "The client uses the service's date and timezone rather than re-deriving today's scope")
        expect(snapshot.planContext?.dueCount == 17 && snapshot.planContext?.effective.mode == .reviewOnly,
               "Real due counts and resolved plan mode come from the server")
        expect(snapshot.planContext?.recoveryWordLimit == 2 && snapshot.planContext?.canContinue == true,
               "Recovery capacity and whether continuation is allowed remain service-owned")
        expect(snapshot.planContext?.lastActivityAt == Date(timeIntervalSinceReferenceDate: 800_000_000.25),
               "Planning timestamps keep the same Swift epoch as learning facts")
        expect(snapshot.planContext?.pendingGroups.first?.dayId.contains("~") == true
               && snapshot.planContext?.pendingGroups.first?.canContinue == false,
               "Today's unavailable group keeps its stable identity and service-owned continuation permission")
        let timestamp = ISO8601DateFormatter()
        guard let zone = TimeZone(identifier: "Pacific/Auckland"),
              let start = timestamp.date(from: "2026-11-13T11:00:00Z"),
              let beforeMidnight = timestamp.date(from: "2026-11-14T10:59:59Z"),
              let midnight = timestamp.date(from: "2026-11-14T11:00:00Z") else { preconditionFailure("Invalid test date") }
        expect(snapshot.planContext?.includesDate(beforeMidnight) == true && snapshot.planContext?.includesDate(midnight) == false,
               "A visible card expires at midnight in the plan timezone, including daylight saving")
        expect(snapshot.planContext?.matchesLocalDay(at: beforeMidnight, in: zone) == true
               && snapshot.planContext?.matchesLocalDay(at: beforeMidnight, in: .gmt) == false
               && snapshot.planContext?.matchesLocalDay(at: midnight, in: zone) == false,
               "A plan response crossing midnight or arriving after a timezone switch is stale")
        expect(snapshot.planContext?.dayInterval == DateInterval(start: start, end: midnight),
               "The homepage date and activity share the server-confirmed day boundaries")

    }

    private func rebaseSnapshot(ledger: MiniDailyLedger, record: MiniReviewRecord? = nil, revision: Int,
                                mutate: ((inout [String: Any]) -> Void)? = nil) throws -> MiniStudySnapshot {
        var planning = planningObject
        if let id = ledger.days.last?.id { planning["activeDayId"] = id }
        var payload: [String: Any] = [
            "schemaVersion": 1, "revision": revision, "imported": true,
            "ledger": try JSONSerialization.jsonObject(with: JSONEncoder().encode(ledger)),
            "reviewRecord": try record.map { try JSONSerialization.jsonObject(with: JSONEncoder().encode($0)) } ?? NSNull(),
            "reviewHistory": [], "planning": planning,
            "teaching": ["focusItems": [], "memories": [], "exposures": []],
        ]
        mutate?(&payload)
        return try JSONDecoder().decode(MiniStudySnapshot.self, from: JSONSerialization.data(withJSONObject: payload))
    }

    private func testBackgroundMaterialsAllowOnlyUnchangedLearningActions() throws {
        let book = MiniWord(spelling: "book", meaning: "书")
        let at = Date(timeIntervalSinceReferenceDate: 800_000_000.25)
        var ledger = MiniDailyLedger()
        let day = ledger.beginOrResume(deck: [word, book], at: at)
        let first = MiniStudySentence(word: word, english: "I eat an apple.", chinese: "我吃一个苹果。")
        let second = MiniStudySentence(word: book, english: "I read a book.", chinese: "我读一本书。")
        var prepared = ledger
        expect(prepared.days[0].addSentences([first]), "The preparation fixture appends a real missing example")
        let record = MiniReviewRecord(session: MiniReviewSession(words: [word]), nextWordIndex: 0)
        let before = try rebaseSnapshot(ledger: ledger, record: record, revision: 8)
        let after = try rebaseSnapshot(ledger: prepared, record: record, revision: 9)
        var choose = MiniStudyAction(type: .chooseJudgment, target: .review, recordId: record.id, word: word)
        choose.judgment = .clear
        expect(MiniStudyClient.eligibleRebase(command: .init(expectedRevision: 8, action: choose, occurredAt: at), before: before, after: after),
               "A background example cannot discard an unchanged review judgment")

        var chosen = record
        expect(chosen.session.chooseJudgment(.clear, at: at), "The next fixture contains an actual selected judgment")
        let advance = MiniStudyAction(type: .advanceJudgment, target: .review, recordId: chosen.id, word: word)
        expect(MiniStudyClient.eligibleRebase(command: .init(expectedRevision: 8, action: advance, occurredAt: at),
                                            before: try rebaseSnapshot(ledger: ledger, record: chosen, revision: 8),
                                            after: try rebaseSnapshot(ledger: prepared, record: chosen, revision: 9)),
               "Finalizing the same selected judgment remains eligible")

        let spellingRecord = MiniReviewRecord(session: MiniReviewSession(words: [word], startingWithSpelling: true), nextWordIndex: 0)
        var spelling = MiniStudyAction(type: .submitSpelling, target: .review, recordId: spellingRecord.id, word: word)
        for answer in ["  aple  ", ""] {
            spelling.answer = answer
            expect(MiniStudyClient.eligibleRebase(command: .init(expectedRevision: 8, action: spelling, occurredAt: at),
                                                before: try rebaseSnapshot(ledger: ledger, record: spellingRecord, revision: 8),
                                                after: try rebaseSnapshot(ledger: prepared, record: spellingRecord, revision: 9)),
                   "A raw first answer, including a blank, remains eligible when the spelling session is unchanged")
        }

        var fullyPrepared = prepared
        expect(fullyPrepared.days[0].addSentences([second]), "The next fixture adds only the second word's example")
        let mark = MiniStudyCommand(expectedRevision: 8, action: .init(type: .markStudied, target: .daily, dayId: day.id, word: word), occurredAt: at)
        expect(MiniStudyClient.eligibleRebase(command: mark,
                                            before: try rebaseSnapshot(ledger: prepared, revision: 8),
                                            after: try rebaseSnapshot(ledger: fullyPrepared, revision: 9)),
               "Marking the same displayed prepared word survives another word's background preparation")
        let focusOnly = try rebaseSnapshot(ledger: ledger, record: record, revision: 9) { payload in
            payload["teaching"] = ["focusItems": [["futureFocusField": "background note"]], "memories": [], "exposures": []]
            payload["planContext"] = [
                "date": "2026-11-16", "timezone": "Asia/Shanghai",
                "effective": ["mode": "normal", "wordLimit": 10, "newWordLimit": 5],
                "todayOverride": NSNull(), "dueCount": 0, "newCount": 2, "lastActivityAt": NSNull(),
                "absenceDays": 0, "recoverySuggested": false, "recoveryWordLimit": 2,
                "pendingDayId": day.id, "pendingGroups": [], "canStart": false, "canContinue": true, "blockedReason": NSNull(),
            ]
        }
        expect(MiniStudyClient.eligibleRebase(command: .init(expectedRevision: 8, action: choose, occurredAt: at), before: before, after: focusOnly),
               "Background focus changes and computed plan preview fields do not masquerade as learning actions")
    }

    private func testRebaseRejectsChangedFactsAndReplacedMaterials() throws {
        let book = MiniWord(spelling: "book", meaning: "书")
        let at = Date(timeIntervalSinceReferenceDate: 800_000_000.25)
        var ledger = MiniDailyLedger()
        _ = ledger.beginOrResume(deck: [word, book], at: at)
        expect(ledger.days[0].addSentences([.init(word: word, english: "I eat an apple.", chinese: "我吃一个苹果。")]), "The fixture has an existing example")
        let record = MiniReviewRecord(session: MiniReviewSession(words: [word]), nextWordIndex: 0)
        let before = try rebaseSnapshot(ledger: ledger, record: record, revision: 8)
        var choose = MiniStudyAction(type: .chooseJudgment, target: .review, recordId: record.id, word: word)
        choose.judgment = .clear
        let command = MiniStudyCommand(expectedRevision: 8, action: choose, occurredAt: at)
        func denied(_ mutate: @escaping (inout [String: Any]) -> Void, _ message: String) throws {
            let after = try rebaseSnapshot(ledger: ledger, record: record, revision: 9, mutate: mutate)
            expect(!MiniStudyClient.eligibleRebase(command: command, before: before, after: after), message)
        }
        try denied({ payload in
            guard var body = payload["ledger"] as? [String: Any], var days = body["days"] as? [[String: Any]],
                  var sentences = days[0]["sentences"] as? [[String: Any]] else { preconditionFailure("Missing fixture example") }
            sentences[0]["english"] = "A replacement is not an append."
            days[0]["sentences"] = sentences; body["days"] = days; payload["ledger"] = body
        }, "A changed existing example is not an eligible background addition")
        try denied({ payload in
            guard var body = payload["ledger"] as? [String: Any], var days = body["days"] as? [[String: Any]] else { preconditionFailure("Missing fixture group") }
            days[0]["sentences"] = []; body["days"] = days; payload["ledger"] = body
        }, "Deleting a previously displayed example must never permit an automatic rebase")
        try denied({ $0["teaching"] = ["focusItems": [], "memories": [], "exposures": [["id": UUID().uuidString, "at": at.timeIntervalSinceReferenceDate]] ] },
                   "An actual help exposure blocks rebase even though the native UI does not decode its details")
        try denied({ $0["unknownFutureFact"] = ["changedAt": at.timeIntervalSinceReferenceDate] },
                   "New unknown server facts conservatively block automatic replay")
        try denied({ payload in
            guard var planning = payload["planning"] as? [String: Any], var plan = planning["longTerm"] as? [String: Any] else { preconditionFailure("Missing fixture plan") }
            plan["groupSize"] = 3; planning["longTerm"] = plan; payload["planning"] = planning
        }, "A plan change cannot be ignored just because the word is unchanged")
        var changed = record
        expect(changed.session.chooseJudgment(.fuzzy, at: at), "The concurrent user actually selected a different judgment")
        expect(!MiniStudyClient.eligibleRebase(command: command, before: before,
                                             after: try rebaseSnapshot(ledger: ledger, record: changed, revision: 9)),
               "The same current word does not permit replay over a changed review session")
        let unchangedAfter = try rebaseSnapshot(ledger: ledger, record: record, revision: 9)
        for type in [MiniStudyAction.Kind.begin, .completeReview, .completeLearning, .submitTranslation, .setTodayPlan, .pause] {
            let forbidden = MiniStudyCommand(expectedRevision: 8, action: .init(type: type, target: .review, recordId: record.id, word: word), occurredAt: at)
            expect(!MiniStudyClient.eligibleRebase(command: forbidden, before: before, after: unchangedAfter), "Only the four explicitly allowed learning actions may rebase")
        }
        expect(!MiniStudyClient.eligibleRebase(command: .init(expectedRevision: 7, action: choose, occurredAt: at), before: before, after: unchangedAfter),
               "An outbox command without its exact original snapshot cannot be rebased")
    }

    private func testLiveService(baseURL: URL, tokenFile: URL) async throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let legacyReview = MiniReviewRecord(session: MiniReviewSession(words: [word]), paused: true, nextWordIndex: 1)
        try write(JSONEncoder().encode(legacyReview), to: root.appending(path: "Review/current.json"))
        try write(JSONEncoder().encode(legacyReview),
                  to: root.appending(path: "Review/History/" + legacyReview.id.uuidString.lowercased() + ".json"))
        let client = MiniStudyClient(baseURL: baseURL, tokenFile: tokenFile, legacyDirectory: root)
        let initial = try await client.snapshot()
        expect(!initial.imported, "Integration requires a fresh isolated service database")
        let migration = try client.prepareLegacyImport()
        var snapshot = try await client.importLegacy(migration)
        let replayedImport = try await client.importLegacy(migration)
        expect(replayedImport.revision == snapshot.revision && replayedImport.reviewHistory.count == 1,
               "The real service imports legacy history exactly once")
        try client.recordImportReceipt(snapshot)

        struct BrowseEvidence: Decodable, Sendable {
            struct Scheduling: Decodable, Sendable {
                struct View: Decodable, Sendable { let word: MiniWord; let at: Date }
                let views: [View]
            }
            let scheduling: Scheduling
        }
        var viewport = MiniBrowseViewport()
        let visible = [MiniWord(spelling: "bench", meaning: "长椅"), MiniWord(spelling: "desk", meaning: "书桌")]
        let observed = Date(timeIntervalSinceReferenceDate: floor(Date.now.timeIntervalSinceReferenceDate) - 2)
        let cardCount = snapshot.scheduling?.cards.count
        let observation = viewport.update(visible, visible: true, revision: snapshot.revision, at: observed)[0]
        snapshot = try await client.perform(observation)
        let replay = try await client.perform(observation)
        let evidence: BrowseEvidence = try await client.serviceRequest(path: "snapshot", body: nil)
        expect(evidence.scheduling.views.filter { visible.contains($0.word) }.map(\.word) == visible &&
               evidence.scheduling.views.filter { visible.contains($0.word) }.allSatisfy { $0.at == observed },
               "Real HTTP history records each visible row precisely once at its original time")
        expect(replay.revision == snapshot.revision && snapshot.ledger.days.isEmpty &&
               snapshot.scheduling?.cards.count == cardCount, "Opening a viewport does not introduce or schedule extra words")

        func perform(_ action: MiniStudyAction) async throws -> MiniStudySnapshot {
            do { return try await client.perform(MiniStudyCommand(expectedRevision: snapshot.revision, action: action)) }
            catch {
                FileHandle.standardError.write(Data("Native study action failed: \(action.type.rawValue), revision \(snapshot.revision)\n".utf8))
                throw error
            }
        }
        var pause = MiniStudyAction(type: .pause, target: .review, recordId: legacyReview.id)
        pause.paused = false
        snapshot = try await perform(pause)
        while let record = snapshot.reviewRecord, record.session.phase == .judgment {
            guard let current = record.session.currentWord else { preconditionFailure("Missing review target") }
            var choose = MiniStudyAction(type: .chooseJudgment, target: .review, recordId: record.id, word: current)
            choose.judgment = .clear
            snapshot = try await perform(choose)
            snapshot = try await perform(MiniStudyAction(type: .advanceJudgment, target: .review,
                                                       recordId: record.id, word: current))
        }
        var oldSpelling = MiniStudyAction(type: .submitSpelling, target: .review, recordId: legacyReview.id, word: word)
        oldSpelling.answer = word.spelling
        snapshot = try await perform(oldSpelling)
        snapshot = try await perform(MiniStudyAction(type: .continueToLearning, target: .review, recordId: legacyReview.id))
        expect(snapshot.reviewRecord?.continuedToLearning == true, "Imported standalone review remains actionable")

        let preview = try await client.planPreview(deck: [word], timezone: "Asia/Shanghai")
        expect(preview.revision == snapshot.revision && preview.ledger.days.isEmpty && preview.planning.sessions.isEmpty,
               "Opening the home page and plan preview creates no group, budget or learning event")
        guard let context = preview.planContext else { preconditionFailure("Missing service plan context") }
        var longTerm = MiniStudyAction(type: .setLongTermPlan, target: .daily)
        longTerm.plan = .init(weekdays: [1, 2, 3, 4, 5, 6, 7], wordLimit: 3, newWordLimit: 2)
        snapshot = try await perform(longTerm)
        expect(snapshot.planning.longTerm.wordLimit == 3 && snapshot.ledger.days.isEmpty,
               "A real plan write persists without manufacturing a learning session")
        var today = MiniStudyAction(type: .setTodayPlan, target: .daily)
        today.date = context.date
        today.timezone = context.timezone
        today.mode = .rest
        today.wordLimit = 3
        today.newWordLimit = 2

        snapshot = try await perform(today)
        let resting = try await client.planPreview(deck: [word], timezone: "Asia/Shanghai")
        expect(resting.planContext?.effective.mode == .rest && resting.planContext?.canStart == false,
               "Today's rest is resolved by the actual service without recording a failure")
        var clearToday = MiniStudyAction(type: .clearTodayPlan, target: .daily)
        clearToday.date = context.date
        clearToday.timezone = context.timezone
        snapshot = try await perform(clearToday)

        var begin = MiniStudyAction(type: .begin, target: .daily)
        begin.deck = [word]
        begin.timezone = "Asia/Shanghai"
        snapshot = try await perform(begin)
        guard let dayId = snapshot.ledger.days.last?.id else { preconditionFailure("Missing daily session") }
        let frozen = snapshot.ledger.days.last
        snapshot = try await perform(MiniStudyAction(type: .endSession, target: .daily, dayId: dayId))
        expect(snapshot.ledger.days.last?.paused == true && snapshot.ledger.days.last?.learningWords == frozen?.learningWords
               && snapshot.ledger.days.last?.studiedWords.isEmpty == true,
               "Ending only this session pauses the original group without claiming it was studied")
        snapshot = try await perform(begin)
        expect(snapshot.ledger.days.last?.paused == false && snapshot.planning.sessions.count == 2,
               "Explicit continuation opens a fresh capacity budget and preserves the same group")
        var beginConcurrentReview = MiniStudyAction(type: .begin, target: .review)
        beginConcurrentReview.deck = [word]
        beginConcurrentReview.timezone = "Asia/Shanghai"
        snapshot = try await perform(beginConcurrentReview)
        guard let concurrentRecord = snapshot.reviewRecord else { preconditionFailure("Missing concurrent review") }
        let beforePreparation = snapshot
        var concurrentChoice = MiniStudyAction(type: .chooseJudgment, target: .review, recordId: concurrentRecord.id, word: word)
        concurrentChoice.judgment = .clear
        let originalChoice = MiniStudyCommand(expectedRevision: snapshot.revision, action: concurrentChoice)
        var materials = MiniStudyAction(type: .addSentences, target: .daily, dayId: dayId)
        materials.sentences = [.init(word: word, english: "I eat an apple after lunch.", chinese: "我午饭后吃一个苹果。")]
        snapshot = try await perform(materials)
        do {
            _ = try await client.perform(originalChoice)
            preconditionFailure("Background publication must produce an explicit revision conflict for the old command")
        } catch MiniStudyClientError.conflict { }
        let afterPreparation = try await client.snapshot()
        expect(MiniStudyClient.eligibleRebase(command: originalChoice, before: beforePreparation, after: afterPreparation),
               "An unchanged real HTTP review remains eligible after only background material publication")
        guard let occurrence = originalChoice.occurredAt else { preconditionFailure("Missing original occurrence") }
        let rebasedChoice = MiniStudyCommand(expectedRevision: afterPreparation.revision, action: originalChoice.action, occurredAt: occurrence)
        expect(rebasedChoice.requestId != originalChoice.requestId && rebasedChoice.occurredAt == originalChoice.occurredAt,
               "Rebase uses a new identity without pretending the user acted later")
        try client.savePending(rebasedChoice)
        snapshot = try await client.perform(rebasedChoice)
        let replayedChoice = try await client.perform(rebasedChoice)
        expect(replayedChoice.revision == snapshot.revision && replayedChoice.reviewRecord?.session.judgmentEvents.count == 1
               && replayedChoice.reviewRecord?.session.judgmentEvents.first?.selectedAt == occurrence,
               "The rebased HTTP action and its acknowledgement retry save one judgment at its original time")
        try client.clearPending(requestId: rebasedChoice.requestId)
        snapshot = try await perform(MiniStudyAction(type: .advanceJudgment, target: .review, recordId: concurrentRecord.id, word: word))
        var finishConcurrentSpelling = MiniStudyAction(type: .submitSpelling, target: .review, recordId: concurrentRecord.id, word: word)
        finishConcurrentSpelling.answer = word.spelling
        snapshot = try await perform(finishConcurrentSpelling)
        snapshot = try await perform(MiniStudyAction(type: .continueToLearning, target: .review, recordId: concurrentRecord.id))
        snapshot = try await perform(MiniStudyAction(type: .markStudied, target: .daily, dayId: dayId, word: word))
        var spelling = MiniStudyAction(type: .submitSpelling, target: .daily, dayId: dayId, session: .learning, word: word)
        spelling.answer = ""
        let blankSubmission = MiniStudyCommand(expectedRevision: snapshot.revision, action: spelling)
        snapshot = try await client.perform(blankSubmission)
        let spellingRetry = try await client.perform(blankSubmission)
        let blankAttempt = spellingRetry.ledger.days.last?.learning?.lastSpellingAttempt
        expect(spellingRetry.revision == snapshot.revision && spellingRetry.ledger.days.last?.learning?.spellingAttempts.count == 1
               && blankAttempt?.answer == "" && blankAttempt?.correct == false && blankAttempt?.revealedAnswerAt != nil
               && spellingRetry.ledger.days.last?.learning?.spellingState == .correcting,
               "HTTP retry preserves one empty first answer, its reveal, and the correction state")
        spelling.answer = "apple"
        snapshot = try await perform(spelling)
        snapshot = try await perform(spelling)
        snapshot = try await perform(MiniStudyAction(type: .completeLearning, target: .daily, dayId: dayId))
        expect(snapshot.ledger.days.last?.currentTranslation == nil,
               "A new prepared group does not turn a learning sentence into a writing test")
        var writing = MiniStudyAction(type: .publishWriting, target: .daily, dayId: dayId)
        writing.prompts = [.init(id: UUID(), sentence: .init(word: word, english: "The apple is in my bag.",
                                                           chinese: "苹果在我的包里。"),
                                 direction: .englishToChinese, focusIds: [])]
        snapshot = try await perform(writing)
        guard let day = snapshot.ledger.days.last, let task = day.currentTranslation else { preconditionFailure("Missing writing task") }
        let schedules = day.scheduleUpdates
        var submit = MiniStudyAction(type: .submitTranslation, target: .daily, dayId: dayId)
        submit.taskId = task.id
        submit.answer = "  苹果在我的包里。  "
        let submission = MiniStudyCommand(expectedRevision: snapshot.revision, action: submit)
        snapshot = try await client.perform(submission)
        let retried = try await client.perform(submission)
        expect(retried.revision == snapshot.revision && retried.ledger.days.last?.translation.count == 1,
               "An uncertain HTTP acknowledgement can be retried without a duplicate answer")
        guard let attempt = snapshot.ledger.days.last?.currentAttempt else { preconditionFailure("Missing stored answer") }
        expect(attempt.answer == submit.answer, "Committed writing keeps the raw first answer")
        var feedback = MiniStudyAction(type: .qualitativeFeedback, target: .daily, dayId: dayId)
        feedback.attemptId = attempt.id
        feedback.feedback = .init(comment: "意思清楚。", tip: "可以换一个物品练习。", usefulPhrase: "in my bag · 在我的包里",
                                  strengths: ["位置关系表达准确"], improvements: [], keyPoints: ["in 表示在里面"],
                                  referenceTranslation: "苹果在我的包里。")
        snapshot = try await perform(feedback)
        expect(snapshot.ledger.days.last?.scheduleUpdates == schedules, "AI teaching feedback does not change scheduling")
        var advance = MiniStudyAction(type: .advanceTranslation, target: .daily, dayId: dayId)
        advance.taskId = task.id
        snapshot = try await perform(advance)
        expect(snapshot.ledger.days.last?.phase == .finished, "The actual HTTP flow reaches completion")
        let reconnected = try await client.snapshot()
        expect(reconnected.ledger == snapshot.ledger, "Reconnection returns all committed facts")
        do {
            _ = try await client.perform(MiniStudyCommand(expectedRevision: 0, action: begin))
            preconditionFailure("A stale writer must not replace the current state")
        } catch MiniStudyClientError.conflict { }
        let closed = MiniStudyAction(type: .recordCardView, target: .review, recordId: UUID(), word: word)
        do {
            _ = try await client.perform(MiniStudyCommand(expectedRevision: reconnected.revision, action: closed))
            preconditionFailure("A view for a replaced review cannot be accepted")
        } catch MiniStudyClientError.commandRejected { }
        expect(try await client.snapshot().revision == reconnected.revision,
               "A stale card is distinct from a stale revision and cannot create an exposure")

        let book = MiniWord(spelling: "book", meaning: "书")
        let water = MiniWord(spelling: "water", meaning: "水")
        let clean = MiniWord(spelling: "clean", meaning: "干净的")
        longTerm.plan = .init(weekdays: [1, 2, 3, 4, 5, 6, 7], wordLimit: 3, newWordLimit: 3)
        snapshot = try await perform(longTerm)
        var newFlow = MiniStudyAction(type: .begin, target: .daily)
        newFlow.deck = [book, water, clean]
        newFlow.timezone = "Asia/Shanghai"
        newFlow.newGroup = true
        newFlow.flowVersion = "memory-rounds-v1"
        snapshot = try await perform(newFlow)
        guard let newId = snapshot.planning.activeDayId else { preconditionFailure("Missing three-round group") }
        var material = MiniStudyAction(type: .addSentences, target: .daily, dayId: newId)
        material.sentences = [book, water, clean].map { .init(word: $0, english: "I see \($0.spelling).", chinese: "测试例句。") }
        snapshot = try await perform(material)
        var testedUndo = false
        while let memory = snapshot.ledger.days.last?.memory, let current = memory.currentWord {
            var action = MiniStudyAction(type: .memoryAdvance, target: .daily, dayId: newId, word: current)
            action.round = memory.round
            action.remembered = true
            if memory.round == 1, current == book { action.draft = "  book scratch  " }
            if memory.round == 2, current == book, !testedUndo {
                var reveal = MiniStudyAction(type: .memoryReveal, target: .daily, dayId: newId, word: current)
                reveal.round = memory.round
                snapshot = try await perform(reveal)
                expect(snapshot.ledger.days.last?.memory?.revealed == true, "An explicit reveal is saved on the real card")
                snapshot = try await perform(action)
                snapshot = try await perform(.init(type: .memoryUndo, target: .daily, dayId: newId))
                expect(snapshot.ledger.days.last?.memory?.currentWord == book
                       && snapshot.ledger.days.last?.memory?.completedRounds(for: book) == 1,
                       "Undo restores only the actual completed round")
                testedUndo = true
            }
            snapshot = try await perform(action)
        }
        guard let memorized = snapshot.ledger.days.last else { preconditionFailure("Missing remembered group") }
        expect(memorized.memory?.round == 4 && memorized.studiedWords.count == 3,
               "All three real memory rounds precede formal spelling")
        expect(memorized.memory?.drafts.first?.text == "  book scratch  ", "Per-round memory keeps the original draft")
        expect(memorized.memory?.events.filter { $0.undoneAt == nil }.count == 9,
               "An undone memory event is retained without double-counting completion")
        guard let initial = memorized.learning, let firstWord = initial.currentWord else {
            preconditionFailure("Missing server-selected spelling queue")
        }
        let order = initial.progressDots.map(\.id)
        expect(order.first == firstWord && Set(order) == Set([book, water, clean]),
               "Progress follows the server's spelling order for this group")
        let retryOnce = order[1]
        let retryToLimit = order[2]
        var answer = MiniStudyAction(type: .submitSpelling, target: .daily, dayId: newId, session: .learning, word: firstWord)
        answer.answer = "  " + firstWord.spelling.uppercased() + "  "
        answer.advanceOnCorrect = false
        let correctRequest = MiniStudyCommand(expectedRevision: snapshot.revision, action: answer)
        snapshot = try await client.perform(correctRequest)
        expect(snapshot.ledger.days.last?.learning?.spellingState == .readyToAdvance
               && snapshot.ledger.days.last?.learning?.currentWord == firstWord,
               "A correct first Return stays on the green answer")
        let correctReplay = try await client.perform(correctRequest)
        expect(correctReplay.revision == snapshot.revision, "Retrying the answer does not advance")
        snapshot = try await perform(.init(type: .advanceSpelling, target: .daily, dayId: newId, session: .learning, word: firstWord))
        expect(snapshot.ledger.days.last?.learning?.currentWord == retryOnce, "The next explicit Return advances exactly once")
        while let session = snapshot.ledger.days.last?.learning, let current = session.currentWord {
            expect(current != firstWord, "A first-time correct word never returns to spelling")
            var response = MiniStudyAction(type: .submitSpelling, target: .daily, dayId: newId, session: .learning, word: current)
            response.advanceOnCorrect = false
            let round = session.currentSpellingRound
            response.answer = current == retryOnce && round > 1 ? retryOnce.spelling : "  miss-\(round)  "
            snapshot = try await perform(response)
            if current == retryToLimit, round == 5 {
                expect(snapshot.ledger.days.last?.learning?.currentWord != retryToLimit,
                       "The fifth failed first answer skips immediately")
                continue
            }
            if snapshot.ledger.days.last?.learning?.spellingState == .correcting {
                response.answer = current.spelling
                snapshot = try await perform(response)
            }
            expect(snapshot.ledger.days.last?.learning?.spellingState == .readyToAdvance,
                   "Corrections also keep the green result until explicit advance")
            snapshot = try await perform(.init(type: .advanceSpelling, target: .daily, dayId: newId, session: .learning, word: current))
        }
        guard let session = snapshot.ledger.days.last?.learning else { preconditionFailure("Missing spelling result") }
        expect(session.phase == .finished && session.spellingSkips?.map(\.word) == [retryToLimit], "The bounded loop preserves the skipped word")
        expect(session.spellingAttempts.filter { $0.word == firstWord && $0.kind == .first }.count == 1
               && session.spellingAttempts.filter { $0.word == retryOnce && $0.kind == .first }.count == 2
               && session.spellingAttempts.filter { $0.word == retryToLimit && $0.kind == .first }.count == 5,
               "Only first-answer failures repeat, bounded at five rounds")
        let priority = snapshot.scheduling?.cards.first { $0.word == retryToLimit }
        expect(priority?.practicePriority == 5 && priority?.fsrs == nil,
               "A capped word gains practice priority while retaining its independent memory state")
        snapshot = try await perform(.init(type: .completeLearning, target: .daily, dayId: newId))
        let restoredNewFlow = try await client.snapshot()
        expect(restoredNewFlow.ledger == snapshot.ledger, "Three-round and bounded spelling facts survive reconnection")
    }

    private func testLiveDailyRestart(baseURL: URL, tokenFile: URL) async throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let book = MiniWord(spelling: "book", meaning: "书")
        let deck = [book, word]
        var calendar = Calendar(identifier: .gregorian)
        guard let timezone = TimeZone(identifier: "Asia/Shanghai") else { preconditionFailure("Missing test timezone") }
        calendar.timeZone = timezone
        let earlier = Date.now.addingTimeInterval(-7 * 86_400)
        let pendingTime = earlier.addingTimeInterval(86_400)
        let bookSentence = MiniStudySentence(word: book, english: "I read a book.", chinese: "我读一本书。")
        let appleSentence = MiniStudySentence(word: word, english: "I eat an apple.", chinese: "我吃一个苹果。")
        var ledger = MiniDailyLedger()
        var completed = ledger.beginOrResume(deck: [book], at: earlier, calendar: calendar)
        expect(completed.addSentences([bookSentence]) && completed.markStudied(book, at: earlier),
               "The isolated fixture records actual material and study exposure")
        guard var learning = completed.learning else { preconditionFailure("Missing fixture learning") }
        expect(learning.submitSpelling(book.spelling, at: earlier) && learning.advanceSpelling(),
               "The fixture produces a real clean whole-group spelling result")
        completed.learning = learning
        expect(completed.completeLearning(at: earlier, calendar: calendar), "The fixture respects the spelling gate")
        guard let attemptID = completed.submitTranslation(bookSentence.chinese, at: earlier) else {
            preconditionFailure("Missing fixture translation")
        }
        let feedback = MiniTranslationFeedback(outcome: .correct, comment: "意思一致。", tip: "可以复用这个表达。", usefulPhrase: "read a book")
        expect(completed.gradeTranslation(id: attemptID, feedback: feedback, at: earlier, calendar: calendar)
               && completed.advanceTranslation(at: earlier), "The old completed group contains the full genuine event sequence")
        ledger.days[0] = completed
        var pending = ledger.beginOrResume(deck: [word], at: pendingTime, calendar: calendar)
        expect(pending.addSentences([appleSentence]) && pending.markStudied(word, at: pendingTime),
               "The unfinished group retains its own prepared material")
        guard var pendingSpelling = pending.learning else { preconditionFailure("Missing unfinished spelling") }
        expect(pendingSpelling.submitSpelling("aple", at: pendingTime), "The unfinished group keeps a raw incorrect first answer")
        pending.learning = pendingSpelling
        expect(pending.setPaused(true, at: pendingTime), "Pause without marking the unfinished group complete")
        ledger.days[ledger.days.count - 1] = pending
        let source = try JSONEncoder().encode(ledger)
        try write(source, to: root.appending(path: "DailyStudy/ledger.json"))
        let client = MiniStudyClient(baseURL: baseURL, tokenFile: tokenFile, legacyDirectory: root)
        var snapshot = try await client.importLegacy(client.prepareLegacyImport())
        let original = snapshot.ledger.days.first { $0.id == pending.id }
        expect(original?.learning?.lastSpellingAttempt?.answer == "aple", "Migration keeps the original first answer")
        let draftKey = "daily/" + pending.id + "/learning/apple/苹果"
        try client.saveDrafts([draftKey: "appl"])

        func perform(_ action: MiniStudyAction) async throws -> MiniStudySnapshot {
            try await client.perform(MiniStudyCommand(expectedRevision: snapshot.revision, action: action))
        }
        let preview = try await client.planPreview(deck: deck, timezone: timezone.identifier)
        guard let context = preview.planContext else { preconditionFailure("Missing multi-group plan context") }
        expect(context.dueCount == 1 && context.recoverySuggested && context.pendingDayId == nil && context.pendingGroups.isEmpty && context.canStart,
               "Old activity can suggest a lighter restart while historical groups are excluded from the new plan")
        var today = MiniStudyAction(type: .setTodayPlan, target: .daily)
        today.date = context.date
        today.timezone = context.timezone
        today.mode = .rest
        today.wordLimit = 5
        today.newWordLimit = 0

        snapshot = try await perform(today)
        let rest = try await client.planPreview(deck: deck, timezone: timezone.identifier).planContext
        expect(rest?.canStartReview == true && rest?.canStartLearning == false && rest?.canStartExtraGroup == true,
               "The home preview offers due review and explicit extra practice separately on a rest day")
        today.mode = .reviewOnly
        snapshot = try await perform(today)
        let reviewPreview = try await client.planPreview(deck: deck, timezone: timezone.identifier)
        expect(reviewPreview.planContext?.canStart == true && reviewPreview.planContext?.pendingDayId == nil
               && reviewPreview.planContext?.pendingGroups.isEmpty == true,
               "Review-only starts a fresh due group without resuming prior spelling")
        var begin = MiniStudyAction(type: .begin, target: .daily)
        begin.deck = deck
        begin.timezone = timezone.identifier
        begin.intent = .review
        begin.flowVersion = "sliding-window-v2"
        snapshot = try await perform(begin)
        guard let reviewID = snapshot.planning.activeDayId,
              let reviewDay = snapshot.ledger.days.first(where: { $0.id == reviewID }) else {
            preconditionFailure("Missing server-selected review side group")
        }
        expect(reviewID != pending.id && reviewDay.reviewWords == [book] && reviewDay.learningWords.isEmpty
               && reviewDay.writingRequired == false && reviewDay.translationCount == 0
               && snapshot.planning.currentSession?.intent == .review,
               "The service creates a distinct due-only group with no hidden writing requirement")
        expect(snapshot.ledger.days.first(where: { $0.id == pending.id })?.learning == original?.learning,
               "Starting review preserves historical spelling evidence")
        var choose = MiniStudyAction(type: .chooseJudgment, target: .daily, dayId: reviewID, session: .review, word: book)
        choose.judgment = .clear
        snapshot = try await perform(choose)
        snapshot = try await perform(MiniStudyAction(type: .advanceJudgment, target: .daily,
                                                   dayId: reviewID, session: .review, word: book))
        var answer = MiniStudyAction(type: .submitSpelling, target: .daily, dayId: reviewID, session: .review, word: book)
        answer.answer = book.spelling
        snapshot = try await perform(answer)
        if snapshot.ledger.days.first(where: { $0.id == reviewID })?.review?.phase == .spelling {
            snapshot = try await perform(MiniStudyAction(type: .advanceSpelling, target: .daily,
                                                         dayId: reviewID, session: .review, word: book))
        }
        snapshot = try await perform(MiniStudyAction(type: .completeReview, target: .daily, dayId: reviewID))
        let finishedReview = snapshot.ledger.days.first { $0.id == reviewID }
        expect(finishedReview?.phase == .finished && finishedReview?.translation.isEmpty == true
               && finishedReview?.translationCount == 0,
               "Review-only finishes from actual review facts without manufacturing translation answers")
        let reviewOnlyFinished = try await client.planPreview(deck: deck, timezone: context.timezone)
        expect(reviewOnlyFinished.planContext?.hasTaskAfterReview == false,
               "Completing the only due group on a review-only day ends the task without entering new words")
        var clear = MiniStudyAction(type: .clearTodayPlan, target: .daily)
        clear.date = context.date
        clear.timezone = context.timezone
        snapshot = try await perform(clear)
        let afterReview = try await client.planPreview(deck: deck, timezone: context.timezone).planContext
        expect(afterReview?.canContinue == false && afterReview?.canStart == true && afterReview?.hasTaskAfterReview == true,
               "After clearing reviews, the normal plan leads straight to a fresh word group")
        begin.intent = .learn
        snapshot = try await perform(begin)
        guard let freshID = snapshot.planning.activeDayId,
              let fresh = snapshot.ledger.days.first(where: { $0.id == freshID }),
              let visit = fresh.memoryWindow?.visit else { preconditionFailure("Expected today's first full word card") }
        expect(freshID != pending.id && fresh.phase == .learning && visit.word == word && visit.stage == 0
               && fresh.flow?.window.events.isEmpty == true && fresh.learning?.spellingAttempts.isEmpty != false
               && snapshot.planning.currentSession?.intent == .learn,
               "Yesterday's spelling correction starts today at a full card with a new visit")
        let historical = snapshot.ledger.days.first { $0.id == pending.id }
        expect(historical?.archivedAt != nil && historical?.learning == original?.learning && historical?.sentences == original?.sentences,
               "Archiving preserves the original spelling miss and prepared example")
        var pause = MiniStudyAction(type: .pause, target: .daily, dayId: freshID)
        pause.paused = true
        snapshot = try await perform(pause)
        let reconnected = MiniStudyClient(baseURL: baseURL, tokenFile: tokenFile, legacyDirectory: root)
        let paused = try await reconnected.planPreview(deck: deck, timezone: context.timezone)
        expect(paused.planContext?.pendingDayId == freshID && paused.planContext?.canContinue == true,
               "Relaunching today can resume this specific new group")
        snapshot = try await perform(begin)
        expect(snapshot.planning.activeDayId == freshID && snapshot.ledger.days.first(where: { $0.id == freshID })?.memoryWindow?.visit?.id == visit.id,
               "A same-day continue keeps the exact current visit")
        expect(try client.loadDrafts()[draftKey] == "appl" && draftKey.contains(pending.id),
               "An old local draft remains scoped to its original group")
        expect(try Data(contentsOf: root.appending(path: "DailyStudy/ledger.json")) == source,
               "The multi-group workflow never writes back into the migrated source ledger")
    }


    private func testWindowReadModelAndCommandRecovery() throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let id = UUID()
        let at = Date(timeIntervalSinceReferenceDate: 812_345_678)
        let visit = MiniMemoryWindow.Visit(id: id, word: word, stage: 1, openedAt: at,
                                          initial: true, selectedAt: at, revealedAt: at, correctedAt: nil, draft: "aple")
        let restored = try JSONDecoder().decode(MiniMemoryWindow.Visit.self, from: JSONEncoder().encode(visit))
        expect(restored.stage == 1 && restored.showsFullCard && restored.awaitingConfirmation && restored.canCorrect,
               "Choosing recall reveals the card while the same stage remains pending confirmation")
        let corrected = MiniMemoryWindow.Visit(id: id, word: word, stage: 1, openedAt: at,
                                              initial: true, selectedAt: at, revealedAt: at, correctedAt: at, draft: "aple")
        expect(corrected.showsFullCard && !corrected.willRemember && !corrected.canCorrect,
               "Marking a mistaken recall retains the revealed card and a negative confirmation")
        var action = MiniStudyAction(type: .windowAdvance, target: .daily, dayId: "run", session: .learning, word: word)
        action.visitId = id
        action.draft = visit.draft
        let command = MiniStudyCommand(expectedRevision: 8, action: action, occurredAt: at)
        let client = MiniStudyClient(legacyDirectory: root)
        try client.savePending(command)
        let recovered = try client.pendingCommand()
        expect(recovered?.action.visitId == id && recovered?.action.remembered == nil && recovered?.action.draft == "aple",
               "A pending Next retains the exact visit and scratchpad without fabricating another choice")
        expect(recovered?.requestId == command.requestId && recovered?.occurredAt == at,
               "Relaunch retries confirmation exactly once under the original identity")
    }

    private func testAssessmentAuditDecodesWithoutInventingScores() throws {
        let id = UUID().uuidString.lowercased()
        let payload: [String: Any] = [
            "job": ["id": id, "word": ["spelling": "apple", "meaning": "苹果", "phonetic": ""],
                    "status": "completed", "updatedAt": 812345678,
                    "error": NSNull(), "receipt": ["disposition": "partially_adopted", "reason": "只采用有证据的拼写观察。",
                        "scheduling": ["beforeDueAt": 812345678, "afterDueAt": 812432078, "reasons": ["translation_spelling"],
                                       "policyVersion": "mini-flow-scheduling-v1", "affectedEvents": 1]]],
            "source": ["question": ["direction": "chineseToEnglish", "english": "I eat an apple.", "chinese": "我吃一个苹果。"],
                       "answer": "  I eat an aple.  ", "submittedAt": 812345677, "discussion": []],
            "application": NSNull(),
        ]
        let detail = try JSONDecoder().decode(MiniAssessmentDetail.self, from: JSONSerialization.data(withJSONObject: payload))
        expect(detail.source.answer == "  I eat an aple.  " && detail.application == nil,
               "Audit preserves the submitted original and never manufactures a missing assessment")
        expect(detail.job.receipt?.scheduling.afterDueAt == Date(timeIntervalSinceReferenceDate: 812432078),
               "Audit dates use the same Swift epoch as authoritative learning schedules")
    }

    private func testDailyTranslationCommentary() throws {
        let attempt = UUID(), failed = UUID(), job = UUID()
        let word = ["spelling": "book", "meaning": "书", "phonetic": ""]
        let entries: [[String: Any]] = [
            ["attemptId": attempt.uuidString, "dayId": "earlier-run", "word": word, "direction": "chineseToEnglish",
             "question": "她读书。", "answer": "  She read a book.  ", "submittedAt": 812345678, "status": "ready",
             "commentary": ["summary": "动作表达清楚。", "strengths": ["a book 用得合适。"],
                            "improvements": ["日常习惯用 reads。"], "keyPoints": ["第三人称单数"],
                            "referenceTranslation": "She reads a book."], "retryJobId": NSNull()],
            ["attemptId": failed.uuidString, "dayId": "later-run", "word": word, "direction": "englishToChinese",
             "question": "I read a book.", "answer": "我看书。", "submittedAt": 812345600, "status": "failed",
             "commentary": NSNull(), "retryJobId": job.uuidString]
        ]
        let json: [String: Any] = ["date": "2026-11-18", "timezone": "Asia/Shanghai", "entries": entries]
        let review = try JSONDecoder().decode(MiniTranslationReview.self, from: JSONSerialization.data(withJSONObject: json))
        expect(review.entries.map(\.id) == [attempt, failed] && review.entries[0].answer == "  She read a book.  ",
               "Repeating a word across groups preserves two independent translations and the verbatim first answer")
        expect(review.entries[0].commentary?.strengths.count == 1 && review.entries[0].commentary?.improvements.count == 1 &&
               review.entries[1].commentary == nil && review.retryableJobs == [job],
               "The review exposes saved strengths and rewrites and retries only failed jobs")
        expect(review.entries[0].expressionGrade == nil && review.entries[0].canGradeExpression && !review.processing,
               "Existing commentary remains available without an invented expression grade or endless polling")
        let gradeRows = [("natural", ""), ("understandable", ""), ("off_meaning", ""), ("", "queued"), ("", "failed")].map { grade, state in
            var row = entries[0]
            row["attemptId"] = UUID().uuidString
            if !grade.isEmpty { row["expressionGrade"] = grade }
            if !state.isEmpty { row["expressionGradeStatus"] = state }
            return row
        }
        var updated = json
        updated["entries"] = gradeRows
        let graded = try JSONDecoder().decode(MiniTranslationReview.self, from: JSONSerialization.data(withJSONObject: updated))
        expect(graded.entries.compactMap(\.expressionGrade) == [.natural, .understandable, .offMeaning]
               && graded.processing && graded.entries.filter(\.canGradeExpression).map(\.expressionGradeStatus) == [.failed]
               && graded.retryableJobs.isEmpty && graded.entries.allSatisfy { $0.commentary != nil && $0.status == .ready },
               "All expression grades and backfill states are independent of completed commentary and learning assessment retries")
        updated["entries"] = gradeRows.map { row in
            var chinese = row
            chinese["direction"] = "englishToChinese"
            chinese["answer"] = "再见爸爸，我今晚给你打电话。"
            chinese["commentary"] = ["summary": "告别和通话时间都译对了。", "strengths": [], "improvements": [],
                                     "keyPoints": [], "referenceTranslation": "再见，爸爸！我今晚给你打电话。"]
            return chinese
        }
        let comprehension = try JSONDecoder().decode(MiniTranslationReview.self, from: JSONSerialization.data(withJSONObject: updated))
        expect(comprehension.entries.map(\.verdict) == [.correct, nil, .offMeaning, nil, nil]
               && graded.entries.compactMap(\.verdict) == [.natural, .understandable, .offMeaning],
               "Chinese comprehension and English production use their own grade scales")
        expect(comprehension.entries[0].alternativeChineseTranslation == nil
               && comprehension.entries[1].canGradeExpression && comprehension.entries[1].visibleCommentary == nil
               && comprehension.entries[3].needsMeaningGrade && !comprehension.entries[3].canGradeExpression,
               "Punctuation-only references are hidden; unresolved old polish grades await meaning review without surfacing stale advice")
        guard let shanghai = TimeZone(identifier: "Asia/Shanghai"), let utc = TimeZone(secondsFromGMT: 0),
              let boundary = ISO8601DateFormatter().date(from: "2026-11-17T16:00:01Z") else {
            preconditionFailure("Expected time zone fixtures")
        }
        expect(MiniTranslationReview.dateKey(boundary, timezone: shanghai) == "2026-11-18" &&
               MiniTranslationReview.dateKey(boundary, timezone: utc) == "2026-11-17",
               "The date picker queries the submission day in the learning time zone")
    }

    private func testAssessmentRebaseRequiresAnExactAppendOnlyChangeChain() throws {
        let at = Date(timeIntervalSinceReferenceDate: 812_345_678)
        let record = MiniReviewRecord(session: MiniReviewSession(words: [word]), nextWordIndex: 0)
        let sourceId = UUID().uuidString.lowercased()
        let assessedWord: [String: Any] = ["spelling": "book", "meaning": "书", "phonetic": ""]
        let source: [String: Any] = ["id": sourceId, "word": assessedWord, "answer": "I read a book."]
        let originalCard: [String: Any] = ["senseId": "book-sense", "word": assessedWord, "dueAt": 812432078, "lastEventId": "completion/book"]
        let revisedCard: [String: Any] = ["senseId": "book-sense", "word": assessedWord, "dueAt": 812518478, "lastEventId": "assessment/book"]
        let originalEvent: [String: Any] = ["id": "completion/book", "kind": "completion", "word": assessedWord, "sourceId": sourceId]
        let modelEvent: [String: Any] = ["id": "assessment/book", "kind": "assessment", "word": assessedWord, "sourceId": sourceId]
        let change: [String: Any] = ["id": "change/book", "eventId": "assessment/book", "word": assessedWord,
                                     "before": originalCard, "after": revisedCard]
        let oldFlow: [String: Any] = ["policyVersion": "mini-flow-scheduling-v1", "libraryVersion": "ts-fsrs@5.4.2/FSRS-6",
                                     "events": [originalEvent], "cards": [originalCard], "changes": []]
        let newFlow: [String: Any] = ["policyVersion": "mini-flow-scheduling-v1", "libraryVersion": "ts-fsrs@5.4.2/FSRS-6",
                                     "events": [originalEvent, modelEvent], "cards": [revisedCard], "changes": [change]]
        func make(_ flow: [String: Any], revision: Int, mutate: ((inout [String: Any]) -> Void)? = nil) throws -> MiniStudySnapshot {
            try rebaseSnapshot(ledger: MiniDailyLedger(), record: record, revision: revision) { payload in
                payload["assessmentSources"] = [source]
                payload["scheduling"] = ["policyVersion": "original-policy", "model": "original-model", "cards": [], "probes": [],
                                         "activeProbeId": NSNull(), "flow": flow]
                mutate?(&payload)
            }
        }
        let before = try make(oldFlow, revision: 8)
        var action = MiniStudyAction(type: .chooseJudgment, target: .review, recordId: record.id, word: word)
        action.judgment = .clear
        let command = MiniStudyCommand(expectedRevision: 8, action: action, occurredAt: at)
        expect(MiniStudyClient.eligibleRebase(command: command, before: before, after: try make(newFlow, revision: 9)),
               "An unchanged card answer can survive a different word's append-only background assessment")
        var changedKind = newFlow
        var manualEvent = modelEvent
        manualEvent["kind"] = "review"
        changedKind["events"] = [originalEvent, manualEvent]
        expect(!MiniStudyClient.eligibleRebase(command: command, before: before, after: try make(changedKind, revision: 9)),
               "A new user review event is never mistaken for an asynchronous model-only write")
        var changedPast = newFlow
        var past = originalEvent
        past["sourceId"] = "replaced"
        changedPast["events"] = [past, modelEvent]
        expect(!MiniStudyClient.eligibleRebase(command: command, before: before, after: try make(changedPast, revision: 9)),
               "A prior scheduling event cannot change under an automatic retry")
        var unlinked = newFlow
        unlinked["cards"] = [originalCard]
        expect(!MiniStudyClient.eligibleRebase(command: command, before: before, after: try make(unlinked, revision: 9)),
               "The final cards must exactly match the assessment change chain")
        expect(!MiniStudyClient.eligibleRebase(command: command, before: before, after: try make(newFlow, revision: 9) {
            $0["assessmentSources"] = [source, ["id": "new-user-answer"]]
        }), "A newly confirmed translation remains a user fact and blocks automatic replay")
        expect(!MiniStudyClient.eligibleRebase(command: command, before: before, after: try make(newFlow, revision: 9) {
            guard var scheduling = $0["scheduling"] as? [String: Any] else { preconditionFailure("Missing fixture schedule") }
            scheduling["model"] = "changed-old-scheduler"
            $0["scheduling"] = scheduling
        }), "Older scheduling facts remain protected while the isolated flow projection changes")
    }

    private func testLiveWindowFlow(baseURL: URL, tokenFile: URL) async throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let client = MiniStudyClient(baseURL: baseURL, tokenFile: tokenFile, legacyDirectory: root)
        var snapshot = try await client.importLegacy(client.prepareLegacyImport())
        expect(snapshot.ledger.days.isEmpty, "The v2 integration runs in a fresh isolated database")
        let deck = ["apple", "book", "cat", "dog", "egg", "fish", "green"].map { MiniWord(spelling: $0, meaning: "测试 " + $0) }
        func perform(_ action: MiniStudyAction) async throws -> MiniStudySnapshot {
            do {
                if action.type == .windowAdvance || action.type == .windowFamiliar,
                   var projected = snapshot.ledger.days.first(where: { $0.id == action.dayId }),
                   let visit = projected.memoryWindow?.visit {
                    guard let input = MiniReviewInput(action: action, visit: visit) else {
                        preconditionFailure("Expected a valid window input for the displayed visit")
                    }
                    input.presentWindow(in: &projected)
                    let received = try await client.perform(.init(requestId: input.id, expectedRevision: snapshot.revision,
                                                                  action: action, occurredAt: input.occurredAt))
                    let confirmed = received.ledger.days.first { $0.id == projected.id }
                    expect(confirmed?.flow == projected.flow && confirmed?.learning == projected.learning,
                           "Immediate window projection agrees with the committed visit, group and spelling order")
                    return received
                }
                return try await client.perform(.init(expectedRevision: snapshot.revision, action: action))
            }
            catch {
                FileHandle.standardError.write(Data("V2 native action failed: \(action.type.rawValue), revision \(snapshot.revision)\n".utf8))
                throw error
            }
        }
        var plan = MiniStudyAction(type: .setLongTermPlan, target: .daily)
        plan.plan = .init(weekdays: [1, 2, 3, 4, 5, 6, 7], wordLimit: 10, newWordLimit: 2,
                          dailyNewGoal: 2, groupSize: 1)
        snapshot = try await perform(plan)
        var begin = MiniStudyAction(type: .begin, target: .daily)
        begin.deck = deck
        begin.timezone = "Asia/Shanghai"
        begin.flowVersion = "sliding-window-v2"
        snapshot = try await perform(begin)
        guard let dayId = snapshot.planning.activeDayId else { preconditionFailure("Missing v2 active day") }
        func current() -> MiniDailyDay {
            guard let day = snapshot.ledger.days.first(where: { $0.id == dayId }) else { preconditionFailure("Missing stable v2 group") }
            return day
        }
        expect(current().flow?.window.members.count == 5 && current().flow?.dailyNewGoal == 2,
               "The server keeps a five-word window separate from a two-word final goal")
        let candidates = current().flow?.candidates ?? []
        for start in stride(from: 0, to: candidates.count, by: 5) {
            var prepare = MiniStudyAction(type: .addSentences, target: .daily, dayId: dayId)
            prepare.sentences = candidates[start..<min(start + 5, candidates.count)].map {
                MiniStudySentence(word: $0, english: "I can see the \($0.spelling).", chinese: "我看见了它。")
            }
            snapshot = try await perform(prepare)
        }
        var correctedOnce = false
        var scratchStages = Set<Int>()
        for group in 1...4 {
            if group == 1 {
                guard let visit = current().memoryWindow?.visit, visit.stage == 0 else {
                    preconditionFailure("Missing full new-word card")
                }
                let action = MiniStudyAction.window(.windowFamiliar, dayId: dayId, session: .learning,
                                                   visit: visit, draft: "原草稿")
                let command = MiniStudyCommand(expectedRevision: snapshot.revision, action: action)
                snapshot = try await client.perform(command)
                let replay = try await client.perform(command)
                expect(snapshot.revision == replay.revision && current().flow?.window.events.count == 1,
                       "Reopening the same familiar-word request preserves a single self-report")
                let event = current().flow?.window.events.last
                expect(event?.selfReportedFamiliar == true && event?.stage == 0 && event?.draft == "原草稿",
                       "The actual initial visit and its draft survive without synthetic recall attempts")
                expect(current().flow?.groupWords == [visit.word] && current().learning?.currentWord == visit.word
                       && current().learning?.spellingAttempts.isEmpty == true && current().flow?.completed.isEmpty == true,
                       "Marking a word familiar leaves grouped spelling and final translation to the learner")
            }
            if group > 2 {
                let home = try await client.planPreview(deck: deck, timezone: "Asia/Shanghai")
                guard let context = home.planContext else { preconditionFailure("Missing completed home plan") }
                expect(context.todayCompleted == true && context.canStartExtraGroup == true
                       && context.completedNewCount == group - 1 && context.effective.dailyNewGoal == 2,
                       "A completed plan offers exactly one optional group without changing the daily target")
                var extra = begin
                extra.extraGroupForDate = context.date
                let command = MiniStudyCommand(expectedRevision: snapshot.revision, action: extra)
                snapshot = try await client.perform(command)
                let replay = try await client.perform(command)
                expect(replay.revision == snapshot.revision && replay.ledger == snapshot.ledger,
                       "Replaying a bonus start cannot add a second group")
                let resumed = try await client.planPreview(deck: deck, timezone: "Asia/Shanghai")
                expect(resumed.planContext?.canContinue == true && resumed.planContext?.canStartExtraGroup == false,
                       "An existing bonus group can be resumed from home")
            }
            var visits = 0
            while let visit = current().memoryWindow?.visit {
                visits += 1
                expect(visits < 80, "The isolated window must make progress")
                var action = MiniStudyAction.window(.windowAdvance, dayId: dayId, session: .learning,
                                                   visit: visit, draft: visit.draft)
                var choose = MiniStudyAction.window(.windowChoose, dayId: dayId, session: .learning,
                                                   visit: visit, draft: "window scratch input")
                choose.remembered = true
                snapshot = try await perform(choose)
                expect(current().memoryWindow?.visit?.completedStages == visit.stage + 1,
                       "The visible dots increase before the current word is advanced")
                if visit.stage > 0 {
                    expect(current().memoryWindow?.visit?.id == visit.id && current().memoryWindow?.visit?.stage == visit.stage
                           && current().memoryWindow?.visit?.showsFullCard == true,
                           "Answer selection reveals without advancing or replacing the word")
                    if !correctedOnce {
                        action.markWrong = true
                        correctedOnce = true
                    }
                }
                if scratchStages.insert(visit.stage).inserted {
                    let flowBefore = current().flow
                    let open = MiniStudyAction(type: .openDictation, target: .daily, dayId: dayId,
                                              session: .learning, word: visit.word)
                    snapshot = try await perform(open)
                    guard let practice = snapshot.practice?.activeDictation else { preconditionFailure("Missing scratch spelling card") }
                    var submit = MiniStudyAction(type: .submitDictation, target: .daily, dayId: dayId, session: .learning)
                    submit.dictationId = practice.id
                    submit.answer = "incorrect"
                    snapshot = try await perform(submit)
                    submit.answer = visit.word.spelling
                    snapshot = try await perform(submit)
                    submit.answer = "  " + visit.word.spelling.uppercased() + "  "
                    snapshot = try await perform(submit)
                    expect(snapshot.practice?.activeDictation?.attempts.map(\.correct) == [false, true, true],
                           "Scratch spelling retains every repeat and its original input")
                    expect(current().flow == flowBefore, "Scratch spelling leaves the card stages and group progress intact")
                    var close = MiniStudyAction(type: .closeDictation, target: .daily, dayId: dayId, session: .learning)
                    close.dictationId = practice.id
                    snapshot = try await perform(close)
                    expect(snapshot.practice?.activeDictation == nil, "Exiting scratch spelling returns to the same word card")
                }
                snapshot = try await perform(action)
                if action.markWrong == true {
                    let corrected = current().flow?.window.events.last
                    expect(corrected?.id == visit.id && corrected?.initial == true && corrected?.correctedAt != nil
                           && corrected?.remembered == false && current().memoryWindow?.visit?.id != visit.id,
                           "Correction is confirmed on the original visit while advancing immediately")
                }
                expect(snapshot.practice?.activeDictation == nil, "The next word starts with scratch spelling closed")
            }
            guard let word = current().learning?.currentWord else { preconditionFailure("Missing grouped spelling") }
            expect(current().flow?.groupWords.count == 1 && current().flow?.groupIndex == group,
                   "Each group includes exactly its admitted word for mandatory spelling")
            var spell = MiniStudyAction(type: .submitSpelling, target: .daily, dayId: dayId, session: .learning, word: word)
            spell.answer = "incorrect"
            spell.advanceOnCorrect = false
            snapshot = try await perform(spell)
            spell.answer = word.spelling
            snapshot = try await perform(spell)
            expect(current().learning?.spellingState == .readyToAdvance,
                   "A corrected spelling stays green until an explicit Next")
            let next = MiniStudyAction(type: .advanceSpelling, target: .daily, dayId: dayId, session: .learning, word: word)
            snapshot = try await perform(next)
            expect(current().learning?.currentWord == word && current().learning?.spellingState == .awaitingFirst,
                   "A previous-round first miss returns for a fresh first answer")
            snapshot = try await perform(spell)
            snapshot = try await perform(next)
            expect(current().learning?.phase == .finished,
                   "A correct first answer in the latest round exits spelling despite an older miss")
            snapshot = try await perform(.init(type: .completeLearning, target: .daily, dayId: dayId))
            var writing = MiniStudyAction(type: .publishWriting, target: .daily, dayId: dayId)
            writing.prompts = [.init(id: UUID(), sentence: .init(word: word, english: "Please show me the \(word.spelling).", chinese: "请把它给我看看。"),
                                     direction: group.isMultiple(of: 2) ? .chineseToEnglish : .englishToChinese, focusIds: [])]
            snapshot = try await perform(writing)
            guard let task = current().currentTranslation else { preconditionFailure("Missing independent translation") }
            var submit = MiniStudyAction(type: .submitTranslation, target: .daily, dayId: dayId)
            submit.taskId = task.id
            submit.answer = task.reference
            snapshot = try await perform(submit)
            expect(current().currentAttempt?.feedback == nil, "The answer is saved before any AI evaluation")
            if group == 2, let original = current().currentAttempt {
                var edit = MiniStudyAction(type: .reviseTranslation, target: .daily, dayId: dayId)
                edit.attemptId = original.latestID
                edit.taskId = task.id
                edit.answer = original.answer + "!"
                snapshot = try await perform(edit)
                let revised = current().currentAttempt
                expect(revised?.id == original.id && revised?.answer == original.answer
                       && revised?.latestID != original.latestID && revised?.latestAnswer == edit.answer,
                       "Revision changes the editable answer while preserving the independently submitted first answer")
                expect(current().translationIndex == group - 1 && current().flow?.completed.count == group - 1,
                       "Submitting a correction keeps the active question and completes no additional word")
            }
            var advance = MiniStudyAction(type: .advanceTranslation, target: .daily, dayId: dayId)
            advance.taskId = task.id
            snapshot = try await perform(advance)
            expect(current().flow?.completed.count == group && current().translation.last?.confirmedAt != nil,
                   "Next finalizes this word and immediately continues without AI feedback")
        }
        expect(current().flow?.goalReached == true && current().paused && current().flow?.window.members.isEmpty == false,
               "The final daily goal stops new learning while preserving unfinished window words")
        let preview = try await client.planPreview(deck: deck, timezone: "Asia/Shanghai")
        expect(preview.planContext?.completedNewCount == 4 && preview.planContext?.remainingNewCount == 0
               && preview.planContext?.effective.dailyNewGoal == 2 && preview.planContext?.canStartExtraGroup == true
               && snapshot.planning.longTerm.dailyNewGoal == 2 && snapshot.planning.dailyOverrides.isEmpty,
               "After two optional groups the homepage offers another and preserves the original plan")
        let review = MiniAssessmentClient(study: client)
        guard let timezone = TimeZone(identifier: "Asia/Shanghai") else { preconditionFailure("Missing test timezone") }
        let days = Dictionary(grouping: current().translation) {
            MiniTranslationReview.dateKey($0.submittedAt, timezone: timezone)
        }
        for (date, attempts) in days {
            let history = try await review.translations(date: date, timezone: timezone.identifier)
            expect(Set(history.entries.map(\.id)) == Set(attempts.map(\.id)), "Planned and optional groups are visible by submission date")
            for attempt in attempts {
                let row = history.entries.first { $0.id == attempt.id }
                expect(row?.question == attempt.task.prompt && row?.direction == attempt.task.direction
                       && row?.answer == attempt.latestAnswer && row?.status == .queued && row?.commentary == nil,
                       "The stable review row pairs each question with its latest submitted translation while feedback is outstanding")
            }
        }
        let reopened = try await MiniStudyClient(baseURL: baseURL, tokenFile: tokenFile, legacyDirectory: root).snapshot()
        expect(reopened.ledger == snapshot.ledger && reopened.revision == snapshot.revision,
               "Viewing translations preserves the interleaved visits, spelling, original translations and study revision")
    }

    private func expect(_ condition: Bool, _ message: String) {
        precondition(condition, message)
    }

    private func temporaryDirectory() throws -> URL {
        let root = URL.temporaryDirectory.appending(path: "lingoweave-client-" + UUID().uuidString.lowercased())
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        return root
    }

    private func write(_ data: Data, to file: URL) throws {
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: file)
    }
}
