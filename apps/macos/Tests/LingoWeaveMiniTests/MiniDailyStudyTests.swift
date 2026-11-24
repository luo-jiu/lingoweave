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
        tests.testPlanRestartsOnANewDateAndFreezesTodaysCohort()
        tests.testLearningRequiresCanonicalSentenceAndActualStudy()
        try tests.testPendingTranslationAndFeedbackSurviveRelaunch()
        tests.testDueWindowsUseFirstAnswersAndReuseCanonicalSentences()
        try tests.testCorruptionIsNotOverwritten()
        try tests.testMemoryRoundsDraftRevealAndUndoSurviveRelaunch()
        tests.testTodayActivityCountsLateWorkAcrossGroupsAndDeduplicates()
        tests.testTodayActivityUsesTheCalendarAndIgnoresFutureEvents()
        tests.testTodayActivityWaitsForTheFinalMemoryRound()
        try tests.testSentenceHighlightsWholeWordsAndInflections()
        try tests.testWindowDotsReflectTheCurrentAnswer()
        tests.testImmediateWindowTraceThroughFirstSpelling()
        print("12 daily study behavior tests passed.")
    }

    private func expect(_ condition: Bool, _ explanation: String, file: StaticString = #file, line: UInt = #line) {
        precondition(condition, explanation, file: file, line: line)
    }

    private func testImmediateWindowTraceThroughFirstSpelling() {
        let at = date(1)
        let words = (0..<15).map { MiniWord(spelling: "word\($0)", meaning: "义项\($0)") }
        var ledger = MiniDailyLedger()
        var day = ledger.beginOrResume(deck: words, at: at, calendar: calendar)
        var window = MiniMemoryWindow(version: "interleaved-v2", size: 5, gap: 3, members: [], visit: nil,
                                      events: [], sequence: 0, forceUnseen: false)
        for word in words.prefix(5) { window.admit(word, at: at) }
        window.selectNext(id: UUID(), preferred: nil, at: at)
        day.learning = nil
        day.flow = MiniLearningFlow(version: "sliding-window-v2", targetDate: day.id, dailyNewGoal: 10, completedBeforeRun: 0,
                                   groupSize: 5, candidates: words, candidateIndex: 5, window: window, groupId: UUID(),
                                   groupIndex: 1, groupStartedAt: at, groupTarget: 5, groupWords: [], translationWords: [],
                                   groups: [], completed: [], goalReached: false)
        expect(day.addSentences(words.map(example)), "Seed the same prepared pool as the service trace")
        func current() -> MiniMemoryWindow.Visit { guard let visit = day.memoryWindow?.visit else { preconditionFailure() }; return visit }
        for word in words.prefix(4) {
            let id = UUID()
            expect(current().word == word, "Visit unseen words until the first recall gap is reached")
            expect(day.advanceWindow(visitId: current().id, nextId: id, remembered: true, markWrong: false, familiar: false,
                                     draft: nil, at: at), "First encounter advances in one action")
            expect(current().id == id, "The next visit is addressable before any receipt")
        }
        let original = current()
        expect(original.word == words[0] && original.stage == 1, "The fourth unseen word yields to contextual recall")
        expect(!day.advanceWindow(visitId: original.id, nextId: UUID(), remembered: nil, markWrong: true, familiar: false,
                                  draft: nil, at: at), "A concealed card cannot be corrected")
        var chosen = original
        chosen.initial = true; chosen.selectedAt = at; chosen.revealedAt = at
        expect(day.updateWindowVisit(chosen), "Expose an unacknowledged recalled card")
        expect(day.advanceWindow(visitId: original.id, nextId: UUID(), remembered: nil, markWrong: true, familiar: false,
                                 draft: nil, at: at), "A correction and advance are one input")
        let event = day.flow?.window.events.last
        expect(event?.id == original.id && event?.initial == true && event?.remembered == false && event?.correctedAt == at,
               "Keep the original choice as well as the confirmed correction")
        expect(day.flow?.window.members.first(where: { $0.word == words[0] })?.stage == 0, "The corrected word returns to stage zero")
        let seed = UUID(uuidString: "12345678-9abc-4def-8000-000000000001")!
        for index in 4..<9 {
            expect(current().word == words[index], "Each new spare is selected immediately")
            expect(day.advanceWindow(visitId: current().id, nextId: index == 8 ? seed : UUID(), remembered: nil, markWrong: false,
                                     familiar: true, draft: nil, at: at), "Familiar skips memory only")
        }
        expect(day.learning?.spellingRounds == [.init(round: 1, order: [2, 4, 3, 0, 1])] && day.learning?.currentWord == words[6],
               "Window completion shows the exact first spelling prompt and permutation published by the service")
        expect(day.flow?.groupWords == Array(words[4..<9]) && day.flow?.translationWords == Array(words[4..<9]),
               "Spelling shuffles independently of translation order")
    }

    private func testWindowDotsReflectTheCurrentAnswer() throws {
        let id = UUID(), opened = date(1), answered = date(1, hour: 13)
        for stage in 0..<3 {
            let pending = MiniMemoryWindow.Visit(id: id, word: apple, stage: stage, openedAt: opened,
                initial: nil, selectedAt: nil, revealedAt: nil, correctedAt: nil, draft: "")
            expect(pending.completedStages == stage, "An unanswered visit shows its previous progress")
            let remembered = MiniMemoryWindow.Visit(id: id, word: apple, stage: stage, openedAt: opened,
                initial: true, selectedAt: answered, revealedAt: answered, correctedAt: nil, draft: "")
            expect(remembered.completedStages == stage + 1,
                   "Remembering immediately lights the current stage before advancing to another word")
            expect(remembered.stage == stage && remembered.id == id,
                   "Dot feedback retains the current card while the user checks the answer")
            let restored = try JSONDecoder().decode(MiniMemoryWindow.Visit.self, from: JSONEncoder().encode(remembered))
            expect(restored.completedStages == stage + 1, "Restored confirmation keeps the current answer's dots")
            let forgotten = MiniMemoryWindow.Visit(id: id, word: apple, stage: stage, openedAt: opened,
                initial: false, selectedAt: answered, revealedAt: answered, correctedAt: nil, draft: "")
            expect(forgotten.completedStages == 0, "Forgetting immediately clears all three dots")
            let corrected = MiniMemoryWindow.Visit(id: id, word: apple, stage: stage, openedAt: opened,
                initial: true, selectedAt: answered, revealedAt: answered, correctedAt: answered, draft: "")
            expect(corrected.completedStages == 0 && corrected.initial == true,
                   "Correcting a mistaken recall immediately clears progress and retains the original choice")
        }
    }

    private func testSentenceHighlightsWholeWordsAndInflections() throws {
        let music = MiniStudySentence(word: MiniWord(spelling: "music", meaning: "音乐"),
            english: "🎵 Music and music help the musician.", chinese: "音乐让音乐家愉快。")
        expect(music.highlightedRanges.map { String(music.english[$0]) } == ["Music", "music"],
               "All complete target occurrences are highlighted while longer words remain distinct")
        let gave = MiniStudySentence(word: MiniWord(spelling: "give", meaning: "给"),
            english: "She gave me a book.", chinese: "她给了我一本书。", targetForms: ["gave"])
        expect(gave.highlightedRanges.map { String(gave.english[$0]) } == ["gave"],
               "AI-provided irregular forms select the actual English span")
        let restored = try JSONDecoder().decode(MiniStudySentence.self, from: JSONEncoder().encode(gave))
        expect(restored.targetForms == ["gave"] && restored.highlightedRanges.count == 1,
               "Target forms persist with canonical learning material")
        let old = MiniStudySentence(word: MiniWord(spelling: "read", meaning: "阅读"),
            english: "She reads every day, and I read too.", chinese: "她每天阅读，我也阅读。")
        expect(old.highlightedRanges.map { String(old.english[$0]) } == ["reads", "read"],
               "Existing material can match its English lemma without another preparation request")
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

    private func testPlanRestartsOnANewDateAndFreezesTodaysCohort() {
        let deck = MiniWord.starter.dropFirst()
        let duplicate = MiniWord(spelling: "APPLE", meaning: apple.meaning, phonetic: "other IPA")
        var ledger = MiniDailyLedger()
        let initial = ledger.beginOrResume(deck: [apple, duplicate] + deck, at: date(1), calendar: calendar)
        expect(initial.id == "2026-11-01", "Task uses the local day")
        expect(initial.review == nil && initial.phase == .learning, "Unseen words never enter the initial review")
        expect(initial.learningWords.count == 5 && initial.learningWords.filter { $0.spelling.lowercased() == "apple" }.count == 1, "Learning cohort is capped and pronunciation variants do not duplicate a target")
        ledger.days[0].setPaused(true, at: date(1))
        let resumed = ledger.beginOrResume(deck: [water], at: date(1), calendar: calendar)
        expect(resumed.id == initial.id && resumed.paused, "A pause earlier today keeps the current group")
        expect(resumed.learningWords == initial.learningWords && ledger.days.count == 1, "Deck edits never change a started cohort")

        let fresh = ledger.beginOrResume(deck: [water], at: date(2), calendar: calendar)
        expect(fresh.id != initial.id && fresh.nextUnstudiedWord == water && ledger.days.count == 2,
               "A new local date starts the current deck from a full word card")

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

    private func testTodayActivityCountsLateWorkAcrossGroupsAndDeduplicates() {
        let now = date(4), actionTime = date(4, hour: 11)
        var firstLedger = MiniDailyLedger()
        var first = firstLedger.beginOrResume(deck: [apple], at: date(1), calendar: calendar)
        prepareAndStudy(&first, at: actionTime)
        let variant = MiniWord(spelling: " APPLE ", meaning: " 苹果 ", phonetic: "other IPA")
        var variantLedger = MiniDailyLedger()
        var duplicate = variantLedger.beginOrResume(deck: [variant], at: date(2), calendar: calendar)
        prepareAndStudy(&duplicate, at: actionTime)

        var reviewLedger = MiniDailyLedger()
        var seed = reviewLedger.beginOrResume(deck: [apple], at: date(1), calendar: calendar)
        finishLearning(&seed, at: date(1))
        finishTranslations(&seed, at: date(1))
        reviewLedger.days[0] = seed
        var oldReview = reviewLedger.beginOrResume(deck: [apple], at: date(3), calendar: calendar)
        guard var review = oldReview.review else { preconditionFailure("Missing due review") }
        expect(review.chooseJudgment(.clear, at: actionTime) && review.advanceJudgment(at: actionTime),
               "Resume an older group with an actual review judgment today")
        expect(review.submitSpelling("appl", at: actionTime) && review.submitSpelling("apple", at: actionTime),
               "Record several real review actions for the same word")
        oldReview.review = review

        var writingLedger = MiniDailyLedger()
        var writing = writingLedger.beginOrResume(deck: [book], at: date(1), calendar: calendar)
        finishLearning(&writing, at: date(1))
        expect(writing.submitTranslation("书", at: actionTime) != nil, "An older group's answer is submitted today")
        let ledger = MiniDailyLedger(days: [first, duplicate, seed, oldReview, writing, writing])
        let activity = MiniTodayActivity(ledger: ledger, now: now, calendar: calendar)
        expect(activity.learnedWords == 1, "Today's studied words use normalized spelling and meaning across groups")
        expect(activity.reviewedWords == 1, "Repeated judgments and spelling attempts count as one reviewed word")
        expect(activity.writingAnswers == 1, "Today's submitted answer counts once by its durable attempt identity before feedback")
        let byDay = MiniTodayActivity.byDay(ledger: ledger, from: date(1, hour: 0), through: now, calendar: calendar)
        expect(byDay[date(4, hour: 0)] == activity, "The historical date bucket uses the same deduplicated counts as today")
        expect(byDay[date(3, hour: 0)] == nil, "Opening the group on a previous day does not move later review activity to that day")
    }

    private func testTodayActivityUsesTheCalendarAndIgnoresFutureEvents() {
        var ledger = MiniDailyLedger()
        var day = ledger.beginOrResume(deck: [apple, book, water], at: date(1), calendar: calendar)
        expect(day.addSentences([example(apple), example(book), example(water)]), "Prepare the three study targets")
        expect(day.markStudied(apple, at: date(3, hour: 23)), "Record a previous local day's mark")
        expect(day.markStudied(book, at: date(4, hour: 0)), "Record a mark at the local midnight boundary")
        expect(day.markStudied(water, at: date(4, hour: 13)), "Include a future timestamp in the read-only fixture")
        ledger.days[0] = day
        let now = date(4)
        expect(MiniTodayActivity(ledger: ledger, now: now, calendar: calendar).learnedWords == 1,
               "Today's local midnight is included while yesterday and later today are excluded")
        let byDay = MiniTodayActivity.byDay(ledger: ledger, from: date(3, hour: 0), through: now, calendar: calendar)
        expect(byDay[date(3, hour: 0)]?.learnedWords == 1 && byDay[date(4, hour: 0)]?.learnedWords == 1,
               "Each local-day bucket includes only the learning activity that has actually happened on that date")
        expect(byDay[date(4, hour: 0)]?.completedNewWords == nil,
               "A legacy-only ledger continues to provide the saved study marks as its fallback")
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(secondsFromGMT: 0)!
        expect(MiniTodayActivity(ledger: ledger, now: now, calendar: utc).learnedWords == 0,
               "The supplied plan calendar decides which local date each event belongs to")
        expect(MiniTodayActivity(ledger: ledger, now: date(5), calendar: calendar).learnedWords == 0,
               "A group with historical progress does not create activity on a later day")

        let window = MiniMemoryWindow(version: "interleaved-v2", size: 5, gap: 3, members: [], visit: nil,
                                      events: [], sequence: 0, forceUnseen: false)
        let completion = MiniLearningFlow.Completion(word: apple, attemptId: UUID(), at: date(3, hour: 23),
                                                     date: "2026-11-03")
        day.flow = MiniLearningFlow(version: "sliding-window-v2", targetDate: day.id, dailyNewGoal: 3, completedBeforeRun: 0,
                                   groupSize: 3, candidates: [apple, book, water], candidateIndex: 3, window: window,
                                   groupId: UUID(), groupIndex: 1, groupStartedAt: date(1), groupTarget: 3,
                                   groupWords: [], translationWords: [], groups: [], completed: [completion], goalReached: false)
        ledger.days[0] = day
        let completed = MiniTodayActivity.byDay(ledger: ledger, from: date(3, hour: 0), through: now, calendar: calendar)
        expect(completed[date(3, hour: 0)]?.completedNewWords == 1 &&
               completed[date(4, hour: 0)]?.completedNewWords == 0,
               "Modern heatmap counts use the actual completion date and exclude unconfirmed study marks")
    }

    private func testTodayActivityWaitsForTheFinalMemoryRound() {
        var ledger = MiniDailyLedger()
        var day = ledger.beginOrResume(deck: [apple], at: date(1), calendar: calendar, memoryRounds: true)
        expect(day.addSentences([example(apple)]), "Prepare the memory-round example")
        for _ in 0..<2 {
            expect(day.advanceMemory(remembered: true, at: date(4)), "Complete an early memory round")
        }
        ledger.days[0] = day
        expect(MiniTodayActivity(ledger: ledger, now: date(4), calendar: calendar).learnedWords == 0,
               "The first two memory rounds do not count as completed new-word memory")
        expect(day.advanceMemory(remembered: true, at: date(4)), "Complete the third memory round")
        ledger.days[0] = day
        expect(MiniTodayActivity(ledger: ledger, now: date(4), calendar: calendar).learnedWords == 1,
               "The actual final-round study mark supplies today's new-word count")
        expect(day.undoMemory(at: date(4)), "Undo the final memory mark")
        ledger.days[0] = day
        expect(MiniTodayActivity(ledger: ledger, now: date(4), calendar: calendar).learnedWords == 0,
               "An undone memory mark no longer contributes to today's completed new words")
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
        let previousId = loaded.translation[0].taskID
        expect(loaded.translationPageIndex(selection: previousId) == 0
               && loaded.translationTask(at: 0)?.id == previousId && loaded.currentTranslation?.id != previousId,
               "Reviewing a submitted translation keeps the active question in place")
        expect(loaded.translationPageIndex(selection: "another-day/0") == loaded.translationIndex
               && loaded.translationTask(at: loaded.translationIndex + 1) == nil,
               "Navigation is scoped to reached questions in this group")
        let oldDraft = MiniTranslationAttempt.draftKey(taskId: previousId, revision: id)
        guard let nextId = loaded.currentTranslation?.id else { preconditionFailure("Missing next translation") }
        let activeDraft = MiniTranslationAttempt.draftKey(taskId: nextId)
        expect(loaded.pendingTranslationEdit(in: [oldDraft: "新译文", activeDraft: "下一题草稿"]) == 0
               && loaded.pendingTranslationEdit(in: [oldDraft: raw, activeDraft: "下一题草稿"]) == nil,
               "Pending changes to a previous answer remain distinct from the current unfinished draft")

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
        expect(next.scheduleUpdates.first?.dueAt == date(5, hour: 0), "Teaching feedback preserves the deterministic review due date")
        expect(!next.scheduleUpdates.contains { $0.source == .translation }, "AI translation feedback never schedules a review")
    }

    private func testMemoryRoundsDraftRevealAndUndoSurviveRelaunch() throws {
        var ledger = MiniDailyLedger()
        var day = ledger.beginOrResume(deck: [apple, book], at: date(1), calendar: calendar, memoryRounds: true)
        expect(day.addSentences([example(apple), example(book)]), "Prepare actual memory material")
        expect(day.saveMemoryDraft("  appl  "), "Keep the raw scratchpad from first encounter")
        for _ in 0..<2 { expect(day.advanceMemory(remembered: true, at: date(1)), "Complete the first memory round") }
        expect(day.memory?.round == 2 && day.memory?.completedRounds(for: apple) == 1 && day.studiedWords.isEmpty,
               "First encounter fills exactly one point and leaves the formal gate pending")
        expect(day.revealMemory(at: date(1)), "A second-round reveal is an explicit fact")
        expect(day.advanceMemory(remembered: true, at: date(1)) && day.undoMemory(at: date(1)), "Undo an actual round completion")
        expect(day.memory?.currentWord == apple && day.memory?.completedRounds(for: apple) == 1,
               "Undo restores the same target and its completed points")
        day = try JSONDecoder().decode(MiniDailyDay.self, from: JSONEncoder().encode(day))
        expect(day.memory?.drafts.first?.text == "  appl  " && day.memory?.events.contains(where: { $0.undoneAt != nil }) == true,
               "Relaunch keeps raw draft and undone event history")
        while day.memory?.currentWord != nil { expect(day.advanceMemory(remembered: true, at: date(1)), "Finish the real remaining memory rounds") }
        expect(day.memory?.round == 4 && day.memory?.progress.allSatisfy { $0.completedRounds == 3 } == true,
               "All three points complete before total spelling")
        expect(day.studiedWords.count == 2 && day.learning?.spellingAttempts.isEmpty == true,
               "Memory completion preserves the untouched spelling first answers")
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
