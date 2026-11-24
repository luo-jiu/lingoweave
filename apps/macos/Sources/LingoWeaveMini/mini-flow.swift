import Foundation

struct MiniDailyWordKey: Hashable {
    let spelling: String
    let meaning: String

    init(_ word: MiniWord) {
        spelling = word.spelling.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        meaning = word.meaning.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// The acknowledged window and its transient presentation use the same selection rules.
struct MiniMemoryWindow: Codable, Equatable, Sendable {
    struct Member: Codable, Equatable, Sendable {
        let word: MiniWord
        var stage: Int
        let admittedAt: Date
        var lastVisit: Int?
    }
    struct Visit: Codable, Equatable, Sendable, Identifiable {
        let id: UUID
        let word: MiniWord
        let stage: Int
        let openedAt: Date
        var initial: Bool?
        var selectedAt: Date?
        var revealedAt: Date?
        var correctedAt: Date?
        var draft: String

        var showsFullCard: Bool { stage == 0 || revealedAt != nil }
        var awaitingConfirmation: Bool { stage > 0 && initial != nil }
        var canCorrect: Bool { initial == true && correctedAt == nil }
        var willRemember: Bool { initial == true && correctedAt == nil }
        var advancesAutomatically: Bool { (stage == 0 && initial == true) || correctedAt != nil }
        var completedStages: Int {
            guard initial != nil else { return stage }
            return willRemember ? stage + 1 : 0
        }
    }
    struct Event: Codable, Equatable, Sendable, Identifiable {
        let id: UUID
        let word: MiniWord
        let stage: Int
        let openedAt: Date
        let initial: Bool?
        let selectedAt: Date?
        let revealedAt: Date?
        let correctedAt: Date?
        let draft: String
        let remembered: Bool
        var selfReportedFamiliar: Bool? = nil
        let confirmedAt: Date
        let sequence: Int
    }
    let version: String
    let size: Int
    let gap: Int
    var members: [Member]
    var visit: Visit?
    var events: [Event]
    var sequence: Int
    var forceUnseen: Bool
    mutating func admit(_ word: MiniWord, at: Date) {
        members.append(.init(word: word, stage: 0, admittedAt: at, lastVisit: nil))
    }

    mutating func finish(remembered: Bool?, markWrong: Bool, familiar: Bool, draft: String?, at: Date) -> Event? {
        guard var current = visit,
              let index = members.firstIndex(where: { MiniDailyWordKey($0.word) == MiniDailyWordKey(current.word) }) else { return nil }
        if markWrong {
            guard current.stage > 0, current.canCorrect, remembered == nil else { return nil }
            current.correctedAt = at
        }
        if current.stage == 0 && current.initial == nil {
            guard let answer = familiar ? true : remembered else { return nil }
            current.initial = answer
            current.selectedAt = at
            current.revealedAt = at
        } else if remembered != nil { return nil }
        guard current.initial != nil, current.selectedAt != nil else { return nil }
        sequence += 1
        let event = Event(id: current.id, word: current.word, stage: current.stage, openedAt: current.openedAt,
                          initial: current.initial, selectedAt: current.selectedAt, revealedAt: current.revealedAt,
                          correctedAt: current.correctedAt, draft: draft ?? current.draft, remembered: current.willRemember,
                          selfReportedFamiliar: familiar ? true : nil, confirmedAt: at, sequence: sequence)
        events.append(event)
        visit = nil
        if familiar || (current.stage == 2 && event.remembered) {
            members.remove(at: index)
        } else {
            members[index].lastVisit = sequence
            members[index].stage = event.remembered ? current.stage + 1 : 0
        }
        if !event.remembered { forceUnseen = true }
        return event
    }

    mutating func selectNext(id: UUID, preferred: MiniWord?, at: Date) {
        guard visit == nil, !members.isEmpty else { return }
        let unseen = members.first { $0.lastVisit == nil }
        let byAge = members.sorted { ($0.lastVisit ?? 0) < ($1.lastVisit ?? 0) }
        let eligible = byAge.first { member in
            guard let last = member.lastVisit else { return false }
            let required = min(gap, members.count - 1)
            if required == 0 { return true }
            let key = MiniDailyWordKey(member.word)
            var others = Set<MiniDailyWordKey>()
            for event in events.reversed() {
                if event.sequence <= last { break }
                let other = MiniDailyWordKey(event.word)
                if other != key { others.insert(other) }
                if others.count >= required { return true }
            }
            return false
        }
        let preferredMember = preferred.flatMap { word in members.first { MiniDailyWordKey($0.word) == MiniDailyWordKey(word) } }
        guard let selected = preferredMember ?? (forceUnseen ? unseen : nil) ?? eligible ?? unseen ?? byAge.first else { return }
        forceUnseen = selected.lastVisit != nil && unseen != nil
        visit = Visit(id: id, word: selected.word, stage: selected.stage, openedAt: at,
                      initial: nil, selectedAt: nil, revealedAt: nil, correctedAt: nil, draft: "")
    }

}

struct MiniLearningFlow: Codable, Equatable, Sendable {
    struct Group: Codable, Equatable, Sendable, Identifiable {
        let id: UUID
        let index: Int
        let words: [MiniWord]
        let startedAt: Date
        let finishedAt: Date
        let spelling: MiniReviewSession
        let translationAttemptIds: [UUID]
    }
    struct Completion: Codable, Equatable, Sendable {
        let word: MiniWord
        let attemptId: UUID
        let at: Date
        let date: String
    }
    let version: String
    let targetDate: String
    let dailyNewGoal: Int
    let completedBeforeRun: Int
    let groupSize: Int
    let candidates: [MiniWord]
    var candidateIndex: Int
    var window: MiniMemoryWindow
    let groupId: UUID
    let groupIndex: Int
    let groupStartedAt: Date
    let groupTarget: Int
    var groupWords: [MiniWord]
    var translationWords: [MiniWord]
    let groups: [Group]
    let completed: [Completion]
    let goalReached: Bool
}
