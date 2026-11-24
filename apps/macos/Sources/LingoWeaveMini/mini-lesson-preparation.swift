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
        var unit: String {
            switch id {
            case .words: return "词"
            case .examples: return "句"
            case .wordAudio, .sentenceAudio: return "条"
            }
        }

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
    let groupTarget: Int?

    init?(day: MiniDailyDay, preparingExamples: Bool, examplesFailed: Bool, examplesError: String?,
          audioItem: (MiniAudioTarget) -> MiniAudioPreparationItem) {
        let words = day.preparationWords
        guard !words.isEmpty, day.flow == nil || day.memoryWindow?.visit != nil else { return nil }
        groupTarget = day.flow?.groupTarget
        let examples = Dictionary(day.sentences.map { ($0.word, $0) }, uniquingKeysWith: { first, _ in first })
        let total = words.count
        let wordItems = words.map { audioItem(.word($0)) }
        let sentenceItems = words.compactMap { word in examples[word].map { audioItem(.sentence($0)) } }
        func audioStep(_ id: Step.ID, _ title: String, _ assets: [MiniAudioPreparationItem]) -> Step {
            let progress = MiniAudioPreparationProgress(items: assets)
            let status: Step.Status = progress.ready == total ? .complete : progress.failed > 0 ? .failed
                : progress.inProgress > 0 ? .running : .waiting
            return Step(id: id, title: title, status: status, completed: progress.ready, total: total, detail: progress.error)
        }
        let examplesStatus: Step.Status = sentenceItems.count == total ? .complete : preparingExamples ? .running
            : examplesFailed ? .failed : .waiting
        steps = [
            Step(id: .words, title: "备课单词", status: .complete, completed: total, total: total),
            Step(id: .examples, title: "生成例句", status: examplesStatus, completed: sentenceItems.count, total: total,
                 detail: examplesStatus == .failed ? (examplesError ?? "例句准备已停止，可以重试。") : nil),
            audioStep(.wordAudio, "单词音频", wordItems),
            audioStep(.sentenceAudio, "例句音频", sentenceItems)
        ]
    }

    var readyToStudy: Bool { steps.allSatisfy { $0.status == .complete } }
    var hasFailure: Bool { steps.contains { $0.status == .failed } }
    var isRunning: Bool { steps.contains { $0.status == .running } }
    var completedCount: Int { steps.reduce(0) { $0 + $1.completed } }
    var totalCount: Int { steps.reduce(0) { $0 + $1.total } }
    var progress: Double {
        guard totalCount > 0 else { return 0 }
        return Double(completedCount) / Double(totalCount)
    }
}
