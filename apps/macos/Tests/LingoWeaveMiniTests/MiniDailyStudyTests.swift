import Foundation

@main
struct MiniDailyStudyTests {
    private let apple = MiniWord(spelling: "apple", meaning: "苹果")
    private let book = MiniWord(spelling: "book", meaning: "书")
    private let water = MiniWord(spelling: "water", meaning: "水")
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 8 * 60 * 60)!
        return calendar
    }
    private let correct = MiniTranslationFeedback(outcome: .correct, comment: "一致", tip: "", usefulPhrase: "")
    private let partial = MiniTranslationFeedback(outcome: .partial, comment: "缺少限定词", tip: "注意冠词", usefulPhrase: "an apple")

    static func main() throws {
        let tests = MiniDailyStudyTests()
        tests.testPlanKeepsUnfinishedDayAndFreezesCohort()
        tests.testLearningRequiresCanonicalSentenceAndActualStudy()
        try tests.testPendingTranslationAndFeedbackSurviveRelaunch()
        tests.testDueWindowsUseFirstAnswersAndReuseCanonicalSentences()
        try tests.testCorruptionIsNotOverwritten()
        print("5 daily study behavior tests passed.")
    }

    private func expect(_ condition: Bool, _ explanation: String, file: StaticString = #file, line: UInt = #line) {
        precondition(condition, explanation, file: file, line: line)
    }

    private func date(_ day: Int, hour: Int = 12) -> Date {
        calendar.date(from: DateComponents(year: 2026, month: 11, day: day, hour: hour))!
    }

    private func example(_ word: MiniWord) -> MiniStudySentence {
        MiniStudySentence(word: word, english: "I see \(word.spelling).", chinese: "我看见\(word.meaning)。")
    }

    private func prepareAndStudy(_ day: inout MiniDailyDay, at time: Date) {
        expect(day.addSentences(day.wordsToPrepare.map(example)), "Save generated material before studying")
        while let word = day.nextUnstudiedWord {
            expect(day.markStudied(word, at: time), "Record actual study exposure")
        }
    }

    private func finishLearning(_ day: inout MiniDailyDay, at time: Date, miss: MiniWord? = nil) {
        prepareAndStudy(&day, at: time)
        guard var session = day.learning else { preconditionFailure("Missing learning session") }
        if let miss, session.currentWord == miss {
            expect(session.submitSpelling("first miss", at: time), "Record original wrong answer")
            expect(session.submitSpelling(miss.spelling, at: time), "Record supported correction separately")
            expect(session.advanceSpelling(), "Move to the next target")
        }
        while let word = session.currentWord {
            expect(session.submitSpelling(word.spelling, at: time), "Complete a clean spelling attempt")
            expect(session.advanceSpelling(), "Advance the spelling queue")
        }
        day.learning = session
        expect(day.completeLearning(at: time, calendar: calendar), "Only completed learning enters translation")
    }

    private func finishTranslations(_ day: inout MiniDailyDay, at time: Date) {
        while let task = day.currentTranslation {
            guard let id = day.submitTranslation(task.reference, at: time) else { preconditionFailure("Missing attempt") }
            expect(day.gradeTranslation(id: id, feedback: correct, at: time, calendar: calendar), "Save grade")
            expect(day.advanceTranslation(at: time), "Move from the graded task")
        }
    }

    private func testPlanKeepsUnfinishedDayAndFreezesCohort() {
        let deck = MiniWord.starter.dropFirst()
        let duplicate = MiniWord(spelling: "APPLE", meaning: apple.meaning, phonetic: "other IPA")
        var ledger = MiniDailyLedger()
        let initial = ledger.beginOrResume(deck: [apple, duplicate] + deck, at: date(1), calendar: calendar)
        expect(initial.id == "2026-11-01", "Task uses the local day")
        expect(initial.review == nil && initial.phase == .learning, "Unseen words never enter the initial review")
        expect(initial.learningWords.count == 5 && initial.learningWords.filter { $0.spelling.lowercased() == "apple" }.count == 1, "Learning cohort is capped and pronunciation variants do not duplicate a target")
        ledger.days[0].setPaused(true, at: date(1))
        let resumed = ledger.beginOrResume(deck: [water], at: date(2), calendar: calendar)
        expect(resumed.id == initial.id && resumed.paused, "Incomplete paused day survives the local midnight")
        expect(resumed.learningWords == initial.learningWords && ledger.days.count == 1, "Deck edits never change a started cohort")

        var empty = MiniDailyLedger()
        let noGloss = MiniWord(spelling: "door", meaning: " ")
        let done = empty.beginOrResume(deck: [noGloss], at: date(1), calendar: calendar)
        expect(done.phase == .finished && done.finishedAt == date(1), "No valid targets finishes without material or grading")
        expect(empty.beginOrResume(deck: [noGloss], at: date(1), calendar: calendar) == done, "An empty unchanged deck keeps the old placeholder")
        let replaced = empty.beginOrResume(deck: [apple], at: date(1), calendar: calendar)
        expect(replaced.phase == .learning && replaced.learningWords == [apple] && empty.days.count == 1, "A deck edit can replace an empty placeholder on the same day")
    }

    private func testLearningRequiresCanonicalSentenceAndActualStudy() {
        var ledger = MiniDailyLedger()
        var day = ledger.beginOrResume(deck: [apple, book], at: date(1), calendar: calendar)
        expect(day.nextUnstudiedWord == apple, "Show the first word")
        expect(!day.markStudied(apple, at: date(1)), "Missing example cannot become learned")
        expect(!day.addSentences([example(apple), example(water)]), "Reject a reply for an unrelated word atomically")
        expect(day.sentences.isEmpty, "No partial data from an invalid response")
        expect(day.addSentences([example(apple), example(book)]), "Save canonical material")
        expect(!day.addSentences([example(apple)]), "Stale generation cannot overwrite canonical material")
        expect(!day.markStudied(book, at: date(1)), "Do not skip the next word")
        expect(day.markStudied(apple, at: date(1)), "Record the first study action")
        expect(day.studiedWords == [MiniStudyExposure(word: apple, at: date(1))], "Keep the actual exposure timestamp")
        expect(!day.completeLearning(at: date(1), calendar: calendar), "Study action alone never passes the spelling gate")
        expect(day.scheduleUpdates.isEmpty, "Unfinished learning produces no due dates")
    }

    private func testPendingTranslationAndFeedbackSurviveRelaunch() throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let storage = MiniDailyStorage(directory: directory)
        var ledger = try storage.load()
        var day = ledger.beginOrResume(deck: [apple, book], at: date(1), calendar: calendar)
        finishLearning(&day, at: date(1))
        expect(day.currentTranslation?.direction == .englishToChinese, "First exercise uses English source")
        expect(day.submitTranslation("  ", at: date(1)) == nil, "Blank does not create an attempt")
        expect(day.submitTranslation(String(repeating: "a", count: 4_001), at: date(1)) == nil, "Reject an answer too long to grade")
        let raw = "  我看到了苹果。  "
        guard let id = day.submitTranslation(raw, at: date(1)) else { preconditionFailure("Expected committed attempt") }
        day.setPaused(true, at: date(1))
        ledger.days[0] = day
        try storage.save(ledger)

        let restored = try MiniDailyStorage(directory: directory).load()
        var loaded = restored.days[0]
        expect(loaded.paused && loaded.currentAttempt?.id == id, "Pause and pending grade target survive restart")
        expect(loaded.currentAttempt?.answer == raw, "Keep the submitted first answer byte-for-byte")
        expect(!loaded.advanceTranslation(at: date(1)), "A pending grade never advances")
        expect(loaded.submitTranslation("changed", at: date(1)) == nil, "No duplicate or edited first answer")
        expect(!loaded.gradeTranslation(id: UUID(), feedback: partial, at: date(1), calendar: calendar), "Ignore a callback from another attempt")
        expect(loaded.gradeTranslation(id: id, feedback: partial, at: date(1), calendar: calendar), "A pending submitted answer can be graded while the view is paused")
        expect(!loaded.gradeTranslation(id: id, feedback: correct, at: date(1), calendar: calendar), "A later callback cannot replace recorded feedback")
        expect(loaded.currentAttempt?.feedback == partial, "Keep feedback on its original prompt")
        expect(loaded.currentAttempt?.gradedAt == date(1), "Persist the grading timestamp")
        let updates = loaded.scheduleUpdates
        loaded.setPaused(false, at: date(1))
        expect(loaded.pauseEvents?.map(\.paused) == [true, false], "Pause and resume are durable facts")
        expect(loaded.advanceTranslation(at: date(1)), "Continue only after feedback")
        expect(loaded.currentTranslation?.direction == .chineseToEnglish, "Alternate direction across different sentences")
        expect(!loaded.gradeTranslation(id: id, feedback: correct, at: date(1), calendar: calendar), "Ignore callbacks for past exercises")
        expect(loaded.scheduleUpdates == updates, "Advancing does not repeat schedule writes")
    }

    private func testDueWindowsUseFirstAnswersAndReuseCanonicalSentences() {
        var ledger = MiniDailyLedger()
        var first = ledger.beginOrResume(deck: [book, apple], at: date(1), calendar: calendar)
        finishLearning(&first, at: date(1), miss: book)
        let originalRounds = first.learning?.spellingAttempts.filter { $0.kind == .first }
        expect(originalRounds?.map(\.word) == [book, apple, book, apple], "One missed new word requires a clean new round for the entire group")
        expect(originalRounds?.map(\.correct) == [false, true, true, true], "Keep the first round results after a clean second round")
        expect(first.scheduleUpdates.first { $0.word == apple }?.dueAt == date(3, hour: 0), "Clean first spelling uses two calendar days")
        expect(first.scheduleUpdates.first { $0.word == book }?.dueAt == date(2, hour: 0), "A supported correction must not hide the initial miss")
        finishTranslations(&first, at: date(1))
        expect(first.finishedAt == date(1), "Mark the day complete after its final grade is viewed")
        ledger.days[0] = first

        let repronounced = MiniWord(spelling: book.spelling, meaning: book.meaning, phonetic: "/bʊk/")
        var next = ledger.beginOrResume(deck: [apple, repronounced, water], at: date(2), calendar: calendar)
        expect(next.phase == .review && next.reviewWords == [repronounced], "Due known words are reviewed before new words")
        expect(next.learningWords == [water], "Neither due nor not-yet-due words are counted as new")
        expect(next.wordsToPrepare == [water], "Do not regenerate an example for a due word")
        expect(next.sentences.first?.english == example(book).english, "Reuse the first actual example despite pronunciation edits")
        guard var review = next.review else { preconditionFailure("Expected a due review session") }
        expect(review.chooseJudgment(.clear, at: date(2)), "Review without a weak judgment")
        expect(review.advanceJudgment(at: date(2)), "Enter spelling")
        expect(review.submitSpelling(book.spelling, at: date(2)), "First spelling is correct")
        expect(review.advanceSpelling(), "Finish the due review")
        next.review = review
        expect(next.completeReview(at: date(2), calendar: calendar), "Advance to today's new words")
        expect(next.scheduleUpdates.first?.dueAt == date(5, hour: 0), "Clean completed review adopts a three-day interval")
        finishLearning(&next, at: date(2))
        expect(next.currentTranslation?.direction == .chineseToEnglish, "Review alternates its prior actual translation direction")
        guard let id = next.submitTranslation("The book", at: date(6)) else { preconditionFailure("Expected late translation") }
        expect(next.gradeTranslation(id: id, feedback: partial, at: date(6), calendar: calendar), "Grade the late response")
        expect(next.scheduleUpdates.last?.dueAt == date(5, hour: 0), "A weak late grade never postpones the previous due date")
        expect(next.scheduleUpdates.last?.step == 0 && next.scheduleUpdates.last?.source == .translation, "Weak grade resets the local cadence")
    }

    private func testCorruptionIsNotOverwritten() throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let storage = MiniDailyStorage(directory: directory)
        let path = directory.appending(path: "ledger.json")
        let invalid = Data("not JSON".utf8)
        try invalid.write(to: path)
        do {
            try storage.save(MiniDailyLedger())
            preconditionFailure("Invalid storage must not be erased")
        } catch is DecodingError {
            expect(try Data(contentsOf: path) == invalid, "Corruption is still recoverable from the original file")
        }
    }

    private func temporaryDirectory() throws -> URL {
        let directory = URL.temporaryDirectory.appending(path: UUID().uuidString, directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        return directory
    }
}
