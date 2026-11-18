import Foundation
import NaturalLanguage

struct MiniSentenceSource: Codable, Equatable, Sendable {
    let id: String
    let title: String
    let url: String
    let locator: String
}

struct MiniStudySentence: Codable, Equatable, Sendable {
    let word: MiniWord
    let english: String
    let chinese: String
    var source: MiniSentenceSource? = nil
    var targetForms: [String]? = nil

    var attributedTranslation: String { source.map { "「\($0.title)」" + chinese } ?? chinese }

    var highlightedRanges: [Range<String.Index>] {
        let forms = [word.spelling] + (targetForms ?? [])
        var ranges = forms.flatMap { form -> [Range<String.Index>] in
            let pattern = "(?<![\\p{L}\\p{N}_])" + NSRegularExpression.escapedPattern(for: form) + "(?![\\p{L}\\p{N}_])"
            guard let expression = try? NSRegularExpression(pattern: pattern, options: .caseInsensitive) else { return [] }
            return expression.matches(in: english, range: NSRange(english.startIndex..., in: english))
                .compactMap { Range($0.range, in: english) }
        }
        if targetForms == nil, !english.isEmpty, word.spelling.allSatisfy(\.isLetter) {
            let tagger = NLTagger(tagSchemes: [.lemma])
            tagger.string = english
            tagger.setLanguage(.english, range: english.startIndex..<english.endIndex)
            let target = Self.lemma(word.spelling)
            tagger.enumerateTags(in: english.startIndex..<english.endIndex, unit: .word, scheme: .lemma,
                                 options: [.omitWhitespace, .omitPunctuation]) { tag, range in
                if tag?.rawValue.lowercased() == target { ranges.append(range) }
                return true
            }
        }
        return Array(Set(ranges)).sorted { $0.lowerBound < $1.lowerBound }
    }

    private static func lemma(_ text: String) -> String {
        guard !text.isEmpty else { return text }
        let tagger = NLTagger(tagSchemes: [.lemma])
        tagger.string = text
        tagger.setLanguage(.english, range: text.startIndex..<text.endIndex)
        return tagger.tag(at: text.startIndex, unit: .word, scheme: .lemma).0?.rawValue.lowercased() ?? text.lowercased()
    }
}

enum MiniTranslationDirection: String, Codable, Equatable, Sendable {
    case englishToChinese, chineseToEnglish

    fileprivate var opposite: Self { self == .englishToChinese ? .chineseToEnglish : .englishToChinese }
}

struct MiniTranslationFeedback: Codable, Equatable, Sendable {
    enum Outcome: String, Codable, Equatable, Sendable {
        case correct, partial, incorrect
    }

    let outcome: Outcome?
    let comment: String
    let tip: String
    let usefulPhrase: String
    let strengths: [String]?
    let improvements: [String]?
    let keyPoints: [String]?
    let referenceTranslation: String?

    init(outcome: Outcome? = nil, comment: String, tip: String, usefulPhrase: String,
         strengths: [String]? = nil, improvements: [String]? = nil,
         keyPoints: [String]? = nil, referenceTranslation: String? = nil) {
        self.outcome = outcome
        self.comment = comment
        self.tip = tip
        self.usefulPhrase = usefulPhrase
        self.strengths = strengths
        self.improvements = improvements
        self.keyPoints = keyPoints
        self.referenceTranslation = referenceTranslation
    }
}

struct MiniWritingPrompt: Codable, Equatable, Sendable, Identifiable {
    let id: UUID
    let sentence: MiniStudySentence
    let direction: MiniTranslationDirection
    let focusIds: [UUID]
    let createdAt: Date
}

struct MiniWritingPromptInput: Codable, Sendable {
    let id: UUID
    let sentence: MiniStudySentence
    let direction: MiniTranslationDirection
    let focusIds: [UUID]
}

struct MiniTranslationTask: Codable, Equatable, Sendable, Identifiable {
    let id: String
    let sentence: MiniStudySentence
    let direction: MiniTranslationDirection
    var materialId: UUID? = nil
    var focusIds: [UUID]? = nil

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
    var confirmedAt: Date? = nil

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

struct MiniMemoryRounds: Codable, Equatable, Sendable {
    struct Progress: Codable, Equatable, Sendable {
        let word: MiniWord
        var completedRounds: Int
    }
    struct Event: Codable, Equatable, Sendable {
        let id: UUID
        let word: MiniWord
        let round: Int
        let remembered: Bool
        let at: Date
        var undoneAt: Date? = nil
    }
    struct Draft: Codable, Equatable, Sendable {
        let word: MiniWord
        let round: Int
        var text: String
        var updatedAt: Date
    }
    struct Reveal: Codable, Equatable, Sendable {
        let word: MiniWord
        let round: Int
        let at: Date
        let beforeEventCount: Int
    }
    let version: String
    var round: Int
    var queue: [MiniWord]
    var progress: [Progress]
    var events: [Event]
    var drafts: [Draft]
    var reveals: [Reveal]
    var revealed: Bool

    init(words: [MiniWord]) {
        version = "three-rounds-v1"
        round = 1
        queue = words
        progress = words.map { Progress(word: $0, completedRounds: 0) }
        events = []
        drafts = []
        reveals = []
        revealed = false
    }
    var currentWord: MiniWord? { round < 4 ? queue.first : nil }
    func completedRounds(for word: MiniWord) -> Int {
        progress.first { $0.word == word }?.completedRounds ?? 0
    }
}

struct MiniDailyDay: Codable, Equatable, Sendable, Identifiable {
    enum Phase: String, Codable, Equatable, Sendable {
        case review, learning, translation, finished
    }

    let id: String
    let startedAt: Date
    var writingRequired: Bool? = nil
    var writingPrompts: [MiniWritingPrompt]? = nil
    var writingMode: String? = nil
    var retainedLearningWord: MiniWord? = nil
    var memory: MiniMemoryRounds? = nil
    var flow: MiniLearningFlow? = nil
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
        sentences: [MiniStudySentence],
        memoryRounds: Bool = false
    ) {
        self.id = id
        startedAt = at
        self.reviewWords = reviewWords
        self.learningWords = learningWords
        self.reviewSteps = reviewSteps
        self.directions = directions
        self.sentences = sentences
        review = reviewWords.isEmpty ? nil : MiniReviewSession(words: reviewWords, usesErrorRetries: memoryRounds)
        learning = learningWords.isEmpty ? nil : MiniReviewSession(words: learningWords, startingWithSpelling: true, usesErrorRetries: memoryRounds)
        memory = memoryRounds && !learningWords.isEmpty ? MiniMemoryRounds(words: learningWords) : nil
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
        (flow?.candidates ?? learningWords).filter { word in !sentences.contains { $0.word == word } }
    }

    var nextUnstudiedWord: MiniWord? {
        if let flow {
            return flow.groupWords.count < flow.groupTarget ? flow.window.visit?.word : nil
        }
        if let memory { return memory.currentWord }
        return learningWords.first { word in !studiedWords.contains { $0.word == word } }
    }

    var memoryWindow: MiniMemoryWindow? {
        if phase == .review { return review?.relearning?.visit == nil ? nil : review?.relearning }
        guard phase == .learning, let flow, flow.groupWords.count < flow.groupTarget else { return nil }
        return flow.window.visit == nil ? nil : flow.window
    }

    var memoryShowsFullCard: Bool {
        if let visit = memoryWindow?.visit { return visit.showsFullCard }
        return memory.map { $0.round == 1 || $0.revealed } ?? true
    }

    @discardableResult
    mutating func advanceMemory(remembered: Bool, at time: Date = .now) -> Bool {
        guard phase == .learning, !paused, var state = memory, let word = state.currentWord,
              sentences.contains(where: { $0.word == word }) else { return false }
        state.events.append(MiniMemoryRounds.Event(id: UUID(), word: word, round: state.round,
                                                  remembered: remembered, at: time))
        state.queue.removeFirst()
        if remembered {
            if let index = state.progress.firstIndex(where: { $0.word == word }) {
                state.progress[index].completedRounds = state.round
            }
            if state.round == 3 { studiedWords.append(MiniStudyExposure(word: word, at: time)) }
        } else { state.queue.append(word) }
        if state.queue.isEmpty {
            state.round += 1
            if state.round < 4 { state.queue = learningWords }
        }
        state.revealed = false
        memory = state
        return true
    }

    @discardableResult
    mutating func revealMemory(at time: Date = .now) -> Bool {
        guard phase == .learning, !paused, var state = memory, let word = state.currentWord,
              state.round > 1, !state.revealed else { return false }
        state.revealed = true
        state.reveals.append(MiniMemoryRounds.Reveal(word: word, round: state.round, at: time, beforeEventCount: state.events.count))
        memory = state
        return true
    }

    @discardableResult
    mutating func saveMemoryDraft(_ text: String, at time: Date = .now) -> Bool {
        guard var state = memory, let word = state.currentWord else { return false }
        if let index = state.drafts.firstIndex(where: { $0.word == word && $0.round == state.round }) {
            state.drafts[index].text = text
            state.drafts[index].updatedAt = time
        } else {
            state.drafts.append(MiniMemoryRounds.Draft(word: word, round: state.round, text: text, updatedAt: time))
        }
        memory = state
        return true
    }

    @discardableResult
    mutating func undoMemory(at time: Date = .now) -> Bool {
        guard phase == .learning, !paused, var state = memory,
              learning?.spellingAttempts.isEmpty == true,
              let index = state.events.lastIndex(where: { $0.undoneAt == nil }) else { return false }
        state.events[index].undoneAt = time
        var restored = MiniMemoryRounds(words: learningWords)
        var restoredStudy: [MiniStudyExposure] = []
        for event in state.events where event.undoneAt == nil {
            guard restored.round == event.round, restored.currentWord == event.word else { return false }
            restored.queue.removeFirst()
            if event.remembered {
                if let position = restored.progress.firstIndex(where: { $0.word == event.word }) {
                    restored.progress[position].completedRounds = event.round
                }
                if event.round == 3 { restoredStudy.append(MiniStudyExposure(word: event.word, at: event.at)) }
            } else { restored.queue.append(event.word) }
            if restored.queue.isEmpty {
                restored.round += 1
                if restored.round < 4 { restored.queue = learningWords }
            }
        }
        restored.events = state.events
        restored.drafts = state.drafts
        restored.reveals = state.reveals
        state = restored
        studiedWords = restoredStudy
        memory = state
        return true
    }

    var translationCount: Int {
        if let flow { return flow.translationWords.count }
        return writingRequired == false ? 0 : reviewWords.count + learningWords.count
    }

    var currentTranslation: MiniTranslationTask? {
        guard phase == .translation, translationIndex < translationCount,
              directions.indices.contains(translationIndex) else { return nil }
        let taskID = "\(id)/\(translationIndex)"
        if let attempt = translation.last(where: { $0.taskID == taskID }) { return attempt.task }
        let word = (flow?.translationWords ?? (reviewWords + learningWords))[translationIndex]
        let direction = directions[translationIndex]
        if let prompt = writingPrompts?.last(where: { $0.sentence.word == word && $0.direction == direction }) {
            return MiniTranslationTask(id: taskID, sentence: prompt.sentence, direction: direction,
                                       materialId: prompt.id, focusIds: prompt.focusIds)
        }
        guard writingMode != "prepared" else { return nil }
        guard let sentence = sentences.first(where: { $0.word == word }) else { return nil }
        return MiniTranslationTask(id: taskID, sentence: sentence, direction: direction)
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
        if memory != nil { return nextUnstudiedWord == word && advanceMemory(remembered: true, at: at) }
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
        // Feedback is teaching evidence; only the deterministic review/learning flow schedules words.
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

struct MiniTodayActivity: Equatable, Sendable {
    let learnedWords: Int
    let completedNewWords: Int?
    let reviewedWords: Int
    let writingAnswers: Int

    init(ledger: MiniDailyLedger, now: Date = .now, calendar: Calendar = .current) {
        var learned = Set<MiniDailyWordKey>()
        var completed = Set<MiniDailyWordKey>()
        var reviewed = Set<MiniDailyWordKey>()
        var writing = Set<UUID>()
        func isToday(_ time: Date) -> Bool {
            time <= now && calendar.isDate(time, inSameDayAs: now)
        }
        for day in ledger.days {
            for item in day.flow?.completed ?? [] where isToday(item.at) {
                completed.insert(MiniDailyWordKey(item.word))
            }
            for exposure in day.studiedWords where isToday(exposure.at) {
                learned.insert(MiniDailyWordKey(exposure.word))
            }
            if let review = day.review {
                for event in review.relearning?.events ?? [] where isToday(event.confirmedAt) {
                    reviewed.insert(MiniDailyWordKey(event.word))
                }
                if let visit = review.relearning?.visit, let selectedAt = visit.selectedAt, isToday(selectedAt) {
                    reviewed.insert(MiniDailyWordKey(visit.word))
                }
                for event in review.judgmentEvents where isToday(event.selectedAt) {
                    reviewed.insert(MiniDailyWordKey(event.word))
                }
                for attempt in review.spellingAttempts where isToday(attempt.submittedAt) {
                    reviewed.insert(MiniDailyWordKey(attempt.word))
                }
            }
            for attempt in day.translation where isToday(attempt.submittedAt) {
                writing.insert(attempt.id)
            }
        }
        learnedWords = learned.count
        completedNewWords = ledger.days.contains { $0.flow != nil } ? completed.count : nil
        reviewedWords = reviewed.count
        writingAnswers = writing.count
    }
}

struct MiniDailyLedger: Codable, Equatable, Sendable {
    var days: [MiniDailyDay] = []

    @discardableResult
    mutating func beginOrResume(deck: [MiniWord], at: Date = .now, calendar: Calendar = .current, memoryRounds: Bool = false) -> MiniDailyDay {
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
                canonical[MiniDailyWordKey(word)].map { MiniStudySentence(word: word, english: $0.english, chinese: $0.chinese, source: $0.source, targetForms: $0.targetForms) }
            },
            memoryRounds: memoryRounds
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
                return "\(day.id) \(attempt.task.sentence.word.spelling) 翻译反馈：\(feedback.comment.prefix(120))"
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
