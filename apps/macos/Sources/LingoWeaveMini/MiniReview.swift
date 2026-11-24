import Foundation

enum MiniReviewJudgment: String, Codable, Sendable {
    case forgotten, fuzzy, clear
}

struct MiniReviewProgressDot: Identifiable, Equatable, Sendable {
    enum State: Equatable, Sendable {
        case current, passed, repeatNext, pending, capped
    }

    let id: MiniWord
    let state: State
}

struct MiniReviewSession: Codable, Equatable, Sendable {
    enum Phase: String, Codable, Sendable {
        case judgment, spelling, finished
    }

    enum SpellingState: String, Codable, Sendable {
        case awaitingFirst, correcting, readyToAdvance, skipped
    }

    struct JudgmentEvent: Codable, Equatable, Sendable {
        let word: MiniWord
        let selected: MiniReviewJudgment
        let selectedAt: Date
        fileprivate(set) var final: MiniReviewJudgment?
        fileprivate(set) var finalizedAt: Date?
    }

    struct SpellingAttempt: Codable, Equatable, Sendable {
        enum Kind: String, Codable, Sendable {
            case first, correction
        }

        let word: MiniWord
        let encounter: Int
        let kind: Kind
        let answer: String
        let correct: Bool
        let submittedAt: Date
        let lastAnswerRevealAt: Date?
        let revealedAnswerAt: Date?
        var lastPotentialHelpAt: Date? = nil
    }

    struct SpellingRound: Codable, Equatable, Sendable {
        let round: Int
        let order: [Int]
    }

    struct SpellingSkip: Codable, Equatable, Sendable {
        let word: MiniWord
        let round: Int
        let at: Date
    }

    private let words: [MiniWord]
    private var queue: [MiniWord]
    private let fullBatchSpelling: Bool?
    private let spellingPolicy: String?
    private(set) var spellingRounds: [SpellingRound]? = nil
    var relearning: MiniMemoryWindow? = nil
    var relearningWords: [MiniWord]? = nil
    private(set) var spellingSkips: [SpellingSkip]? = nil
    private(set) var phase: Phase
    private(set) var judgmentEvents: [JudgmentEvent] = []
    private(set) var spellingAttempts: [SpellingAttempt] = []
    private(set) var spellingState: SpellingState = .awaitingFirst
    var spellingDraft = ""

    init(words: [MiniWord], startingWithSpelling: Bool = false, usesErrorRetries: Bool = true) {
        var seen = Set<MiniWord>()
        let unique = words.filter { seen.insert($0).inserted }
        self.words = unique
        self.queue = unique
        self.fullBatchSpelling = startingWithSpelling ? true : nil
        self.spellingPolicy = usesErrorRetries ? "retry-errors-v1" : nil
        self.spellingSkips = usesErrorRetries ? [] : nil
        self.phase = unique.isEmpty ? .finished : (startingWithSpelling ? .spelling : .judgment)
    }

    init(windowWords: [MiniWord], seed: UUID) {
        words = windowWords
        queue = []
        fullBatchSpelling = true
        spellingPolicy = "retry-errors-v2"
        spellingSkips = []
        phase = .spelling
        startWindowSpelling(seed: seed)
    }

    /// Mirror the service's UUID-seeded Fisher–Yates permutation only on entry from a window.
    mutating func startWindowSpelling(seed: UUID) {
        phase = words.isEmpty ? .finished : .spelling
        queue = words
        spellingDraft = ""
        guard words.count >= 2 else { return }
        var state = UInt32(seed.uuidString.prefix(8), radix: 16) ?? 1
        if state == 0 { state = 1 }
        var order = Array(words.indices)
        for index in 0..<(order.count - 1) {
            state ^= state << 13
            state ^= state >> 17
            state ^= state << 5
            let min = index == 0 ? 1 : index
            let next = min + Int(state) % (order.count - min)
            order.swapAt(index, next)
        }
        queue = order.map { words[$0] }
        spellingRounds = (spellingRounds ?? []) + [.init(round: 1, order: order)]
    }

    var currentWord: MiniWord? { queue.first }
    var usesWindowFlow: Bool { spellingPolicy == "retry-errors-v2" }
    var totalCount: Int { words.count }
    var remainingCount: Int { queue.count }
    var currentSpellingRound: Int {
        if let attempt = lastSpellingAttempt { return attempt.encounter }
        guard let word = currentWord else { return 1 }
        return spellingAttempts.count { $0.word == word && $0.kind == .first } + 1
    }

    /// A further prompt within this round already has a server-assigned position.
    /// Shuffles, phase changes and the relearning window wait for the command receipt.
    var hasKnownNextJudgment: Bool { phase == .judgment && queue.count > 1 }
    var hasKnownNextSpelling: Bool {
        guard phase == .spelling, let attempt = lastSpellingAttempt, let next = queue.dropFirst().first else { return false }
        return !spellingAttempts.contains { $0.kind == .first && $0.encounter == attempt.encounter && $0.word == next }
    }

    var progressDots: [MiniReviewProgressDot] {
        let waiting = Set(queue)
        let current = currentWord
        let clearedJudgment: Set<MiniWord>
        let needsRepeat: Set<MiniWord>
        switch phase {
        case .judgment:
            clearedJudgment = Set(judgmentEvents.lazy.filter { $0.final == .clear }.map(\.word))
            needsRepeat = Set(judgmentEvents.lazy.filter { $0.final == .forgotten || $0.final == .fuzzy }.map(\.word))
        case .spelling, .finished:
            clearedJudgment = []
            needsRepeat = Set(spellingAttempts.lazy.filter { $0.kind == .first && !$0.correct }.map(\.word))
        }

        // Keep each indicator in the same position for this spelling session.
        let displayWords: [MiniWord]
        if phase != .judgment, let first = spellingRounds?.first(where: { $0.round == 1 }),
           first.order.count == words.count, Set(first.order) == Set(words.indices) {
            displayWords = first.order.map { words[$0] }
        } else {
            displayWords = words
        }
        return displayWords.map { word in
            let state: MiniReviewProgressDot.State
            if word == current {
                state = .current
            } else if spellingSkips?.contains(where: { $0.word == word }) == true {
                state = .capped
            } else if !waiting.contains(word) {
                state = phase == .judgment && !clearedJudgment.contains(word) ? .capped : .passed
            } else {
                state = needsRepeat.contains(word) ? .repeatNext : .pending
            }
            return MiniReviewProgressDot(id: word, state: state)
        }
    }

    var currentJudgment: MiniReviewJudgment? {
        guard phase == .judgment, let event = judgmentEvents.last, event.final == nil else { return nil }
        return event.selected
    }

    var lastSpellingAttempt: SpellingAttempt? {
        guard phase == .spelling, spellingState != .awaitingFirst else { return nil }
        return spellingAttempts.last
    }

    var lastExposureAt: Date? {
        guard let word = currentWord else { return nil }
        let spellingReveal = spellingAttempts.last { $0.word == word && $0.revealedAnswerAt != nil }
        return spellingReveal?.revealedAnswerAt ?? judgmentEvents.last { $0.word == word }?.selectedAt
    }

    @discardableResult
    mutating func chooseJudgment(_ rating: MiniReviewJudgment, at time: Date = .now) -> Bool {
        guard phase == .judgment, let word = currentWord, currentJudgment == nil else { return false }
        judgmentEvents.append(JudgmentEvent(word: word, selected: rating, selectedAt: time))
        return true
    }

    @discardableResult
    mutating func advanceJudgment(markWrong: Bool = false, at time: Date = .now) -> Bool {
        guard let rating = currentJudgment, let word = currentWord,
              let event = judgmentEvents.indices.last else { return false }
        let final: MiniReviewJudgment = markWrong ? .forgotten : rating
        judgmentEvents[event].final = final
        judgmentEvents[event].finalizedAt = time

        queue.removeFirst()
        if final != .clear {
            let repeatCount = judgmentEvents.count { $0.word == word && ($0.final == .forgotten || $0.final == .fuzzy) }
            if repeatCount < 3 { queue.append(word) }
        }

        if queue.isEmpty {
            phase = .spelling
            queue = words
            spellingDraft = ""
        }
        return true
    }

    /// The same literal, lower-cased comparison as the service's String.trim()/toLowerCase().
    static func matchesSpelling(_ raw: String, word: String, trimWord: Bool = false) -> Bool {
        let whitespace = CharacterSet(charactersIn: "\u{9}\u{a}\u{b}\u{c}\u{d}\u{20}\u{a0}\u{1680}\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}")
        let target = trimWord ? word.trimmingCharacters(in: whitespace) : word
        return raw.trimmingCharacters(in: whitespace).lowercased().utf8.elementsEqual(target.lowercased().utf8)
    }

    @discardableResult
    mutating func submitSpelling(_ raw: String, at time: Date = .now, advanceLegacySkip: Bool = true,
                                 advanceOnCorrect: Bool = false) -> Bool {
        guard phase == .spelling, spellingState != .readyToAdvance, spellingState != .skipped, let word = currentWord else { return false }
        guard raw != lastSpellingAttempt?.answer else { return false }

        let kind: SpellingAttempt.Kind = spellingState == .awaitingFirst ? .first : .correction
        let encounter = lastSpellingAttempt?.encounter ?? spellingAttempts.count { $0.word == word && $0.kind == .first } + 1
        let correct = Self.matchesSpelling(raw, word: word.spelling)
        spellingAttempts.append(SpellingAttempt(
            word: word,
            encounter: encounter,
            kind: kind,
            answer: raw,
            correct: correct,
            submittedAt: time,
            lastAnswerRevealAt: lastExposureAt,
            revealedAnswerAt: kind == .first && !correct ? time : nil
        ))
        spellingDraft = raw
        spellingState = correct ? .readyToAdvance : .correcting
        if (usesWindowFlow || spellingPolicy == "retry-errors-v1"), kind == .first, !correct, encounter >= (usesWindowFlow ? 3 : 5) {
            if spellingSkips == nil { spellingSkips = [] }
            spellingSkips?.append(SpellingSkip(word: word, round: encounter, at: time))
            spellingState = .skipped
            if !usesWindowFlow && advanceLegacySkip { advanceSpelling() }
        }
        if correct, advanceOnCorrect { advanceSpelling() }
        return true
    }

    @discardableResult
    mutating func advanceSpelling() -> Bool {
        guard phase == .spelling, spellingState == .readyToAdvance || spellingState == .skipped,
              let attempt = lastSpellingAttempt else { return false }
        queue.removeFirst()
        if usesWindowFlow || spellingPolicy == "retry-errors-v1" {
            let first = spellingAttempts.first { $0.word == attempt.word && $0.encounter == attempt.encounter && $0.kind == .first }
            if first?.correct == false, attempt.encounter < (usesWindowFlow ? 3 : 5) { queue.append(attempt.word) }
        } else if fullBatchSpelling == true {
            if queue.isEmpty && spellingAttempts.contains(where: {
                $0.encounter == attempt.encounter && $0.kind == .first && !$0.correct
            }) {
                queue = words
            }
        } else if attempt.kind == .correction {
            queue.append(attempt.word)
        }
        spellingDraft = ""
        spellingState = .awaitingFirst
        if queue.isEmpty { phase = .finished }
        return true
    }
}
