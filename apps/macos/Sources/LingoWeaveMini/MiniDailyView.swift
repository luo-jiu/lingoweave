import AppKit
import SwiftUI

struct MiniDailyView: View {
    @Binding var day: MiniDailyDay
    var preparing: Bool
    var preparationError: String?
    var grading: Bool
    var gradingError: String?
    var retryPreparation: () -> Void
    var gradeTranslation: () -> Void
    var continueToday: (() -> Void)?

    var body: some View {
        Group {
            if day.paused {
                VStack(spacing: 9) {
                    Text("今日任务已暂停").font(.headline)
                    Button("继续今日任务") {
                        var next = day
                        if next.setPaused(false) { day = next }
                    }
                }
            } else {
                switch day.phase {
                case .review: review
                case .learning: learning
                case .translation: translation
                case .finished: summary
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder
    private var review: some View {
        if let session = day.review {
            MiniReviewView(
                session: Binding(
                    get: { day.review ?? session },
                    set: { day.review = $0 }
                ),
                onFinish: { completeReview() },
                finishLabel: day.learningWords.isEmpty ? "开始写句子" : "开始学习",
                sentenceForWord: { word in
                    guard let sentence = sentence(for: word) else { return nil }
                    return (sentence.english, sentence.chinese)
                }
            )
        }
    }

    @ViewBuilder
    private var learning: some View {
        if let word = day.nextUnstudiedWord {
            if let sentence = sentence(for: word) {
                wordStudy(word, sentence: sentence)
            } else {
                preparationStatus("正在准备新词例句…", idleTitle: "新词例句待准备")
            }
        } else if let session = day.learning {
            MiniReviewView(
                session: Binding(
                    get: { day.learning ?? session },
                    set: { day.learning = $0 }
                ),
                onFinish: { completeLearning() },
                finishTitle: "新词拼写完成",
                finishLabel: "开始写句子"
            )
        }
    }

    private func wordStudy(_ word: MiniWord, sentence: MiniStudySentence) -> some View {
        VStack(spacing: 8) {
            if let index = day.learningWords.firstIndex(of: word) {
                Text("\(index + 1) / \(day.learningWords.count)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("新词第 \(index + 1) 个，共 \(day.learningWords.count) 个")
            }

            GeometryReader { area in
                ScrollView {
                    VStack(spacing: 5) {
                        Text(word.spelling)
                            .font(.system(size: 34, weight: .semibold, design: .serif))
                            .accessibilityIdentifier("learningEnglish")
                        if !word.phonetic.isEmpty {
                            Text(word.phonetic).font(.caption).foregroundStyle(.secondary)
                        }
                        Text(word.meaning)
                        VStack(spacing: 3) {
                            Text(sentence.english).font(.callout)
                            Text(sentence.chinese).font(.caption).foregroundStyle(.secondary)
                            Text("原创例句").font(.caption2).foregroundStyle(.secondary)
                        }
                        .padding(.top, 4)
                        .accessibilityIdentifier("studyExample")
                    }
                    .textSelection(.enabled)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 4)
                    .frame(maxWidth: .infinity, minHeight: area.size.height)
                }
            }

            Button("记住了") {
                var next = day
                if next.markStudied(word) { day = next }
            }
        }
        .padding(.vertical, 2)
    }

    @ViewBuilder
    private var translation: some View {
        if let task = day.currentTranslation {
            let attempt = day.currentAttempt
            VStack(alignment: .leading, spacing: 8) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 7) {
                        translationPrompt(task)
                        if let attempt {
                            translationResult(task, attempt: attempt)
                        } else {
                            TextEditor(text: $day.translationDraft)
                                .font(.body)
                                .scrollContentBackground(.hidden)
                                .frame(height: 66)
                                .padding(3)
                                .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 5))
                                .overlay {
                                    RoundedRectangle(cornerRadius: 5)
                                        .strokeBorder(Color(nsColor: .separatorColor))
                                        .allowsHitTesting(false)
                                }
                                .accessibilityLabel("输入译文")
                                .accessibilityIdentifier("dailyTranslationDraft")
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }

                translationControls(attempt)
                    .frame(maxWidth: .infinity, alignment: .trailing)
            }
            .padding(.vertical, 2)
            .id(task.id)
        } else {
            preparationStatus("正在准备翻译练习…", idleTitle: "翻译题待准备")
        }
    }

    private func translationPrompt(_ task: MiniTranslationTask) -> some View {
        let direction = task.direction == .englishToChinese ? "英译中" : "中译英"
        return VStack(alignment: .leading, spacing: 4) {
            Text("第 \(day.translationIndex + 1) / \(day.translationCount) 题 · \(direction)")
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(task.prompt)
                .font(.headline)
                .textSelection(.enabled)
                .accessibilityIdentifier("dailyTranslationPrompt")
        }
    }

    private func translationResult(_ task: MiniTranslationTask, attempt: MiniTranslationAttempt) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            labeledText("你的译文", attempt.answer)
            if let feedback = attempt.feedback {
                labeledText(outcomeLabel(feedback), feedback.comment)
                labeledText("参考译文", task.reference)
                if !feedback.tip.isEmpty { labeledText("用法提示", feedback.tip) }
                if !feedback.usefulPhrase.isEmpty { labeledText("可复用短语", feedback.usefulPhrase) }
            } else if let gradingError {
                Text(gradingError).font(.caption).foregroundStyle(.secondary)
            }
        }
        .textSelection(.enabled)
    }

    @ViewBuilder
    private func translationControls(_ attempt: MiniTranslationAttempt?) -> some View {
        if attempt?.feedback != nil {
            Button("继续") {
                var next = day
                if next.advanceTranslation() { day = next }
            }
        } else if grading {
            ProgressView("正在批改…").controlSize(.small)
        } else if attempt != nil {
            Button(gradingError == nil ? "批改译文" : "重试批改", action: gradeTranslation)
        } else {
            Button("提交译文", action: submitTranslation)
                .disabled(day.translationDraft.count > 4_000
                          || day.translationDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
    }

    private func preparationStatus(_ pendingTitle: String, idleTitle: String) -> some View {
        VStack(spacing: 8) {
            if preparing {
                ProgressView(pendingTitle).controlSize(.small)
            } else {
                Text(preparationError ?? idleTitle)
                    .font(.callout)
                    .multilineTextAlignment(.center)
                Button(preparationError == nil ? "准备材料" : "重新准备", action: retryPreparation)
            }
        }
        .padding(8)
    }

    private var summary: some View {
        VStack(spacing: 8) {
            if day.reviewWords.isEmpty && day.learningWords.isEmpty {
                Text("今天没有待学或待复习的词").font(.headline)
            } else {
                Text(continueToday == nil ? "今日任务已完成" : "\(day.id) 的任务已完成").font(.headline)
                Text("复习 \(day.reviewWords.count) 词 · 学习 \(day.learningWords.count) 词 · 翻译 \(day.translation.count) 题")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            if let continueToday { Button("开始今天的任务", action: continueToday) }
        }
    }

    private func labeledText(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
            Text(value).font(.callout)
        }
    }

    private func outcomeLabel(_ feedback: MiniTranslationFeedback) -> String {
        switch feedback.outcome {
        case .correct: "AI 批改 · 正确"
        case .partial: "AI 批改 · 部分正确"
        case .incorrect: "AI 批改 · 需要修改"
        }
    }

    private func sentence(for word: MiniWord) -> MiniStudySentence? {
        day.sentences.first { $0.word == word }
    }

    private func completeReview() {
        var next = day
        if next.completeReview() { day = next }
    }

    private func completeLearning() {
        var next = day
        if next.completeLearning() { day = next }
    }

    private func submitTranslation() {
        var next = day
        guard next.submitTranslation(next.translationDraft) != nil else { return }
        day = next
        gradeTranslation()
    }
}
