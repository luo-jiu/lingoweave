import Foundation

@main
struct MiniReviewTests {
    private let apple = MiniWord(spelling: "apple", meaning: "苹果")
    private let book = MiniWord(spelling: "book", meaning: "书")

    static func main() throws {
        let tests = MiniReviewTests()
        tests.testJudgmentInterleavesMixedFailuresAndKeepsThreeTimeWordForSpelling()
        tests.testWrongRevealPreservesInitialJudgmentAndCountsAgainstTheLimit()
        tests.testSpellingPreservesFirstAnswerAndOnlyLaterFirstSuccessLeavesQueue()
        try tests.testPendingJudgmentAndCorrectionDraftSurviveEncoding()
        tests.testEmptyAndRepeatedDeckEntries()
        tests.testJudgmentProgressKeepsDeckOrderAndDistinguishesCappedWords()
        tests.testSpellingProgressKeepsCorrectionsPendingUntilLaterFirstSuccess()
        print("7 review behavior tests passed.")
    }

    private func expect(_ condition: Bool, file: StaticString = #file, line: UInt = #line) {
        precondition(condition, "Review behavior assertion failed.", file: file, line: line)
    }

    func testJudgmentInterleavesMixedFailuresAndKeepsThreeTimeWordForSpelling() {
        var session = MiniReviewSession(words: [apple, book])

        expect(session.chooseJudgment(.forgotten))
        expect(session.advanceJudgment())
        expect(session.currentWord == book)
        expect(session.chooseJudgment(.clear))
        expect(session.advanceJudgment())

        expect(session.currentWord == apple)
        expect(session.chooseJudgment(.fuzzy))
        expect(session.advanceJudgment())
        expect(session.phase == .judgment)
        expect(session.chooseJudgment(.forgotten))
        expect(session.advanceJudgment())

        expect(session.phase == .spelling)
        expect(session.currentWord == apple)
        expect(session.remainingCount == 2)
        expect(session.judgmentEvents.filter { $0.word == apple }.map(\.final) == [.forgotten, .fuzzy, .forgotten])
    }

    func testWrongRevealPreservesInitialJudgmentAndCountsAgainstTheLimit() {
        var session = MiniReviewSession(words: [apple])
        let revealedAt = Date(timeIntervalSince1970: 1_000)
        let correctedAt = revealedAt.addingTimeInterval(5)

        expect(!(session.advanceJudgment(markWrong: true)))
        expect(session.chooseJudgment(.clear, at: revealedAt))
        expect(session.currentJudgment == .clear)
        expect(session.lastExposureAt == revealedAt)
        expect(!(session.chooseJudgment(.fuzzy)))
        expect(session.advanceJudgment(markWrong: true, at: correctedAt))
        expect(session.currentJudgment == nil)
        expect(session.phase == .judgment)
        expect(session.judgmentEvents.first?.selected == .clear)
        expect(session.judgmentEvents.first?.final == .forgotten)
        expect(session.judgmentEvents.first?.selectedAt == revealedAt)
        expect(session.judgmentEvents.first?.finalizedAt == correctedAt)

        for _ in 0..<2 {
            expect(session.chooseJudgment(.fuzzy))
            expect(session.advanceJudgment())
        }
        expect(session.phase == .spelling)
    }

    func testSpellingPreservesFirstAnswerAndOnlyLaterFirstSuccessLeavesQueue() {
        var session = readyForSpelling([apple, book])
        let firstAt = Date(timeIntervalSince1970: 1_005)

        expect(!(session.advanceSpelling()))
        expect(!(session.submitSpelling("  \n")))
        expect(session.spellingAttempts.isEmpty)
        expect(session.submitSpelling("  aplpe ", at: firstAt))
        expect(session.spellingState == .correcting)
        expect(session.spellingDraft == "  aplpe ")
        expect(session.lastExposureAt == firstAt)
        expect(!(session.advanceSpelling()))
        expect(!(session.submitSpelling("  aplpe ")))
        expect(session.submitSpelling("aple"))
        expect(!(session.advanceSpelling()))
        expect(session.submitSpelling(" APPLE "))
        expect(session.spellingState == .readyToAdvance)
        expect(!(session.submitSpelling("apple")))
        expect(session.advanceSpelling())
        expect(session.currentWord == book)
        expect(session.remainingCount == 2)
        expect(session.spellingDraft.isEmpty)
        expect(session.lastSpellingAttempt == nil)

        expect(session.submitSpelling("book"))
        expect(session.advanceSpelling())
        expect(session.currentWord == apple)
        expect(session.submitSpelling("apple"))
        expect(session.advanceSpelling())

        expect(session.phase == .finished)
        expect(session.remainingCount == 0)
        expect(!(session.advanceSpelling()))
        let appleAttempts = session.spellingAttempts.filter { $0.word == apple }
        expect(appleAttempts.map(\.kind) == [.first, .correction, .correction, .first])
        expect(appleAttempts.map(\.encounter) == [1, 1, 1, 2])
        expect(appleAttempts.map(\.correct) == [false, false, true, true])
        expect(appleAttempts.first?.answer == "  aplpe ")
        expect(appleAttempts.first?.submittedAt == firstAt)
        expect(appleAttempts.first?.revealedAnswerAt == firstAt)
        expect(appleAttempts.last?.lastAnswerRevealAt == firstAt)
    }

    func testPendingJudgmentAndCorrectionDraftSurviveEncoding() throws {
        var session = MiniReviewSession(words: [apple])
        expect(session.chooseJudgment(.clear))
        session = try restored(session)
        expect(session.currentJudgment == .clear)
        expect(session.advanceJudgment())

        expect(session.submitSpelling("aplpe"))
        session.spellingDraft = "appl"
        session = try restored(session)
        expect(session.spellingState == .correcting)
        expect(session.spellingDraft == "appl")
        expect(session.lastSpellingAttempt?.answer == "aplpe")
        expect(!(session.advanceSpelling()))
        expect(session.submitSpelling("apple"))
        expect(session.advanceSpelling())
        expect(session.currentWord == apple)
        expect(session.spellingState == .awaitingFirst)
    }

    func testEmptyAndRepeatedDeckEntries() {
        let empty = MiniReviewSession(words: [])
        expect(empty.phase == .finished)
        expect(empty.currentWord == nil)
        let secondSense = MiniWord(spelling: "book", meaning: "预订")
        let session = MiniReviewSession(words: [book, book, secondSense])
        expect(session.totalCount == 2)
        expect(session.remainingCount == 2)
    }

    func testJudgmentProgressKeepsDeckOrderAndDistinguishesCappedWords() {
        let water = MiniWord(spelling: "water", meaning: "水")
        let words = [apple, book, water]
        var session = MiniReviewSession(words: words)
        expect(session.progressDots.map(\.id) == words)
        expect(session.progressDots.map(\.state) == [.current, .pending, .pending])

        expect(session.chooseJudgment(.fuzzy))
        expect(session.advanceJudgment())
        expect(session.progressDots.map(\.state) == [.repeatNext, .current, .pending])
        expect(session.chooseJudgment(.clear))
        expect(session.advanceJudgment())
        expect(session.progressDots.map(\.state) == [.repeatNext, .passed, .current])

        for rating: MiniReviewJudgment in [.forgotten, .fuzzy, .forgotten, .forgotten] {
            expect(session.chooseJudgment(rating))
            expect(session.advanceJudgment())
        }
        expect(session.progressDots.map(\.id) == words)
        expect(session.progressDots.map(\.state) == [.capped, .passed, .current])

        expect(session.chooseJudgment(.clear))
        expect(session.advanceJudgment())
        expect(session.phase == .spelling)
        expect(session.progressDots.map(\.state) == [.current, .pending, .pending])
    }

    func testSpellingProgressKeepsCorrectionsPendingUntilLaterFirstSuccess() {
        let water = MiniWord(spelling: "water", meaning: "水")
        let words = [apple, book, water]
        var session = readyForSpelling(words)
        expect(session.progressDots.map(\.state) == [.current, .pending, .pending])
        expect(session.submitSpelling("aplpe"))
        expect(session.progressDots.map(\.state) == [.current, .pending, .pending])
        expect(session.submitSpelling("apple"))
        expect(session.advanceSpelling())
        expect(session.progressDots.map(\.state) == [.repeatNext, .current, .pending])

        expect(session.submitSpelling("book"))
        expect(session.advanceSpelling())
        expect(session.progressDots.map(\.state) == [.repeatNext, .passed, .current])
        expect(session.submitSpelling("water"))
        expect(session.advanceSpelling())
        expect(session.progressDots.map(\.state) == [.current, .passed, .passed])

        expect(session.submitSpelling("apple"))
        expect(session.advanceSpelling())
        expect(session.progressDots.map(\.id) == words)
        expect(session.progressDots.map(\.state) == [.passed, .passed, .passed])
    }

    private func readyForSpelling(_ words: [MiniWord]) -> MiniReviewSession {
        var session = MiniReviewSession(words: words)
        for _ in words {
            expect(session.chooseJudgment(.clear, at: Date(timeIntervalSince1970: 1_000)))
            expect(session.advanceJudgment(at: Date(timeIntervalSince1970: 1_001)))
        }
        expect(session.phase == .spelling)
        return session
    }

    private func restored(_ session: MiniReviewSession) throws -> MiniReviewSession {
        let data = try JSONEncoder().encode(session)
        let restored = try JSONDecoder().decode(MiniReviewSession.self, from: data)
        expect(restored == session)
        return restored
    }
}
