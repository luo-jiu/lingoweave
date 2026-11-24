import Foundation

/// AI inputs are stable references. Node reads and validates the saved facts.
enum MiniDailyAI {
    static func isConnectionFailure(_ error: Error) -> Bool {
        if let network = error as? URLError { return network.code != .cancelled }
        if case MiniStudyClientError.unavailable = error { return true }
        return false
    }

    static func readWithRetry<T: Sendable>(isolation: isolated (any Actor)? = #isolation,
                                           delays: [Duration] = [.seconds(1), .seconds(2), .seconds(4)],
                                           _ read: () async throws -> T) async throws -> T {
        var retries = 0
        while true {
            do { return try await read() }
            catch {
                guard !Task.isCancelled, retries < delays.count, isConnectionFailure(error) else { throw error }
                try await Task.sleep(for: delays[retries])
                retries += 1
            }
        }
    }

    static func preparationKind(for day: MiniDailyDay) -> MiniAIJob.Kind? {
        guard day.archivedAt == nil, !day.paused, day.phase != .finished, day.writingRequired != false else { return nil }
        if day.flow != nil, day.phase == .translation, day.currentTranslation == nil { return .writing }
        if !day.wordsToPrepare.isEmpty { return .prepare }
        if day.phase == .translation, day.currentTranslation == nil { return .writing }
        return nil
    }
}
