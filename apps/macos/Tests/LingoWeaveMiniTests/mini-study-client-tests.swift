import Foundation

@main
struct MiniStudyClientTests {
    static func main() async throws {
        let tests = Self()
        try tests.testLegacyBackupAndImportIdentity()
        try tests.testDamagedHistoryStopsImport()
        try tests.testPendingCommandRecovery()
        try tests.testUnsubmittedDraftRecovery()
        try tests.testSnapshotKeepsSwiftDatesAndFacts()
        try tests.testPlanCommandRecoveryKeepsScope()
        try tests.testServerPlanContextDecodesWithoutLocalInference()
        try tests.testBackgroundMaterialsAllowOnlyUnchangedLearningActions()
        try tests.testRebaseRejectsChangedFactsAndReplacedMaterials()
        try tests.testWindowReadModelAndCommandRecovery()
        try tests.testAssessmentAuditDecodesWithoutInventingScores()
        try tests.testAssessmentRebaseRequiresAnExactAppendOnlyChangeChain()
        print("12 mini service client recovery tests passed.")
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
            try await tests.testLivePreservedGroups(baseURL: url, tokenFile: URL(fileURLWithPath: token))
            print("Swift → HTTP preserved-group and review-only integration passed.")
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
                "pendingDayId": "2026-11-10", "canStart": false, "canContinue": true, "blockedReason": NSNull(),
                "pendingGroups": [["dayId": "2026-11-10~8ea55acf-a131-46f7-a15c-854f7ba58114", "phase": "learning",
                                   "paused": true, "startedAt": 800_000_000.25, "canContinue": false,
                                   "blockedReason": "今天只复习，原组进度保留。"],
                                  ["dayId": "2026-11-10", "phase": "review", "paused": false,
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
               "A kept group uses its stable identity and service-owned continuation permission")
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
        spelling.answer = "  aple  "
        expect(MiniStudyClient.eligibleRebase(command: .init(expectedRevision: 8, action: spelling, occurredAt: at),
                                            before: try rebaseSnapshot(ledger: ledger, record: spellingRecord, revision: 8),
                                            after: try rebaseSnapshot(ledger: prepared, record: spellingRecord, revision: 9)),
               "A raw first answer remains eligible when the complete spelling session is unchanged")

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
        spelling.answer = "aple"
        snapshot = try await perform(spelling)
        expect(snapshot.ledger.days.last?.learning?.spellingState == .correcting, "Real service preserves an incorrect first answer")
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
        var answer = MiniStudyAction(type: .submitSpelling, target: .daily, dayId: newId, session: .learning, word: book)
        answer.answer = "  BOOK  "
        answer.advanceOnCorrect = false
        let correctRequest = MiniStudyCommand(expectedRevision: snapshot.revision, action: answer)
        snapshot = try await client.perform(correctRequest)
        expect(snapshot.ledger.days.last?.learning?.spellingState == .readyToAdvance
               && snapshot.ledger.days.last?.learning?.currentWord == book,
               "A correct first Return stays on the green answer")
        let correctReplay = try await client.perform(correctRequest)
        expect(correctReplay.revision == snapshot.revision, "Retrying the answer does not advance")
        snapshot = try await perform(.init(type: .advanceSpelling, target: .daily, dayId: newId, session: .learning, word: book))
        expect(snapshot.ledger.days.last?.learning?.currentWord == water, "The next explicit Return advances exactly once")
        while let session = snapshot.ledger.days.last?.learning, let current = session.currentWord {
            expect(current != book, "A first-time correct word never returns to spelling")
            var response = MiniStudyAction(type: .submitSpelling, target: .daily, dayId: newId, session: .learning, word: current)
            response.advanceOnCorrect = false
            let round = session.currentSpellingRound
            response.answer = current == water && round > 1 ? water.spelling : "  miss-\(round)  "
            snapshot = try await perform(response)
            if current == clean, round == 5 {
                expect(snapshot.ledger.days.last?.learning?.currentWord != clean,
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
        expect(session.phase == .finished && session.spellingSkips?.map(\.word) == [clean], "The bounded loop preserves the skipped word")
        expect(session.spellingAttempts.filter { $0.word == book && $0.kind == .first }.count == 1
               && session.spellingAttempts.filter { $0.word == water && $0.kind == .first }.count == 2
               && session.spellingAttempts.filter { $0.word == clean && $0.kind == .first }.count == 5,
               "Only first-answer failures repeat, bounded at five rounds")
        let priority = snapshot.scheduling?.cards.first { $0.word == clean }
        expect(priority?.practicePriority == 5 && priority?.fsrs == nil,
               "A capped word gains practice priority while retaining its independent memory state")
        snapshot = try await perform(.init(type: .completeLearning, target: .daily, dayId: newId))
        let restoredNewFlow = try await client.snapshot()
        expect(restoredNewFlow.ledger == snapshot.ledger, "Three-round and bounded spelling facts survive reconnection")
    }

    private func testLivePreservedGroups(baseURL: URL, tokenFile: URL) async throws {
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
        expect(snapshot.planning.activeDayId == pending.id, "The service chooses the migrated unfinished group")
        let draftKey = "daily/" + pending.id + "/learning/apple/苹果"
        try client.saveDrafts([draftKey: "appl"])

        func perform(_ action: MiniStudyAction) async throws -> MiniStudySnapshot {
            try await client.perform(MiniStudyCommand(expectedRevision: snapshot.revision, action: action))
        }
        let preview = try await client.planPreview(deck: deck, timezone: timezone.identifier)
        guard let context = preview.planContext else { preconditionFailure("Missing multi-group plan context") }
        expect(context.dueCount == 1 && context.recoverySuggested && context.pendingDayId == pending.id,
               "Real old activity and due history produce a service-owned recovery recommendation")
        var today = MiniStudyAction(type: .setTodayPlan, target: .daily)
        today.date = context.date
        today.timezone = context.timezone
        today.mode = .reviewOnly
        today.wordLimit = 5
        today.newWordLimit = 0

        snapshot = try await perform(today)
        let reviewPreview = try await client.planPreview(deck: deck, timezone: timezone.identifier)
        expect(reviewPreview.planContext?.canStart == true && reviewPreview.planContext?.pendingDayId == nil
               && reviewPreview.planContext?.pendingGroups.first(where: { $0.dayId == pending.id })?.canContinue == false,
               "Review-only can start a due group while keeping incompatible unfinished learning")
        var begin = MiniStudyAction(type: .begin, target: .daily)
        begin.deck = deck
        begin.timezone = timezone.identifier
        snapshot = try await perform(begin)
        guard let reviewID = snapshot.planning.activeDayId,
              let reviewDay = snapshot.ledger.days.first(where: { $0.id == reviewID }) else {
            preconditionFailure("Missing server-selected review side group")
        }
        expect(reviewID != pending.id && reviewDay.reviewWords == [book] && reviewDay.learningWords.isEmpty
               && reviewDay.writingRequired == false && reviewDay.translationCount == 0,
               "The service creates a distinct due-only group with no hidden writing requirement")
        expect(snapshot.ledger.days.first(where: { $0.id == pending.id }) == original,
               "Starting a review side group leaves the old answer, correction state and material unchanged")
        var choose = MiniStudyAction(type: .chooseJudgment, target: .daily, dayId: reviewID, session: .review, word: book)
        choose.judgment = .clear
        snapshot = try await perform(choose)
        snapshot = try await perform(MiniStudyAction(type: .advanceJudgment, target: .daily,
                                                   dayId: reviewID, session: .review, word: book))
        var answer = MiniStudyAction(type: .submitSpelling, target: .daily, dayId: reviewID, session: .review, word: book)
        answer.answer = book.spelling
        snapshot = try await perform(answer)
        snapshot = try await perform(MiniStudyAction(type: .completeReview, target: .daily, dayId: reviewID))
        let finishedReview = snapshot.ledger.days.first { $0.id == reviewID }
        expect(finishedReview?.phase == .finished && finishedReview?.translation.isEmpty == true
               && finishedReview?.translationCount == 0,
               "Review-only finishes from actual review facts without manufacturing translation answers")
        var clear = MiniStudyAction(type: .clearTodayPlan, target: .daily)
        clear.date = context.date
        clear.timezone = context.timezone
        snapshot = try await perform(clear)
        begin.dayId = pending.id
        snapshot = try await perform(begin)
        let resumed = snapshot.ledger.days.first { $0.id == pending.id }
        expect(snapshot.planning.activeDayId == pending.id && resumed?.paused == false,
               "An explicit stable group identity restores the original unfinished group")
        expect(resumed?.learning == original?.learning && resumed?.studiedWords == original?.studiedWords
               && resumed?.sentences == original?.sentences && resumed?.translation == original?.translation,
               "Resumption preserves the first miss, correction state and all prior learning facts")
        expect(try client.loadDrafts()[draftKey] == "appl", "Switching and resuming groups preserves unsubmitted local input")
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
            do { return try await client.perform(.init(expectedRevision: snapshot.revision, action: action)) }
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
        for group in 1...2 {
            var visits = 0
            while let visit = current().memoryWindow?.visit {
                visits += 1
                expect(visits < 80, "The isolated window must make progress")
                let action = MiniStudyAction.window(.windowAdvance, dayId: dayId, session: .learning,
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
                        let correct = MiniStudyAction.window(.windowCorrect, dayId: dayId, session: .learning,
                                                             visit: visit, draft: "window scratch input")
                        snapshot = try await perform(correct)
                        expect(current().memoryWindow?.visit?.id == visit.id && current().memoryWindow?.visit?.willRemember == false,
                               "Marking a mistaken recall stays on the revealed card")
                        expect(correct.draft == nil && current().memoryWindow?.visit?.completedStages == 0,
                               "The UI correction payload is accepted and immediately clears all dots")
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
                expect(snapshot.practice?.activeDictation == nil, "The next word starts with scratch spelling closed")
            }
            guard let word = current().learning?.currentWord else { preconditionFailure("Missing grouped spelling") }
            expect(current().flow?.groupWords.count == 1 && current().flow?.groupIndex == group,
                   "Only a completed three-stage word enters this spelling group")
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
                                     direction: group == 1 ? .englishToChinese : .chineseToEnglish, focusIds: [])]
            snapshot = try await perform(writing)
            guard let task = current().currentTranslation else { preconditionFailure("Missing independent translation") }
            var submit = MiniStudyAction(type: .submitTranslation, target: .daily, dayId: dayId)
            submit.taskId = task.id
            submit.answer = task.reference
            snapshot = try await perform(submit)
            expect(current().currentAttempt?.feedback == nil, "The answer is saved before any AI evaluation")
            var advance = MiniStudyAction(type: .advanceTranslation, target: .daily, dayId: dayId)
            advance.taskId = task.id
            snapshot = try await perform(advance)
            expect(current().flow?.completed.count == group && current().translation.last?.confirmedAt != nil,
                   "Next finalizes this word and immediately continues without AI feedback")
        }
        expect(current().flow?.goalReached == true && current().paused && current().flow?.window.members.isEmpty == false,
               "The final daily goal stops new learning while preserving unfinished window words")
        let preview = try await client.planPreview(deck: deck, timezone: "Asia/Shanghai")
        expect(preview.planContext?.completedNewCount == 2 && preview.planContext?.remainingNewCount == 0,
               "Homepage completion uses only final confirmed words from the authoritative projection")
        let reopened = try await MiniStudyClient(baseURL: baseURL, tokenFile: tokenFile, legacyDirectory: root).snapshot()
        expect(reopened.ledger == snapshot.ledger, "A new client restores the exact interleaved visits, spelling and original translations")
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
