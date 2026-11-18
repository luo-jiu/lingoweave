import Foundation

/// AI inputs are stable references. Node reads and validates the saved facts.
enum MiniDailyAI {
    static func preparationKind(for day: MiniDailyDay) -> MiniAIJob.Kind? {
        guard !day.paused, day.phase != .finished, day.writingRequired != false else { return nil }
        if day.flow != nil, day.phase == .translation, day.currentTranslation == nil { return .writing }
        if !day.wordsToPrepare.isEmpty { return .prepare }
        if day.phase == .translation, day.currentTranslation == nil { return .writing }
        return nil
    }
}
