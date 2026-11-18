import AppKit
import SwiftUI

struct MiniMemoryCommands {
    let draft: Binding<String>
    let advance: (Bool) -> Void
    let reveal: () -> Void
    let saveDraft: () -> Void
    let undo: () -> Void
}

struct MiniDailyCommands {
    let review: MiniReviewCommands
    let learning: MiniReviewCommands
    let translationDraft: Binding<String>
    let resume: () -> Void
    let markStudied: (MiniWord) -> Void
    let completeReview: () -> Void
    let completeLearning: () -> Void
    let submitTranslation: (String) -> Void
    let advanceTranslation: () -> Void
    var memory: MiniMemoryCommands? = nil
    var window: MiniWindowCommands? = nil
    var openDictation: ((MiniWord) -> Void)? = nil
    var unmarkStudied: ((MiniWord) -> Void)? = nil
    var advanceLearningCard: ((MiniWord) -> Void)? = nil
}

struct MiniDailyView: View {
    @Binding var day: MiniDailyDay
    var preparing: Bool
    var preparationError: String?
    var grading: Bool
    var gradingError: String?
    var retryPreparation: () -> Void
    var gradeTranslation: () -> Void
    var continueToday: (() -> Void)?
    var commands: MiniDailyCommands? = nil
    var saving = false
    var pauseMessage: String? = nil
    var resumeLabel = "继续任务"
    var canResume = true
    var openPlan: (() -> Void)? = nil
    var aiProgress: String? = nil
    var aiReceipt: String? = nil
    var cancelAI: (() -> Void)? = nil
    var lessonPreparation: MiniLessonPreparation? = nil
    var retryLessonPreparation: (() -> Void)? = nil
    var continueWithText: (() -> Void)? = nil
    var playWord: (MiniWord) -> Void = { _ in }
    var playSentence: (MiniStudySentence) -> Void = { _ in }
    var playSpellingResult: (MiniWord) -> Void = { _ in }
    var savedSentence: ((MiniWord) -> MiniStudySentence?)? = nil
    var previewWindow: MiniWindowCommands? = nil
    var previewLearningSpelling: MiniReviewCommands? = nil
    var previewAdvanceTranslation: (() -> Void)? = nil

    private var windowCommands: MiniWindowCommands? { commands?.window ?? previewWindow }

    private var translationDraft: Binding<String> { commands?.translationDraft ?? $day.translationDraft }
    private var showingLessonPreparation: Bool {
        day.phase == .learning && !day.paused && day.nextUnstudiedWord != nil
            && lessonPreparation?.isReady == false
    }

    var body: some View {
        Group {
            if day.phase == .finished {
                summary
            } else if day.paused {
                VStack(spacing: 9) {
                    Text(day.flow?.goalReached == true ? "今日新词目标已完成" : "学习已暂停").font(.headline)
                    if let pauseMessage {
                        Text(pauseMessage).font(.caption).foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }
                    if canResume {
                        Button(resumeLabel) {
                            if let commands { commands.resume(); return }
                            var next = day
                            if next.setPaused(false) { day = next }
                        }
                    } else if let openPlan {
                        Button("调整学习计划", action: openPlan)
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
        .disabled(saving)
    }

    @ViewBuilder
    private var review: some View {
        if let window = day.memoryWindow, let visit = window.visit {
            windowCard(visit, sentence: sentence(for: visit.word))
        } else if let session = day.review {
            MiniReviewView(
                session: Binding(
                    get: { day.review ?? session },
                    set: { day.review = $0 }
                ),
                onFinish: { completeReview() },
                finishLabel: day.writingRequired == false ? "完成复习" : (day.learningWords.isEmpty ? "开始写句子" : "开始学习"),
                sentenceForWord: { word in
                    guard let sentence = sentence(for: word) else { return nil }
                    return sentence
                },
                playWord: playWord,
                playSentence: playSentence,
                playSpellingResult: playSpellingResult,
                commands: commands?.review,
                saving: saving
            )
        }
    }

    @ViewBuilder
    private var learning: some View {
        if let word = day.retainedLearningWord ?? day.nextUnstudiedWord {
            if let lessonPreparation, !lessonPreparation.isReady {
                MiniLessonPreparationView(preparation: lessonPreparation,
                                          retry: retryLessonPreparation,
                                          continueWithText: continueWithText)
            } else if let sentence = sentence(for: word) {
                if let visit = day.memoryWindow?.visit { windowCard(visit, sentence: sentence) }
                else if let memory = day.memory { memoryCard(word, sentence: sentence, memory: memory) }
                else { wordStudy(word, sentence: sentence) }
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
                finishLabel: "开始写句子",
                playWord: playWord,
                playSentence: playSentence,
                playSpellingResult: playSpellingResult,
                commands: commands?.learning ?? previewLearningSpelling,
                saving: saving
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
                            .onTapGesture { playWord(word) }
                            .accessibilityAddTraits(.isButton)
                        if !word.phonetic.isEmpty {
                            Text(word.phonetic).font(.caption).foregroundStyle(.secondary)
                        }
                        Text(word.meaning)
                        VStack(spacing: 3) {
                            Text(sentence.english).font(.callout)
                                .onTapGesture { playSentence(sentence) }
                                .accessibilityAddTraits(.isButton)
                            Text(sentence.attributedTranslation).font(.caption).foregroundStyle(.secondary)

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

            if day.retainedLearningWord == word {
                HStack(spacing: 8) {
                    if let unmark = commands?.unmarkStudied { Button("撤销记住") { unmark(word) } }
                    if let advance = commands?.advanceLearningCard { Button("下一个") { advance(word) } }
                }
                .font(.caption)
            } else {
                Button("记住了") {
                    if let commands { commands.markStudied(word); return }
                    var next = day
                    if next.markStudied(word) { day = next }
                }
            }
        }
        .padding(.vertical, 2)
    }

    private func memoryCard(_ word: MiniWord, sentence: MiniStudySentence, memory: MiniMemoryRounds) -> some View {
        VStack(spacing: 8) {
            HStack(spacing: 7) {
                ForEach(1...3, id: \.self) { round in
                    Circle()
                        .fill(round <= memory.completedRounds(for: word) ? Color.green : Color.clear)
                        .overlay { Circle().stroke(round <= memory.completedRounds(for: word) ? Color.green : Color.secondary, lineWidth: 1.4) }
                        .frame(width: 9, height: 9)
                        .accessibilityLabel(["初见记忆", "语境回忆", "词义回忆"][round - 1])
                        .accessibilityValue(round <= memory.completedRounds(for: word) ? "已完成" : (round == memory.round ? "当前轮" : "待完成"))
                }
            }
            .accessibilityIdentifier("memoryRoundDots")
            GeometryReader { area in
                ScrollView {
                    VStack(spacing: 7) {
                        if memory.round != 2 || memory.revealed {
                            Text(word.spelling)
                                .font(.system(size: 34, weight: .semibold, design: .serif))
                                .accessibilityIdentifier("learningEnglish")
                                .onTapGesture { playWord(word) }
                                .accessibilityAddTraits(.isButton)
                        }
                        if memory.round == 1 || memory.revealed {
                            if !word.phonetic.isEmpty { Text(word.phonetic).font(.caption).foregroundStyle(.secondary) }
                            Text(word.meaning).accessibilityIdentifier("memoryMeaning")
                        }
                        if memory.round < 3 || memory.revealed {
                            memoryExample(sentence)
                                .accessibilityIdentifier("memoryExample")
                        }
                        if memory.round == 1 || memory.revealed {
                            Text(sentence.attributedTranslation).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity, minHeight: area.size.height)
                    .padding(.horizontal, 4)
                }
            }
            HStack(spacing: 10) {
                if memory.round == 1 {
                    Button("记住了") { advanceMemory(true) }
                } else {
                    if !memory.revealed { Button("展开") { revealMemory() } }
                    else { Button("再看一次") { advanceMemory(false) } }
                    Button(memory.round == 3 ? "待拼写" : "想起来了") { advanceMemory(true) }
                }
            }
        }
        .accessibilityIdentifier("memoryRoundCard")
    }

    private func windowCard(_ visit: MiniMemoryWindow.Visit, sentence: MiniStudySentence?) -> some View {
        VStack(spacing: 8) {
            HStack(spacing: 7) {
                ForEach(0..<3, id: \.self) { stage in
                    Circle()
                        .fill(stage < visit.completedStages ? Color.green : Color.clear)
                        .overlay { Circle().stroke(stage < visit.completedStages ? Color.green : Color.secondary, lineWidth: 1.4) }
                        .frame(width: 9, height: 9)
                        .accessibilityLabel(["初见记忆", "语境回忆", "词义回忆"][stage])
                        .accessibilityValue(stage < visit.completedStages ? "已完成" : (stage == visit.stage && visit.initial == nil ? "当前阶段" : "待完成"))
                }
                if day.phase == .learning, let flow = day.flow {
                    Spacer(minLength: 4)
                    Text("第 \(flow.groupIndex) 组 · \(flow.groupWords.count)/\(flow.groupTarget)")
                        .font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                }
            }
            .accessibilityIdentifier("memoryRoundDots")
            GeometryReader { area in
                ScrollView {
                    VStack(spacing: 7) {
                        if visit.stage != 1 || visit.showsFullCard {
                            Text(visit.word.spelling)
                                .font(.system(size: 34, weight: .semibold, design: .serif))
                                .accessibilityIdentifier("learningEnglish")
                                .onTapGesture { playWord(visit.word) }
                                .accessibilityAddTraits(.isButton)
                        }
                        if visit.showsFullCard {
                            if !visit.word.phonetic.isEmpty {
                                Text(visit.word.phonetic).font(.caption).foregroundStyle(.secondary)
                            }
                            Text(visit.word.meaning).accessibilityIdentifier("memoryMeaning")
                        }
                        if visit.stage == 1, !visit.showsFullCard, sentence == nil {
                            Text(visit.word.meaning).font(.headline)
                            Text("词义提示回忆（暂无例句）").font(.caption2).foregroundStyle(.secondary)
                        }
                        if visit.stage != 2 || visit.showsFullCard, let sentence {
                            memoryExample(sentence).accessibilityIdentifier("memoryExample")
                            if visit.showsFullCard {
                                Text(sentence.attributedTranslation).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity, minHeight: area.size.height)
                    .padding(.horizontal, 4)
                }
            }
            MiniWindowControls(visit: visit, saving: saving, commands: windowCommands)
        }
        .accessibilityIdentifier("memoryWindowCard")
    }

    private func memoryExample(_ sentence: MiniStudySentence) -> some View {
        var attributed = AttributedString(sentence.english)
        attributed.link = URL(string: "lingoweave-sentence://play")
        attributed.foregroundColor = .primary
        for target in sentence.highlightedRanges {
            guard let start = AttributedString.Index(target.lowerBound, within: attributed),
                  let end = AttributedString.Index(target.upperBound, within: attributed) else { continue }
            let range = start..<end
            attributed[range].link = URL(string: "lingoweave-word://play")
            attributed[range].foregroundColor = .accentColor
            attributed[range].font = .callout.bold()
        }
        return Text(attributed).font(.callout)
            .environment(\.openURL, OpenURLAction { url in
                if url.scheme == "lingoweave-word" { playWord(sentence.word) }
                else { playSentence(sentence) }
                return .handled
            })
            .accessibilityAddTraits(.isButton)
    }

    private func advanceMemory(_ remembered: Bool) {
        if let command = commands?.memory { command.advance(remembered) }
        else { day.advanceMemory(remembered: remembered) }
    }

    private func revealMemory() {
        if let command = commands?.memory { command.reveal() }
        else { day.revealMemory() }
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
                            TextEditor(text: translationDraft)
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
        let completedGroups = day.flow?.groups.reduce(0) { $0 + $1.words.count } ?? 0
        let index = day.translationIndex - completedGroups + 1
        let total = day.flow?.groupWords.count ?? day.translationCount
        let group = day.flow.map { "第 \($0.groupIndex) 组 · " } ?? ""
        return VStack(alignment: .leading, spacing: 4) {
            Text(group + "第 \(index) / \(total) 题 · \(direction)")
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
                labeledText("AI 反馈", feedback.comment)
                if let strengths = feedback.strengths, !strengths.isEmpty {
                    labeledText("做得好的地方", strengths.joined(separator: "\n"))
                }
                if let improvements = feedback.improvements, !improvements.isEmpty {
                    labeledText("可以改进", improvements.joined(separator: "\n"))
                }
                if let keyPoints = feedback.keyPoints, !keyPoints.isEmpty {
                    labeledText("重点", keyPoints.joined(separator: "\n"))
                }
                labeledText("参考译文", feedback.referenceTranslation ?? task.reference)
                if !feedback.tip.isEmpty { labeledText("用法提示", feedback.tip) }
                if !feedback.usefulPhrase.isEmpty { labeledText("可复用短语", feedback.usefulPhrase) }
            } else if day.flow == nil, let gradingError {
                Text(gradingError).font(.caption).foregroundStyle(.secondary)
            }
        }
        .textSelection(.enabled)
    }

    @ViewBuilder
    private func translationControls(_ attempt: MiniTranslationAttempt?) -> some View {
        if day.flow != nil || previewAdvanceTranslation != nil, attempt != nil {
            Button(day.translationIndex + 1 < day.translationCount ? "下一词" : "完成本组") {
                if let commands { commands.advanceTranslation() }
                else { previewAdvanceTranslation?() }
            }
            .accessibilityIdentifier("confirmTranslation")
        } else if attempt?.feedback != nil {
            Button("继续") {
                if let commands { commands.advanceTranslation(); return }
                var next = day
                if next.advanceTranslation() { day = next }
            }
        } else if grading {
            VStack(alignment: .trailing, spacing: 4) {
                ProgressView(aiProgress ?? "正在准备反馈…").controlSize(.small)
                if let cancelAI { Button("停止", action: cancelAI) }
            }
        } else if attempt != nil {
            Button(gradingError == nil ? "批改译文" : "重试批改", action: gradeTranslation)
        } else {
            Button("提交译文", action: submitTranslation)
                .disabled(translationDraft.wrappedValue.count > 4_000
                          || translationDraft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
    }

    private func preparationStatus(_ pendingTitle: String, idleTitle: String) -> some View {
        VStack(spacing: 8) {
            if preparing {
                ProgressView(aiProgress ?? pendingTitle).controlSize(.small)
                if let cancelAI { Button("停止", action: cancelAI).font(.caption) }
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

    private func sentence(for word: MiniWord) -> MiniStudySentence? {
        day.sentences.first { $0.word == word } ?? savedSentence?(word)
    }

    private func completeReview() {
        if let commands { commands.completeReview(); return }
        var next = day
        if next.completeReview() { day = next }
    }

    private func completeLearning() {
        if let commands { commands.completeLearning(); return }
        var next = day
        if next.completeLearning() { day = next }
    }

    private func submitTranslation() {
        if let commands { commands.submitTranslation(translationDraft.wrappedValue); return }
        var next = day
        guard next.submitTranslation(next.translationDraft) != nil else { return }
        day = next
        if previewAdvanceTranslation == nil { gradeTranslation() }
    }
}

private struct MiniLessonPreparationView: View {
    let preparation: MiniLessonPreparation
    let retry: (() -> Void)?
    let continueWithText: (() -> Void)?

    private var failureDetail: String? {
        preparation.steps.first { $0.status == .failed && $0.detail?.isEmpty == false }?.detail
    }

    var body: some View {
        GeometryReader { area in
            ScrollView {
                content.frame(minHeight: area.size.height)
            }
        }
        .accessibilityIdentifier("lessonPreparation")
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .firstTextBaseline) {
                Text("准备学习内容").font(.headline)
                Spacer(minLength: 8)
                Text("\(preparation.completedCount) / \(preparation.totalCount)")
                    .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                    .accessibilityLabel("已准备 \(preparation.completedCount) 项，共 \(preparation.totalCount) 项")
            }
            ProgressView(value: preparation.progress)
                .tint(.green)
                .accessibilityLabel("学习内容准备进度")
                .accessibilityIdentifier("lessonPreparationProgress")

            VStack(spacing: 0) {
                ForEach(preparation.steps) { step in
                    preparationRow(step, isLast: step.id == preparation.steps.last?.id)
                }
            }

            if let failureDetail {
                Text(failureDetail).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if preparation.hasFailure || !preparation.isRunning {
                HStack(spacing: 12) {
                    if let retry { Button("重新准备", action: retry) }
                    if let continueWithText { Button("先学文字", action: continueWithText) }
                }
                .font(.caption)
            }
        }
        .padding(.horizontal, 6)
        .frame(maxWidth: .infinity, alignment: .center)
    }

    private func preparationRow(_ step: MiniLessonPreparation.Step, isLast: Bool) -> some View {
        HStack(alignment: .top, spacing: 11) {
            VStack(spacing: 0) {
                stepIndicator(step.status)
                    .frame(width: 20, height: 20)
                if !isLast {
                    Rectangle()
                        .fill(step.status == .complete ? Color.green.opacity(0.65) : Color.secondary.opacity(0.25))
                        .frame(width: 1, height: 15)
                }
            }
            HStack(spacing: 8) {
                Text(step.title).font(.callout)
                    .foregroundStyle(step.status == .waiting ? .secondary : .primary)
                Spacer(minLength: 4)
                Text("\(step.completed) / \(step.total)")
                    .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                if step.status == .running {
                    ProgressView().controlSize(.mini).frame(width: 13, height: 13)
                }
            }
            .frame(height: 20)
        }
        .frame(minHeight: isLast ? 20 : 35, alignment: .top)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(step.title)，\(statusLabel(step.status))，\(step.completed) / \(step.total)")
        .accessibilityIdentifier("lessonPreparation-" + step.id.rawValue)
    }

    @ViewBuilder
    private func stepIndicator(_ status: MiniLessonPreparation.Step.Status) -> some View {
        switch status {
        case .complete:
            Image(systemName: "checkmark.circle.fill").font(.system(size: 19)).foregroundStyle(.green)
        case .failed:
            Image(systemName: "exclamationmark.circle").font(.system(size: 19)).foregroundStyle(.orange)
        case .running:
            Circle().strokeBorder(Color.accentColor, lineWidth: 2)
        case .waiting:
            Circle().strokeBorder(Color.secondary.opacity(0.4), lineWidth: 1.5)
        }
    }

    private func statusLabel(_ status: MiniLessonPreparation.Step.Status) -> String {
        switch status {
        case .waiting: "等待准备"
        case .running: "正在准备"
        case .complete: "已完成"
        case .failed: "准备中断"
        }
    }
}
