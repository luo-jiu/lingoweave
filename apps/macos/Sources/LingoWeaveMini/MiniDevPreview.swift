#if DEBUG
import Foundation
import SwiftUI

enum MiniDevStage: String, CaseIterable, Identifiable {
    case live = "正常流程"
    case home = "首页"
    case reviewJudgment = "复习 · 判断"
    case reviewRevealed = "复习 · 揭晓释义"
    case reviewSpelling = "复习 · 拼写"
    case reviewCorrection = "复习 · 拼写订正"
    case reviewFinished = "复习 · 完成"
    case learningPreparing = "新词 · 备课中"
    case learningError = "新词 · 备课失败"
    case learning = "新词 · 初见记忆"
    case learningContext = "新词 · 语境回忆"
    case learningMeaning = "新词 · 词义回忆"
    case learningSpelling = "新词 · 总拼写"
    case learningCorrection = "新词 · 拼写订正"
    case learningFinished = "新词 · 完成"
    case englishToChinese = "翻译 · 英译中"
    case chineseToEnglish = "翻译 · 中译英"
    case translationGrading = "翻译 · 批改中"
    case translationError = "翻译 · 批改失败"
    case translationFeedback = "翻译 · 反馈"
    case paused = "任务暂停"
    case finished = "任务完成"
    case browsing = "浏览词表"
    case editing = "编辑词表"
    case chat = "AI 聊天"

    var id: String { rawValue }
    var isPreview: Bool { self != .live }
}

struct MiniDevMenu: View {
    let stage: MiniDevStage
    let select: (MiniDevStage) -> Void

    var body: some View {
        Menu("dev") {
            ForEach(MiniDevStage.allCases) { item in
                Toggle(item.rawValue, isOn: Binding(
                    get: { stage == item },
                    set: { selected in if selected { select(item) } }
                ))
                .accessibilityIdentifier("devStage:" + item.id)
            }
            Divider()
            Button("重置预览") { select(stage) }
                .disabled(!stage.isPreview)
        }
        .accessibilityIdentifier("devStageMenu")
    }
}

/// Debug fixtures never write to storage. v2 previews display fixed snapshots;
/// only the server runs the actual interleaved queue.
struct MiniDevPreview {
    let ledger: MiniDailyLedger
    let day: MiniDailyDay

    static func make(_ stage: MiniDevStage, now: Date = .now, calendar: Calendar = .current) -> Self {
        let legacy = makeLegacy(stage, now: now, calendar: calendar)
        let windowStages: Set<MiniDevStage> = [.learningPreparing, .learningError, .learning, .learningContext, .learningMeaning, .paused]
        let spellingStages: Set<MiniDevStage> = [.learningSpelling, .learningCorrection, .learningFinished]
        guard windowStages.contains(stage) || spellingStages.contains(stage) else { return legacy }
        var day = legacy.day
        let level = stage == .learningContext ? 1 : (stage == .learningMeaning ? 2 : 0)
        let words = day.learningWords
        let visit = windowStages.contains(stage) ? words.first.map {
            MiniMemoryWindow.Visit(id: UUID(), word: $0, stage: level, openedAt: now, initial: nil,
                                   selectedAt: nil, revealedAt: nil, correctedAt: nil, draft: "")
        } : nil
        let window = MiniMemoryWindow(version: "interleaved-v2", size: 5, gap: 3,
                                      members: words.map { .init(word: $0, stage: level, admittedAt: now, lastVisit: nil) },
                                      visit: visit, events: [], sequence: 0, forceUnseen: false)
        day.flow = MiniLearningFlow(version: "sliding-window-v2", targetDate: String(day.id.prefix(10)), dailyNewGoal: 3,
                                    completedBeforeRun: 0, groupSize: 3, candidates: words, candidateIndex: words.count,
                                    window: window, groupId: UUID(), groupIndex: 1, groupStartedAt: now, groupTarget: 3,
                                    groupWords: visit == nil ? words : [], translationWords: visit == nil ? words : [],
                                    groups: [], completed: [], goalReached: false)
        day.memory = nil
        if visit != nil { day.learning = nil }
        else if let learning = day.learning { day.learning = windowSpellingFixture(learning) }
        var ledger = legacy.ledger
        ledger.days[ledger.days.count - 1] = day
        return Self(ledger: ledger, day: day)
    }

    private static func windowSpellingFixture(_ session: MiniReviewSession) -> MiniReviewSession {
        do {
            let encoded = try JSONEncoder().encode(session)
            guard var object = try JSONSerialization.jsonObject(with: encoded) as? [String: Any] else {
                preconditionFailure("Invalid spelling preview fixture")
            }
            object["spellingPolicy"] = "retry-errors-v2"
            return try JSONDecoder().decode(MiniReviewSession.self, from: JSONSerialization.data(withJSONObject: object))
        } catch { preconditionFailure("Invalid spelling preview fixture: \(error)") }
    }

    /// Preview-only reveal/correction. This neither completes a visit nor computes a queue.
    static func editVisit(_ day: inout MiniDailyDay, choice: Bool? = nil, corrected: Bool = false,
                          draft: String? = nil, now: Date = .now) -> Bool {
        guard let flow = day.flow, let visit = flow.window.visit else { return false }
        let replacement = MiniMemoryWindow.Visit(id: visit.id, word: visit.word, stage: visit.stage, openedAt: visit.openedAt,
                                                initial: choice ?? visit.initial,
                                                selectedAt: choice == nil ? visit.selectedAt : now,
                                                revealedAt: choice == nil ? visit.revealedAt : now,
                                                correctedAt: corrected ? now : visit.correctedAt, draft: draft ?? visit.draft)
        let old = flow.window
        let window = MiniMemoryWindow(version: old.version, size: old.size, gap: old.gap, members: old.members,
                                      visit: replacement, events: old.events, sequence: old.sequence, forceUnseen: old.forceUnseen)
        day.flow = MiniLearningFlow(version: flow.version, targetDate: flow.targetDate, dailyNewGoal: flow.dailyNewGoal,
                                    completedBeforeRun: flow.completedBeforeRun, groupSize: flow.groupSize,
                                    candidates: flow.candidates, candidateIndex: flow.candidateIndex, window: window,
                                    groupId: flow.groupId, groupIndex: flow.groupIndex, groupStartedAt: flow.groupStartedAt,
                                    groupTarget: flow.groupTarget, groupWords: flow.groupWords, translationWords: flow.translationWords,
                                    groups: flow.groups, completed: flow.completed, goalReached: flow.goalReached)
        return true
    }

    static func makeLegacy(_ stage: MiniDevStage, now: Date = .now, calendar: Calendar = .current) -> Self {
        let seedTime = calendar.date(byAdding: .day, value: -3, to: now) ?? now.addingTimeInterval(-259_200)
        let deck = Array(MiniWord.starter.prefix(6))
        var ledger = MiniDailyLedger()
        var seedDeck = Array(deck.prefix(3))
        // The next encounter reverses direction; seed apple with Chinese so it opens in English.
        seedDeck.swapAt(0, 1)
        var seed = ledger.beginOrResume(deck: seedDeck, at: seedTime, calendar: calendar, memoryRounds: true)
        prepare(&seed)
        finishLearning(&seed, at: seedTime, calendar: calendar)
        finishTranslations(&seed, at: seedTime, calendar: calendar)
        ledger.days[0] = seed

        var day = ledger.beginOrResume(deck: deck, at: now, calendar: calendar, memoryRounds: true)
        if stage != .learningPreparing && stage != .learningError { prepare(&day) }

        switch stage {
        case .live, .home, .reviewJudgment, .browsing, .editing, .chat:
            break
        case .reviewRevealed:
            day.review?.chooseJudgment(.fuzzy, at: now)
        case .reviewSpelling, .reviewCorrection, .reviewFinished:
            if var review = day.review {
                finishJudgment(&review, at: now)
                if stage == .reviewCorrection { review.submitSpelling("aple", at: now) }
                if stage == .reviewFinished { finishSpelling(&review, at: now) }
                day.review = review
            }
        default:
            finishReview(&day, at: now, calendar: calendar)
            switch stage {
            case .learningPreparing, .learningError, .learning:
                break
            case .learningContext, .learningMeaning:
                let target = stage == .learningContext ? 2 : 3
                while let memory = day.memory, memory.round < target { day.advanceMemory(remembered: true, at: now) }
            case .learningSpelling, .learningCorrection, .learningFinished:
                studyAll(&day, at: now)
                if stage == .learningCorrection { day.learning?.submitSpelling("raed", at: now) }
                if stage == .learningFinished, var learning = day.learning {
                    finishSpelling(&learning, at: now)
                    day.learning = learning
                }
            case .paused:
                day.setPaused(true, at: now)
            default:
                finishLearning(&day, at: now, calendar: calendar)
                switch stage {
                case .chineseToEnglish:
                    gradeCurrent(&day, at: now, calendar: calendar)
                    day.advanceTranslation(at: now)
                case .translationGrading, .translationError, .translationFeedback:
                    day.submitTranslation("她在午饭后吃了一个苹果。", at: now)
                    if stage == .translationFeedback, let attempt = day.currentAttempt {
                        day.gradeTranslation(id: attempt.id, feedback: sampleFeedback, at: now, calendar: calendar)
                    }
                case .finished:
                    finishTranslations(&day, at: now, calendar: calendar)
                default:
                    break
                }
            }
        }

        ledger.days[ledger.days.count - 1] = day
        return Self(ledger: ledger, day: day)
    }

    static func sentences(for words: [MiniWord]) -> [MiniStudySentence] {
        let examples: [String: (String, String)] = [
            "apple": ("She eats an apple after lunch.", "她午饭后吃一个苹果。"),
            "book": ("This book tells a story about a small town.", "这本书讲述了一个小镇的故事。"),
            "water": ("Please drink some water before you leave.", "请在离开前喝点水。"),
            "read": ("I read a few pages before bed.", "我睡前读几页书。"),
            "write": ("Can you write your name on this card?", "你能在这张卡片上写下你的名字吗？"),
            "house": ("Their house is near the park.", "他们的房子在公园附近。"),
        ]
        return words.compactMap { word in
            guard let example = examples[word.spelling] else { return nil }
            return MiniStudySentence(word: word, english: example.0, chinese: example.1)
        }
    }

    static let sampleFeedback = MiniTranslationFeedback(
        outcome: .partial,
        comment: "开发预览示例：这里展示批改后的反馈布局，不代表真实 AI 批改。",
        tip: "留意原句的时态，例如 eats 表示一般现在时。",
        usefulPhrase: "after lunch · 午饭后"
    )

    private static let seedFeedback = MiniTranslationFeedback(outcome: .correct, comment: "开发示例", tip: "", usefulPhrase: "")

    private static func prepare(_ day: inout MiniDailyDay) {
        day.addSentences(sentences(for: day.wordsToPrepare))
    }

    private static func finishJudgment(_ session: inout MiniReviewSession, at time: Date) {
        while session.phase == .judgment {
            if session.currentJudgment == nil { session.chooseJudgment(.clear, at: time) }
            session.advanceJudgment(at: time)
        }
    }

    private static func finishSpelling(_ session: inout MiniReviewSession, at time: Date) {
        while let word = session.currentWord, session.phase == .spelling {
            session.submitSpelling(word.spelling, at: time)
            session.advanceSpelling()
        }
    }

    private static func finishReview(_ day: inout MiniDailyDay, at time: Date, calendar: Calendar) {
        if var review = day.review {
            finishJudgment(&review, at: time)
            finishSpelling(&review, at: time)
            day.review = review
        }
        day.completeReview(at: time, calendar: calendar)
    }

    private static func studyAll(_ day: inout MiniDailyDay, at time: Date) {
        while let word = day.nextUnstudiedWord {
            guard day.markStudied(word, at: time) else { break }
        }
    }

    private static func finishLearning(_ day: inout MiniDailyDay, at time: Date, calendar: Calendar) {
        studyAll(&day, at: time)
        if var learning = day.learning {
            finishSpelling(&learning, at: time)
            day.learning = learning
        }
        day.completeLearning(at: time, calendar: calendar)
    }

    private static func gradeCurrent(_ day: inout MiniDailyDay, at time: Date, calendar: Calendar) {
        guard let task = day.currentTranslation,
              let id = day.submitTranslation(task.reference, at: time) else { return }
        day.gradeTranslation(id: id, feedback: seedFeedback, at: time, calendar: calendar)
    }

    private static func finishTranslations(_ day: inout MiniDailyDay, at time: Date, calendar: Calendar) {
        while day.currentTranslation != nil {
            gradeCurrent(&day, at: time, calendar: calendar)
            guard day.advanceTranslation(at: time) else { break }
        }
    }
}
#endif
