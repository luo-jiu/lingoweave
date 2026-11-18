import Foundation

struct MiniLessonPreparation: Equatable, Sendable {
    struct Step: Identifiable, Equatable, Sendable {
        enum ID: String, Hashable, Sendable {
            case words, examples, wordAudio, sentenceAudio
        }

        enum Status: Equatable, Sendable {
            case waiting, running, complete, failed
        }

        let id: ID
        let title: String
        let status: Status
        let completed: Int
        let total: Int
        let detail: String?

        init(id: ID, title: String, status: Status, completed: Int, total: Int, detail: String? = nil) {
            self.id = id
            self.title = title
            self.total = max(0, total)
            self.completed = min(max(0, completed), self.total)
            self.status = self.total == 0 ? .complete : status
            self.detail = detail
        }
    }

    let steps: [Step]

    var isReady: Bool { steps.allSatisfy { $0.status == .complete } }
    var hasFailure: Bool { steps.contains { $0.status == .failed } }
    var isRunning: Bool { steps.contains { $0.status == .running } }
    var completedCount: Int { steps.reduce(0) { $0 + $1.completed } }
    var totalCount: Int { steps.reduce(0) { $0 + $1.total } }
    var progress: Double {
        guard totalCount > 0 else { return isReady ? 1 : 0 }
        return Double(completedCount) / Double(totalCount)
    }
}
