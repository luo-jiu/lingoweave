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
        case awaitingFirst, correcting, readyToAdvance
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
    }

    private let words: [MiniWord]
    private var queue: [MiniWord]
    private let fullBatchSpelling: Bool?
    private(set) var phase: Phase
    private(set) var judgmentEvents: [JudgmentEvent] = []
    private(set) var spellingAttempts: [SpellingAttempt] = []
    private(set) var spellingState: SpellingState = .awaitingFirst
    var spellingDraft = ""

    init(words: [MiniWord], startingWithSpelling: Bool = false) {
        var seen = Set<MiniWord>()
        let unique = words.filter { seen.insert($0).inserted }
        self.words = unique
        self.queue = unique
        self.fullBatchSpelling = startingWithSpelling ? true : nil
        self.phase = unique.isEmpty ? .finished : (startingWithSpelling ? .spelling : .judgment)
    }

    var currentWord: MiniWord? { queue.first }
    var totalCount: Int { words.count }
    var remainingCount: Int { queue.count }

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

        return words.map { word in
            let state: MiniReviewProgressDot.State
            if word == current {
                state = .current
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

    @discardableResult
    mutating func submitSpelling(_ raw: String, at time: Date = .now) -> Bool {
        guard phase == .spelling, spellingState != .readyToAdvance, let word = currentWord else { return false }
        let answer = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !answer.isEmpty, raw != lastSpellingAttempt?.answer else { return false }

        let kind: SpellingAttempt.Kind = spellingState == .awaitingFirst ? .first : .correction
        let encounter = lastSpellingAttempt?.encounter ?? spellingAttempts.count { $0.word == word && $0.kind == .first } + 1
        let correct = answer.caseInsensitiveCompare(word.spelling) == .orderedSame
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
        return true
    }

    @discardableResult
    mutating func advanceSpelling() -> Bool {
        guard phase == .spelling, spellingState == .readyToAdvance,
              let attempt = lastSpellingAttempt else { return false }
        queue.removeFirst()
        if fullBatchSpelling == true {
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
