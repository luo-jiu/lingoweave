import AppKit
import SwiftUI

struct MiniMemoryCommands {
    let draft: Binding<String>
    let advance: (Bool) -> Void
    let reveal: () -> Void
    let saveDraft: () -> Void
    let undo: () -> Void
}

struct MiniTranslationNavigation {
    let index: Int
    let select: (Int) -> Void
    let revise: (String) -> Void
    let pendingEdit: Int?
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
    var translationNavigation: MiniTranslationNavigation? = nil
    var memory: MiniMemoryCommands? = nil
    var window: MiniWindowCommands? = nil
    var openDictation: ((MiniWord) -> Void)? = nil
    var unmarkStudied: ((MiniWord) -> Void)? = nil
    var advanceLearningCard: ((MiniWord) -> Void)? = nil
}

struct MiniDailyView: View {
    @Binding var day: MiniDailyDay
    @Environment(\.miniCardTextSize) private var cardTextSize
    @Environment(\.miniStudyAppearance) private var appearance
    var preparing: Bool
    var preparationError: String?
    var grading: Bool
    var gradingError: String?
    var retryPreparation: () -> Void
    var gradeTranslation: () -> Void
    var continueToday: (() -> Void)?
    var reviewGroupIndex: Int? = nil
    var hasNextReviewGroup = false
    var commands: MiniDailyCommands? = nil
    var saving = false
    var pauseMessage: String? = nil
    var canResume = true
    var openPlan: (() -> Void)? = nil
    var cancelAI: (() -> Void)? = nil
    var lessonPreparation: MiniLessonPreparation? = nil
    var retryLessonPreparation: (() -> Void)? = nil
    var openTranslationReview: ((Date) -> Void)? = nil
    var playWord: (MiniWord) -> Void = { _ in }
    var playSentence: (MiniStudySentence) -> Void = { _ in }
    var playSpellingResult: (MiniWord) -> Void = { _ in }
    var savedSentence: ((MiniWord) -> MiniStudySentence?)? = nil
    var previewWindow: MiniWindowCommands? = nil
    var previewLearningSpelling: MiniReviewCommands? = nil
    var previewAdvanceTranslation: (() -> Void)? = nil
    var previewTranslationNavigation: MiniTranslationNavigation? = nil
    var previewTranslationDraft: Binding<String>? = nil
    @FocusState private var translationFocused: Bool

    private var windowCommands: MiniWindowCommands? { commands?.window ?? previewWindow }

    private var translationDraft: Binding<String> { commands?.translationDraft ?? previewTranslationDraft ?? $day.translationDraft }

    private var completedDotColor: Color { appearance.isSimple ? .primary : .green }

    var body: some View {
        Group {
            if day.phase == .finished {
                summary.disabled(saving)
            } else if day.paused {
                VStack(spacing: 9) {
                    Text(day.flow?.goalReached == true ? "Done for today" : "Paused").font(.headline)
                    if let pauseMessage {
                        Text(pauseMessage).font(.caption).foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }
                    if canResume {
                        Button("Resume") {
                            if let commands { commands.resume(); return }
                            var next = day
                            if next.setPaused(false) { day = next }
                        }
                        .miniStudyButton()
                    } else if let openPlan {
                        MiniStudyIconButton(title: "调整学习计划", systemImage: "slider.horizontal.3", action: openPlan)
                    }
                }
                .disabled(saving)
            } else {
                switch day.phase {
                case .review: review
                case .learning: learning
                case .translation: translation.disabled(saving)
                case .finished: summary.disabled(saving)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder
    private var review: some View {
        if let window = day.memoryWindow, let visit = window.visit {
            windowCard(visit)
        } else if let session = day.review {
            MiniReviewView(
                session: Binding(
                    get: { day.review ?? session },
                    set: { day.review = $0 }
                ),
                onFinish: { completeReview() },
                finishTitle: "Review complete",
                finishLabel: reviewFinishLabel,
                groupIndex: reviewGroupIndex,
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

    private var reviewFinishLabel: String {
        if hasNextReviewGroup { return "Next group" }
        if day.flow != nil || day.writingRequired == false { return "Finish review" }
        return day.learningWords.isEmpty ? "Start writing" : "Start study"
    }

    @ViewBuilder
    private var learning: some View {
        if let word = day.retainedLearningWord ?? day.nextUnstudiedWord {
            if let lessonPreparation, !lessonPreparation.readyToStudy {
                MiniLessonPreparationView(preparation: lessonPreparation, retry: retryLessonPreparation)
                    .disabled(saving)
            } else if let sentence = sentence(for: word) {
                if let visit = day.memoryWindow?.visit {
                    windowCard(visit)
                } else if let memory = day.memory {
                    memoryCard(word, sentence: sentence, memory: memory).disabled(saving)
                } else {
                    wordStudy(word, sentence: sentence).disabled(saving)
                }
            } else {
                preparationStatus("Loading examples…", idleTitle: "Examples pending").disabled(saving)
            }
        } else if let session = day.learning {
            MiniReviewView(
                session: Binding(
                    get: { day.learning ?? session },
                    set: { day.learning = $0 }
                ),
                onFinish: { completeLearning() },
                finishTitle: "Spelling complete",
                finishLabel: "Start writing",
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
                            .font(cardTextSize.font(mediumSize: 34))
                            .accessibilityIdentifier("learningEnglish")
                            .onTapGesture { playWord(word) }
                            .accessibilityAddTraits(.isButton)
                        if !word.phonetic.isEmpty {
                            Text(word.phonetic).font(.caption).foregroundStyle(.secondary)
                        }
                        Text(word.meaning).miniTranslationPrivacy()
                        VStack(spacing: 3) {
                            Text(sentence.attributedEnglish(appearance: appearance)).font(.callout)
                                .onTapGesture { playSentence(sentence) }
                                .accessibilityAddTraits(.isButton)
                            Text(sentence.attributedTranslation).font(.caption).foregroundStyle(.secondary)
                                .miniTranslationPrivacy()

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
                    if let unmark = commands?.unmarkStudied {
                        MiniStudyIconButton(title: "撤销记住", systemImage: "arrow.uturn.backward") { unmark(word) }
                    }
                    if let advance = commands?.advanceLearningCard {
                        MiniStudyIconButton(title: "下一个", systemImage: "arrow.right", prominent: true) { advance(word) }
                    }
                }
                .font(.caption)
            } else {
                MiniStudyIconButton(title: "记住了", systemImage: "checkmark", prominent: true) {
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
                        .fill(round <= memory.completedRounds(for: word) ? completedDotColor : Color.clear)
                        .overlay { Circle().stroke(round <= memory.completedRounds(for: word) ? completedDotColor : Color.secondary, lineWidth: 1.4) }
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
                                .font(cardTextSize.font(mediumSize: 34))
                                .accessibilityIdentifier("learningEnglish")
                                .onTapGesture { playWord(word) }
                                .accessibilityAddTraits(.isButton)
                        }
                        if memory.round == 1 || memory.revealed {
                            if !word.phonetic.isEmpty { Text(word.phonetic).font(.caption).foregroundStyle(.secondary) }
                            Text(word.meaning).miniTranslationPrivacy()
                                .accessibilityIdentifier("memoryMeaning")
                        }
                        if memory.round < 3 || memory.revealed {
                            memoryExample(sentence)
                                .accessibilityIdentifier("memoryExample")
                        }
                        if memory.round == 1 || memory.revealed {
                            Text(sentence.attributedTranslation).font(.caption).foregroundStyle(.secondary)
                                .miniTranslationPrivacy()
                        }
                    }
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity, minHeight: area.size.height)
                    .padding(.horizontal, 4)
                }
            }
            HStack(spacing: 10) {
                if memory.round == 1 {
                    MiniStudyIconButton(title: "记住了", systemImage: "checkmark", prominent: true) { advanceMemory(true) }
                } else {
                    if !memory.revealed {
                        MiniStudyIconButton(title: "展开", systemImage: "eye") { revealMemory() }
                    } else {
                        MiniStudyIconButton(title: "再看一次", systemImage: "arrow.counterclockwise") { advanceMemory(false) }
                    }
                    MiniStudyIconButton(title: memory.round == 3 ? "待拼写" : "想起来了",
                                        systemImage: memory.round == 3 ? "text.cursor" : "lightbulb",
                                        prominent: true) { advanceMemory(true) }
                }
            }
        }
        .accessibilityIdentifier("memoryRoundCard")
    }

    private func windowCard(_ visit: MiniMemoryWindow.Visit) -> some View {
        let controls = windowCommands
        let sentence = sentence(for: visit.word)
        let filledDots = visit.completedStages
        return VStack(spacing: 8) {
            HStack(spacing: 7) {
                ForEach(0..<3, id: \.self) { stage in
                    Circle()
                        .fill(stage < filledDots ? completedDotColor : Color.clear)
                        .overlay { Circle().stroke(stage < filledDots ? completedDotColor : Color.secondary, lineWidth: 1.4) }
                        .frame(width: 9, height: 9)
                        .accessibilityLabel(["初见记忆", "语境回忆", "词义回忆"][stage])
                        .accessibilityValue(stage < filledDots ? "已完成" : (stage == visit.stage && visit.initial == nil ? "当前阶段" : "待完成"))
                }
                if day.phase == .learning, let flow = day.flow {
                    Spacer(minLength: 4)
                    Text("\(flow.groupIndex) · \(flow.groupWords.count)/\(flow.groupTarget)")
                        .font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                        .accessibilityLabel("第 \(flow.groupIndex) 组，已通过 \(flow.groupWords.count) 词，共 \(flow.groupTarget) 词")
                } else if day.phase == .review, let reviewGroupIndex, let review = day.review, let window = review.relearning {
                    let done = window.events.count { $0.stage == 2 && $0.remembered }
                    let total = review.relearningWords?.count ?? 0
                    Spacer(minLength: 4)
                    Text("\(reviewGroupIndex) · \(done)/\(total)")
                        .font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                        .accessibilityLabel("第 \(reviewGroupIndex) 组重学，已通过 \(done) 词，共 \(total) 词")
                }
            }
            .accessibilityIdentifier("memoryRoundDots")
            GeometryReader { area in
                ScrollView {
                    VStack(spacing: 7) {
                        if visit.stage != 1 || visit.showsFullCard {
                            Text(visit.word.spelling)
                                .font(cardTextSize.font(mediumSize: 34))
                                .accessibilityIdentifier("learningEnglish")
                                .onTapGesture { playWord(visit.word) }
                                .accessibilityAddTraits(.isButton)
                        }
                        if visit.showsFullCard {
                            if !visit.word.phonetic.isEmpty {
                                Text(visit.word.phonetic).font(.caption).foregroundStyle(.secondary)
                            }
                            Text(visit.word.meaning).miniTranslationPrivacy()
                                .accessibilityIdentifier("memoryMeaning")
                        }
                        if visit.stage == 1, !visit.showsFullCard, sentence == nil {
                            Text(visit.word.meaning).font(.headline).miniTranslationPrivacy()
                                .help("词义提示回忆（暂无例句）")
                        }
                        if visit.stage != 2 || visit.showsFullCard, let sentence {
                            memoryExample(sentence).accessibilityIdentifier("memoryExample")
                            if visit.showsFullCard {
                                Text(sentence.attributedTranslation).font(.caption).foregroundStyle(.secondary)
                                    .miniTranslationPrivacy()
                            }
                        }
                    }
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity, minHeight: area.size.height)
                    .padding(.horizontal, 4)
                }
            }
            MiniWindowControls(visit: visit, commands: controls)
        }
        .accessibilityIdentifier("memoryWindowCard")
        .task(id: visit.advancesAutomatically ? visit.id : nil) {
            // Older versions could stop between recording a choice and advancing its card.
            if visit.advancesAutomatically { controls?.advance(nil) }
        }
    }

    private func memoryExample(_ sentence: MiniStudySentence) -> some View {
        Text(sentence.attributedEnglish(appearance: appearance, includesAudioLinks: true)).font(.callout)
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
        let navigation = commands?.translationNavigation ?? previewTranslationNavigation
        let index = navigation?.index ?? day.translationIndex
        if let task = day.translationTask(at: index) {
            let attempt = day.translation.last { $0.taskID == task.id }
            VStack(alignment: .leading, spacing: 8) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 10) {
                        translationPrompt(task, index: index)
                        if let attempt, navigation == nil {
                            translationResult(task, attempt: attempt)
                        } else {
                            translationEditor
                            if let attempt, attempt.revisions?.isEmpty != false, attempt.feedback != nil {
                                translationFeedback(task, attempt: attempt)
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }

                if let navigation {
                    translationNavigationControls(navigation, attempt: attempt)
                } else {
                    translationControls(attempt)
                        .frame(maxWidth: .infinity, alignment: .trailing)
                }
            }
            .padding(.vertical, 2)
            .id(task.id)
        } else {
            preparationStatus("Loading prompts…", idleTitle: "Prompts pending")
        }
    }

    private var translationEditor: some View {
        TextEditor(text: translationDraft)
            .font(.body)
            .focused($translationFocused)
            .scrollContentBackground(.hidden)
            .frame(height: 66)
            .miniTranslationPrivacy()
            .padding(5)
            .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
            .overlay(alignment: .topLeading) {
                if translationDraft.wrappedValue.isEmpty {
                    Text("Type here…")
                        .font(.body).foregroundStyle(.secondary)
                        .padding(.horizontal, 10).padding(.top, 5)
                        .allowsHitTesting(false).accessibilityHidden(true)
                }
            }
            .overlay {
                RoundedRectangle(cornerRadius: 8)
                    .strokeBorder(Color(nsColor: .separatorColor), lineWidth: 0.7).allowsHitTesting(false)
            }
            .onAppear { translationFocused = true }
            .accessibilityLabel("输入译文")
            .accessibilityIdentifier("dailyTranslationDraft")
    }

    private func translationPrompt(_ task: MiniTranslationTask, index: Int) -> some View {
        let direction = task.direction == .englishToChinese ? "EN → ZH" : "ZH → EN"
        let number = index - day.translationGroupStart + 1
        let total = day.flow?.groupWords.count ?? day.translationCount
        let group = day.flow.map { "\($0.groupIndex) · " } ?? ""
        return VStack(alignment: .leading, spacing: 7) {
            HStack {
                Text(direction)
                    .font(.caption.weight(.semibold))
                    .accessibilityLabel(task.direction == .englishToChinese ? "英译中" : "中译英")
                if commands?.translationNavigation != nil, let openTranslationReview,
                   let attempt = day.translation.last(where: { $0.taskID == task.id }) {
                    MiniStudyIconButton(title: "当天点评", systemImage: "text.bubble") {
                        openTranslationReview(attempt.submittedAt)
                    }
                    .font(.caption)
                    .accessibilityIdentifier("openTranslationReview")
                }
                Spacer(minLength: 4)
                Text(group + "\(number)/\(total)").font(.caption.monospacedDigit())
            }
            .foregroundStyle(.secondary)
            Text(task.prompt)
                .font(.system(size: 16, weight: .semibold))
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
                .accessibilityIdentifier("dailyTranslationPrompt")
        }
    }

    private func translationResult(_ task: MiniTranslationTask, attempt: MiniTranslationAttempt) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            labeledText("Your answer", attempt.answer, protectsTranslation: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 10).padding(.vertical, 7)
                .background(.quaternary.opacity(0.55), in: RoundedRectangle(cornerRadius: 8))
            translationFeedback(task, attempt: attempt)
        }
        .textSelection(.enabled)
    }

    private func translationFeedback(_ task: MiniTranslationTask, attempt: MiniTranslationAttempt) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            // The review page applies the current meaning rubric to older Chinese translations.
            if let feedback = attempt.feedback, task.direction != .englishToChinese || openTranslationReview == nil {
                labeledText("Feedback", feedback.comment)
                if let strengths = feedback.strengths, !strengths.isEmpty {
                    labeledText("Strengths", strengths.joined(separator: "\n"))
                }
                if let improvements = feedback.improvements, !improvements.isEmpty {
                    labeledText("Improvements", improvements.joined(separator: "\n"))
                }
                if let keyPoints = feedback.keyPoints, !keyPoints.isEmpty {
                    labeledText("Key points", keyPoints.joined(separator: "\n"))
                }
                labeledText("Reference", feedback.referenceTranslation ?? task.reference, protectsTranslation: true)
                if !feedback.tip.isEmpty { labeledText("Tip", feedback.tip) }
                if !feedback.usefulPhrase.isEmpty { labeledText("Useful phrase", feedback.usefulPhrase) }
            } else if attempt.feedback == nil, day.flow == nil, let gradingError {
                Text(gradingError).font(.caption).foregroundStyle(.secondary)
            }
        }
        .textSelection(.enabled)
    }

    private func translationNavigationControls(_ navigation: MiniTranslationNavigation, attempt: MiniTranslationAttempt?) -> some View {
        let index = navigation.index
        let text = translationDraft.wrappedValue
        let valid = !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && text.count <= 4_000
        let changed = attempt.map { $0.latestAnswer != text } ?? false
        let last = index + 1 == day.translationCount
        return HStack(spacing: 7) {
            MiniStudyIconButton(title: "上一题", systemImage: "arrow.left") { navigation.select(index - 1) }
                .disabled(index <= day.translationGroupStart)
                .accessibilityIdentifier("previousTranslation")
            Spacer(minLength: 0)
            if changed, let attempt {
                MiniStudyIconButton(title: "还原", systemImage: "arrow.uturn.backward") {
                    translationDraft.wrappedValue = attempt.latestAnswer
                }
                MiniStudyIconButton(title: "提交修改", systemImage: "square.and.arrow.up") { navigation.revise(text) }
                    .disabled(!valid)
                    .accessibilityIdentifier("reviseTranslation")
            }
            if index < day.translationIndex {
                MiniStudyIconButton(title: "下一题", systemImage: "arrow.right") { navigation.select(index + 1) }
                    .accessibilityIdentifier("nextTranslation")
            } else if attempt == nil {
                MiniStudyIconButton(title: "提交译文", systemImage: "arrow.up", prominent: true, action: submitTranslation)
                    .disabled(!valid)
                    .accessibilityIdentifier("submitTranslation")
            } else if day.flow == nil, previewAdvanceTranslation == nil, attempt?.feedback == nil {
                if grading {
                    ProgressView().controlSize(.small)
                } else {
                    Button(gradingError == nil ? "Check" : "Retry", action: gradeTranslation)
                        .miniStudyButton()
                }
            } else if last, let pending = navigation.pendingEdit, pending != index {
                let question = pending - day.translationGroupStart + 1
                Button("Edit \(question)") { navigation.select(pending) }
                    .miniStudyButton()
                    .help("查看第 \(question) 题修改")
                    .accessibilityLabel("查看第 \(question) 题修改")
                    .accessibilityIdentifier("pendingTranslationEdit")
            } else {
                confirmTranslationButton(last: last) {
                    if let commands { commands.advanceTranslation() } else { previewAdvanceTranslation?() }
                }
                .disabled(changed)
                .accessibilityIdentifier("confirmTranslation")
            }
        }
        .controlSize(.small)
    }

    @ViewBuilder
    private func translationControls(_ attempt: MiniTranslationAttempt?) -> some View {
        if day.flow != nil || previewAdvanceTranslation != nil, let attempt {
            HStack {
                if let openTranslationReview {
                    MiniStudyIconButton(title: "当天点评", systemImage: "text.bubble") {
                        openTranslationReview(attempt.submittedAt)
                    }
                    .font(.caption)
                    .accessibilityIdentifier("openTranslationReview")
                }
                Spacer()
                confirmTranslationButton(last: day.translationIndex + 1 >= day.translationCount) {
                    if let commands { commands.advanceTranslation() }
                    else { previewAdvanceTranslation?() }
                }
                .accessibilityIdentifier("confirmTranslation")
            }
        } else if attempt?.feedback != nil {
            MiniStudyIconButton(title: "继续", systemImage: "arrow.right", prominent: true) {
                if let commands { commands.advanceTranslation(); return }
                var next = day
                if next.advanceTranslation() { day = next }
            }
        } else if grading {
            VStack(alignment: .trailing, spacing: 4) {
                ProgressView("Loading feedback…").controlSize(.small)
                if let cancelAI { MiniStudyIconButton(title: "停止", systemImage: "stop", action: cancelAI) }
            }
        } else if attempt != nil {
            Button(gradingError == nil ? "Check" : "Retry", action: gradeTranslation)
                .miniStudyButton()
        } else {
            MiniStudyIconButton(title: "提交译文", systemImage: "arrow.up", prominent: true, action: submitTranslation)
                .disabled(translationDraft.wrappedValue.count > 4_000
                          || translationDraft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
    }

    @ViewBuilder
    private func confirmTranslationButton(last: Bool, action: @escaping () -> Void) -> some View {
        if last {
            Button("Finish group", action: action)
                .miniStudyButton(prominent: true)
                .help("完成本组")
                .accessibilityLabel("完成本组")
        } else {
            MiniStudyIconButton(title: "下一题", systemImage: "arrow.right", prominent: true, action: action)
        }
    }

    private func preparationStatus(_ pendingTitle: String, idleTitle: String) -> some View {
        VStack(spacing: 8) {
            if preparing {
                ProgressView(pendingTitle).controlSize(.small)
                if let cancelAI { MiniStudyIconButton(title: "停止", systemImage: "stop", action: cancelAI).font(.caption) }
            } else {
                Text(preparationError ?? idleTitle)
                    .font(.callout)
                    .multilineTextAlignment(.center)
                Button(preparationError == nil ? "Load" : "Retry", action: retryPreparation)
                    .miniStudyButton()
            }
        }
        .padding(8)
    }

    private var summary: some View {
        VStack(spacing: 8) {
            if day.reviewWords.isEmpty && day.learningWords.isEmpty {
                Text("All clear").font(.headline)
            } else {
                Text(continueToday == nil ? "Done" : "Group complete").font(.headline)
                HStack(spacing: 12) {
                    summaryCount(day.reviewWords.count, systemImage: "arrow.clockwise", label: "复习")
                    summaryCount(day.learningWords.count, systemImage: "book.closed", label: "学习")
                    summaryCount(day.translation.count, systemImage: "text.bubble", label: "翻译")
                }
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
            }
            if let continueToday {
                Button("Continue", action: continueToday)
                    .miniStudyButton(prominent: true)
                    .help("继续今日学习")
                    .accessibilityLabel("继续今日学习")
            }
            if let openTranslationReview, let date = day.translation.last?.submittedAt {
                MiniStudyIconButton(title: "查看翻译点评", systemImage: "text.bubble") { openTranslationReview(date) }
            }
        }
    }

    private func summaryCount(_ count: Int, systemImage: String, label: String) -> some View {
        Label("\(count)", systemImage: systemImage)
            .help(label)
            .accessibilityLabel("\(label) \(count)")
    }

    private func labeledText(_ label: String, _ value: String, protectsTranslation: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
            if protectsTranslation {
                Text(value).font(.callout).miniTranslationPrivacy()
            } else {
                Text(value).font(.callout)
            }
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
        guard next.submitTranslation(translationDraft.wrappedValue) != nil else { return }
        day = next
        if previewAdvanceTranslation == nil { gradeTranslation() }
    }
}

extension MiniStudySentence {
    func attributedEnglish(appearance: MiniStudyAppearance, includesAudioLinks: Bool = false) -> AttributedString {
        var attributed = AttributedString(english)
        attributed.foregroundColor = .primary
        if includesAudioLinks { attributed.link = URL(string: "lingoweave-sentence://play") }
        for target in highlightedRanges {
            guard let start = AttributedString.Index(target.lowerBound, within: attributed),
                  let end = AttributedString.Index(target.upperBound, within: attributed) else { continue }
            let range = start..<end
            if includesAudioLinks { attributed[range].link = URL(string: "lingoweave-word://play") }
            attributed[range].foregroundColor = appearance.isSimple ? .primary : .accentColor
            attributed[range].font = .callout.bold()
        }
        return attributed
    }
}

private struct MiniLessonPreparationView: View {
    let preparation: MiniLessonPreparation
    let retry: (() -> Void)?
    @Environment(\.miniStudyAppearance) private var appearance

    private var completedColor: Color { appearance.isSimple ? .secondary : .green }

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
                Text("Getting ready").font(.headline)
                Spacer(minLength: 8)
                if let target = preparation.groupTarget {
                    Text("\(target)")
                        .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                        .accessibilityLabel("本组目标 \(target) 词")
                }
            }
            ProgressView(value: preparation.progress)
                .tint(completedColor)
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
            if let retry, preparation.hasFailure || !preparation.isRunning {
                Button("Retry", action: retry)
                    .miniStudyButton()
                    .font(.caption)
                    .help("重新准备")
                    .accessibilityLabel("重新准备")
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
                        .fill(step.status == .complete ? completedColor.opacity(0.65) : Color.secondary.opacity(0.25))
                        .frame(width: 1, height: 15)
                }
            }
            HStack(spacing: 8) {
                Text(stepTitle(step.id)).font(.callout)
                    .foregroundStyle(step.status == .waiting ? .secondary : .primary)
                Spacer(minLength: 4)
                Text("\(step.completed)/\(step.total)")
                    .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                if step.status == .running {
                    ProgressView().controlSize(.mini).frame(width: 13, height: 13)
                }
            }
            .frame(height: 20)
        }
        .frame(minHeight: isLast ? 20 : 35, alignment: .top)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(step.title)，\(statusLabel(step.status))，\(step.completed) / \(step.total) \(step.unit)")
        .accessibilityIdentifier("lessonPreparation-" + step.id.rawValue)
    }

    private func stepTitle(_ id: MiniLessonPreparation.Step.ID) -> String {
        switch id {
        case .words: "Words"
        case .examples: "Examples"
        case .wordAudio: "Word audio"
        case .sentenceAudio: "Example audio"
        }
    }

    @ViewBuilder
    private func stepIndicator(_ status: MiniLessonPreparation.Step.Status) -> some View {
        switch status {
        case .complete:
            Image(systemName: "checkmark.circle.fill").font(.system(size: 19)).foregroundStyle(completedColor)
        case .failed:
            Image(systemName: "exclamationmark.circle").font(.system(size: 19))
                .foregroundStyle(appearance.isSimple ? Color.secondary : Color.orange)
        case .running:
            Circle().strokeBorder(appearance.isSimple ? Color.secondary : Color.accentColor, lineWidth: 2)
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
