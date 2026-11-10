import Foundation

struct MiniStudySentence: Codable, Equatable, Sendable {
    let word: MiniWord
    let english: String
    let chinese: String
}

enum MiniTranslationDirection: String, Codable, Equatable, Sendable {
    case englishToChinese, chineseToEnglish

    fileprivate var opposite: Self { self == .englishToChinese ? .chineseToEnglish : .englishToChinese }
}

struct MiniTranslationFeedback: Codable, Equatable, Sendable {
    enum Outcome: String, Codable, Equatable, Sendable {
        case correct, partial, incorrect
    }

    let outcome: Outcome
    let comment: String
    let tip: String
    let usefulPhrase: String
}

struct MiniTranslationTask: Codable, Equatable, Sendable, Identifiable {
    let id: String
    let sentence: MiniStudySentence
    let direction: MiniTranslationDirection

    var prompt: String { direction == .englishToChinese ? sentence.english : sentence.chinese }
    var reference: String { direction == .englishToChinese ? sentence.chinese : sentence.english }
}

struct MiniTranslationAttempt: Codable, Equatable, Sendable, Identifiable {
    let id: UUID
    let task: MiniTranslationTask
    let answer: String
    let submittedAt: Date
    fileprivate(set) var feedback: MiniTranslationFeedback?
    fileprivate(set) var gradedAt: Date?

    var taskID: String { task.id }
}

struct MiniStudyExposure: Codable, Equatable, Sendable {
    let word: MiniWord
    let at: Date
}

struct MiniStudyPauseEvent: Codable, Equatable, Sendable {
    let paused: Bool
    let at: Date
}

struct MiniDailySchedule: Codable, Equatable, Sendable {
    enum Source: String, Codable, Equatable, Sendable {
        case review, learning, translation
    }

    let word: MiniWord
    let dueAt: Date
    let step: Int
    let recordedAt: Date
    let source: Source
    let policyVersion: Int
}

private struct MiniDailyWordKey: Hashable {
    let spelling: String
    let meaning: String

    init(_ word: MiniWord) {
        spelling = word.spelling.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        meaning = word.meaning.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

struct MiniDailyDay: Codable, Equatable, Sendable, Identifiable {
    enum Phase: String, Codable, Equatable, Sendable {
        case review, learning, translation, finished
    }

    let id: String
    let startedAt: Date
    let reviewWords: [MiniWord]
    let learningWords: [MiniWord]
    private let reviewSteps: [Int]
    private let directions: [MiniTranslationDirection]
    var review: MiniReviewSession?
    var learning: MiniReviewSession?
    private(set) var paused = false
    private(set) var pauseEvents: [MiniStudyPauseEvent]?
    private(set) var phase: Phase
    private(set) var reviewFinishedAt: Date?
    private(set) var learningStartedAt: Date?
    private(set) var learningFinishedAt: Date?
    private(set) var translationStartedAt: Date?
    private(set) var finishedAt: Date?
    private(set) var studiedWords: [MiniStudyExposure] = []
    private(set) var sentences: [MiniStudySentence]
    private(set) var translation: [MiniTranslationAttempt] = []
    var translationDraft = ""
    private(set) var translationIndex = 0
    private(set) var scheduleUpdates: [MiniDailySchedule] = []

    fileprivate init(
        id: String,
        at: Date,
        reviewWords: [MiniWord],
        learningWords: [MiniWord],
        reviewSteps: [Int],
        directions: [MiniTranslationDirection],
        sentences: [MiniStudySentence]
    ) {
        self.id = id
        startedAt = at
        self.reviewWords = reviewWords
        self.learningWords = learningWords
        self.reviewSteps = reviewSteps
        self.directions = directions
        self.sentences = sentences
        review = reviewWords.isEmpty ? nil : MiniReviewSession(words: reviewWords)
        learning = learningWords.isEmpty ? nil : MiniReviewSession(words: learningWords, startingWithSpelling: true)
        if review != nil {
            phase = .review
        } else if learning != nil {
            phase = .learning
            learningStartedAt = at
        } else {
            phase = .finished
            finishedAt = at
        }
    }

    var wordsToPrepare: [MiniWord] {
        learningWords.filter { word in !sentences.contains { $0.word == word } }
    }

    var nextUnstudiedWord: MiniWord? {
        learningWords.first { word in !studiedWords.contains { $0.word == word } }
    }

    var translationCount: Int { reviewWords.count + learningWords.count }

    var currentTranslation: MiniTranslationTask? {
        guard phase == .translation, translationIndex < translationCount,
              directions.indices.contains(translationIndex) else { return nil }
        let word = (reviewWords + learningWords)[translationIndex]
        guard let sentence = sentences.first(where: { $0.word == word }) else { return nil }
        return MiniTranslationTask(id: "\(id)/\(translationIndex)", sentence: sentence, direction: directions[translationIndex])
    }

    var currentAttempt: MiniTranslationAttempt? {
        guard let task = currentTranslation else { return nil }
        return translation.last { $0.taskID == task.id }
    }

    @discardableResult
    mutating func setPaused(_ paused: Bool, at: Date = .now) -> Bool {
        guard phase != .finished, self.paused != paused else { return false }
        self.paused = paused
        if pauseEvents == nil { pauseEvents = [] }
        pauseEvents?.append(MiniStudyPauseEvent(paused: paused, at: at))
        return true
    }

    @discardableResult
    mutating func addSentences(_ additions: [MiniStudySentence]) -> Bool {
        let missing = Set(wordsToPrepare)
        let supplied = Set(additions.map(\.word))
        let complete = additions.allSatisfy { sentence in
            !sentence.english.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                && !sentence.chinese.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        guard phase != .finished, !additions.isEmpty, supplied.count == additions.count,
              supplied.isSubset(of: missing), complete else { return false }
        sentences.append(contentsOf: additions)
        return true
    }

    @discardableResult
    mutating func markStudied(_ word: MiniWord, at: Date = .now) -> Bool {
        guard phase == .learning, !paused, nextUnstudiedWord == word,
              sentences.contains(where: { $0.word == word }) else { return false }
        studiedWords.append(MiniStudyExposure(word: word, at: at))
        return true
    }

    @discardableResult
    mutating func completeReview(at: Date = .now, calendar: Calendar = .current) -> Bool {
        guard phase == .review, !paused, let review, review.phase == .finished else { return false }
        for (word, previousStep) in zip(reviewWords, reviewSteps) {
            let judgment = review.judgmentEvents.first { $0.word == word }?.final
            let first = review.spellingAttempts.first { $0.word == word && $0.kind == .first }
            let promoted = min(max(previousStep, 0), Self.intervals.count - 2) + 1
            let step = judgment == .clear && first?.correct == true ? promoted : 0
            schedule(word, step: step, source: .review, at: at, calendar: calendar)
        }
        reviewFinishedAt = at
        if learning == nil {
            beginTranslation(at: at)
        } else {
            phase = .learning
            learningStartedAt = at
        }
        return true
    }

    @discardableResult
    mutating func completeLearning(at: Date = .now, calendar: Calendar = .current) -> Bool {
        guard phase == .learning, !paused, nextUnstudiedWord == nil,
              let learning, learning.phase == .finished else { return false }
        for word in learningWords {
            let first = learning.spellingAttempts.first { $0.word == word && $0.kind == .first }
            schedule(word, step: 0, source: .learning, at: at, calendar: calendar, interval: first?.correct == true ? 2 : 1)
        }
        learningFinishedAt = at
        beginTranslation(at: at)
        return true
    }

    @discardableResult
    mutating func submitTranslation(_ answer: String, at: Date = .now) -> UUID? {
        guard !paused, let task = currentTranslation, currentAttempt == nil, answer.count <= 4_000,
              !answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        let attempt = MiniTranslationAttempt(id: UUID(), task: task, answer: answer, submittedAt: at)
        translation.append(attempt)
        translationDraft = ""
        return attempt.id
    }

    @discardableResult
    mutating func gradeTranslation(
        id: UUID,
        feedback: MiniTranslationFeedback,
        at: Date = .now,
        calendar: Calendar = .current
    ) -> Bool {
        guard let attempt = currentAttempt, attempt.id == id, attempt.feedback == nil,
              let index = translation.indices.last, translation[index].id == id else { return false }
        translation[index].feedback = feedback
        translation[index].gradedAt = at
        if feedback.outcome != .correct {
            let word = attempt.task.sentence.word
            let priorDue = scheduleUpdates.last { $0.word == word }?.dueAt
            schedule(word, step: 0, source: .translation, at: at, calendar: calendar, latestDue: priorDue)
        }
        return true
    }

    @discardableResult
    mutating func advanceTranslation(at: Date = .now) -> Bool {
        guard !paused, currentAttempt?.feedback != nil else { return false }
        translationIndex += 1
        if translationIndex == translationCount {
            phase = .finished
            finishedAt = at
        }
        return true
    }

    private mutating func beginTranslation(at: Date) {
        phase = .translation
        translationStartedAt = at
    }

    // Version 1 is a local calendar-day cadence, not a claim of independent mastery.
    private static let intervals = [1, 3, 7, 14, 30]

    private mutating func schedule(
        _ word: MiniWord,
        step: Int,
        source: MiniDailySchedule.Source,
        at: Date,
        calendar: Calendar,
        interval: Int? = nil,
        latestDue: Date? = nil
    ) {
        let startOfDay = calendar.startOfDay(for: at)
        guard let proposed = calendar.date(byAdding: .day, value: interval ?? Self.intervals[step], to: startOfDay) else { return }
        let dueAt = min(proposed, latestDue ?? proposed)
        scheduleUpdates.append(MiniDailySchedule(word: word, dueAt: dueAt, step: step, recordedAt: at, source: source, policyVersion: 1))
    }
}

struct MiniDailyLedger: Codable, Equatable, Sendable {
    var days: [MiniDailyDay] = []

    @discardableResult
    mutating func beginOrResume(deck: [MiniWord], at: Date = .now, calendar: Calendar = .current) -> MiniDailyDay {
        if let pending = days.last(where: { $0.phase != .finished }) { return pending }
        let parts = calendar.dateComponents([.year, .month, .day], from: at)
        let id = String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
        let existingIndex = days.lastIndex { $0.id == id }
        if let existingIndex, days[existingIndex].translationCount > 0 { return days[existingIndex] }

        var schedules: [MiniDailyWordKey: MiniDailySchedule] = [:]
        var canonical: [MiniDailyWordKey: MiniStudySentence] = [:]
        var directions: [MiniDailyWordKey: MiniTranslationDirection] = [:]
        for day in days {
            for update in day.scheduleUpdates { schedules[MiniDailyWordKey(update.word)] = update }
            for sentence in day.sentences {
                let key = MiniDailyWordKey(sentence.word)
                if canonical[key] == nil { canonical[key] = sentence }
            }
            for attempt in day.translation where attempt.feedback != nil {
                directions[MiniDailyWordKey(attempt.task.sentence.word)] = attempt.task.direction
            }
        }

        var seen = Set<MiniDailyWordKey>()
        let candidates = deck.filter { word in
            let key = MiniDailyWordKey(word)
            return !key.spelling.isEmpty && !key.meaning.isEmpty && seen.insert(key).inserted
        }
        let due = candidates.enumerated().compactMap { offset, word -> (Int, MiniWord, MiniDailySchedule)? in
            guard let schedule = schedules[MiniDailyWordKey(word)], schedule.dueAt <= at else { return nil }
            return (offset, word, schedule)
        }.sorted { lhs, rhs in
            lhs.2.dueAt == rhs.2.dueAt ? lhs.0 < rhs.0 : lhs.2.dueAt < rhs.2.dueAt
        }.prefix(5)
        let reviewWords = due.map { $0.1 }
        let learningWords = Array(candidates.filter { schedules[MiniDailyWordKey($0)] == nil }.prefix(5))
        let plannedWords = reviewWords + learningWords
        if let existingIndex, plannedWords.isEmpty { return days[existingIndex] }
        let day = MiniDailyDay(
            id: id,
            at: at,
            reviewWords: reviewWords,
            learningWords: learningWords,
            reviewSteps: due.map { $0.2.step },
            directions: plannedWords.enumerated().map { offset, word in
                directions[MiniDailyWordKey(word)]?.opposite ?? (offset.isMultiple(of: 2) ? .englishToChinese : .chineseToEnglish)
            },
            sentences: plannedWords.compactMap { word in
                canonical[MiniDailyWordKey(word)].map { MiniStudySentence(word: word, english: $0.english, chinese: $0.chinese) }
            }
        )
        if let existingIndex {
            days[existingIndex] = day
        } else {
            days.append(day)
        }
        return day
    }

    var teachingHistory: [String] {
        days.suffix(3).flatMap { day in
            let firstMistakes = [day.review, day.learning].compactMap { $0 }.flatMap { session in
                session.spellingAttempts.filter { $0.kind == .first && !$0.correct }
            }.prefix(5).map { "\(day.id) \($0.word.spelling) 首答拼写：\($0.answer.prefix(80))" }
            let translations = day.translation.compactMap { attempt -> String? in
                guard let feedback = attempt.feedback else { return nil }
                return "\(day.id) \(attempt.task.sentence.word.spelling) 翻译 \(feedback.outcome.rawValue)：\(feedback.comment.prefix(120))"
            }.prefix(5)
            return firstMistakes + translations
        }
    }
}

struct MiniDailyStorage {
    private let directory: URL

    init(directory: URL? = nil) {
        self.directory = directory ?? URL.applicationSupportDirectory
            .appending(path: Bundle.main.bundleIdentifier ?? "com.lingoweave.mini", directoryHint: .isDirectory)
            .appending(path: "DailyStudy", directoryHint: .isDirectory)
    }

    private var file: URL { directory.appending(path: "ledger.json") }

    func load() throws -> MiniDailyLedger {
        let data: Data
        do {
            data = try Data(contentsOf: file)
        } catch let error as CocoaError where error.code == .fileReadNoSuchFile || error.code == .fileNoSuchFile {
            return MiniDailyLedger()
        }
        return try JSONDecoder().decode(MiniDailyLedger.self, from: data)
    }

    func save(_ ledger: MiniDailyLedger) throws {
        _ = try load()
        let data = try JSONEncoder().encode(ledger)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try data.write(to: file, options: .atomic)
    }
}
