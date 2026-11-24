import AppKit
import SwiftUI

struct MiniReviewCommands {
    let draft: Binding<String>
    let chooseJudgment: (MiniReviewJudgment) -> Void
    let advanceJudgment: (Bool) -> Void
    let submitSpelling: (String) -> Void
    var advanceSpelling: (() -> Void)? = nil
    var openDictation: (() -> Void)? = nil
    var clearJudgment: (() -> Void)? = nil
    var presentedSession: MiniReviewSession? = nil
}

struct MiniReviewView: View {
    @Binding var session: MiniReviewSession
    var onFinish: () -> Void
    var finishTitle = "Review complete"
    var finishLabel = "Start study"
    var groupIndex: Int? = nil
    var sentenceForWord: (MiniWord) -> MiniStudySentence? = { _ in nil }
    var playWord: (MiniWord) -> Void = { _ in }
    var playSentence: (MiniStudySentence) -> Void = { _ in }
    var playSpellingResult: (MiniWord) -> Void = { _ in }
    var commands: MiniReviewCommands? = nil
    var saving = false
    @State private var hiddenSpellingReferenceAt: Int?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.miniCardTextSize) private var cardTextSize
    @Environment(\.miniStudyAppearance) private var appearance

    private var displayed: MiniReviewSession { commands?.presentedSession ?? session }

    var body: some View {
        VStack(spacing: 8) {
            if displayed.totalCount > 0 { progressDots }

            GeometryReader { area in
                ScrollView {
                    content(viewportHeight: area.size.height)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 4)
                        .padding(.vertical, 8)
                        .frame(maxWidth: .infinity, minHeight: area.size.height,
                               alignment: displayed.phase == .spelling ? .top : .center)
                }
            }
        }
        .onChange(of: displayed.spellingAttempts.count) { previous, current in
            if commands?.presentedSession == nil, current > previous, let attempt = displayed.spellingAttempts.last {
                playSpellingResult(attempt.word)
            }
        }
    }

    private var progressDots: some View {
        let total = displayed.totalCount
        let markerWidth: CGFloat = displayed.phase == .judgment ? 9 : 11
        let markersWidth = CGFloat(total) * markerWidth + CGFloat(total - 1) * 7
        let groupLabel = groupIndex.map {
            Text("\($0)")
                .font(.caption2.monospacedDigit()).foregroundStyle(.secondary).fixedSize()
                .help("第 \($0) 组")
                .accessibilityLabel("第 \($0) 组")
        }
        return HStack(spacing: 8) {
            groupLabel
            GeometryReader { area in
                if markersWidth <= area.size.width {
                    let dots = displayed.progressDots
                    HStack(spacing: 7) {
                        ForEach(dots.indices, id: \.self) { index in
                            let state = dots[index].state
                            progressMarker(state)
                                .accessibilityElement(children: .ignore)
                                .accessibilityLabel("第 \(index + 1) 个词")
                                .accessibilityValue(progressLabel(state))
                        }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    let done = total - displayed.remainingCount
                    HStack(spacing: 8) {
                        ProgressView(value: Double(done), total: Double(total))
                            .progressViewStyle(.linear).tint(.secondary)
                        Text("\(done) / \(total)").font(.caption.monospacedDigit())
                            .foregroundStyle(.secondary).fixedSize()
                    }
                    .frame(maxHeight: .infinity)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("本轮进度")
                    .accessibilityValue("已完成 \(done) 个，共 \(total) 个词")
                }
            }
            .frame(height: 16)
            // Matching side widths keep the markers centered on the card at every group number.
            groupLabel?.hidden().accessibilityHidden(true)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("本组进度")
    }

    @ViewBuilder
    private func progressMarker(_ state: MiniReviewProgressDot.State) -> some View {
        if displayed.phase != .judgment {
            let shape = SpellingProgressShape(triangleAmount: state == .current ? 1 : 0)
            let passedColor = appearance.isSimple ? Color.primary : .green
            let strokeColor = switch state {
            case .passed: passedColor
            case .current: Color.primary
            case .repeatNext: appearance.isSimple ? Color.primary.opacity(0.55) : .red
            case .pending, .capped: Color.primary.opacity(0.55)
            }
            shape.fill(passedColor)
                .opacity(state == .passed ? 1 : 0)
                .overlay {
                    shape.stroke(
                        strokeColor,
                        style: StrokeStyle(lineWidth: 1.25, lineJoin: .round,
                                           dash: appearance.isSimple && state == .repeatNext ? [2, 1.5] : [])
                    )
                }
                .frame(width: 11, height: 11)
                .animation(reduceMotion || appearance.isSimple ? nil : .easeInOut(duration: 0.16), value: state)
        } else {
            judgmentDot(state).frame(width: 9, height: 9)
        }
    }

    @ViewBuilder
    private func judgmentDot(_ state: MiniReviewProgressDot.State) -> some View {
        switch state {
        case .current:
            Circle().fill(.primary)
        case .passed:
            if appearance.isSimple {
                Image(systemName: "checkmark")
                    .font(.system(size: 8, weight: .semibold)).foregroundStyle(.primary)
            } else {
                Circle().strokeBorder(.green, lineWidth: 1.5)
            }
        case .repeatNext:
            if appearance.isSimple {
                Circle().strokeBorder(.secondary, style: StrokeStyle(lineWidth: 1.25, dash: [2, 1.5]))
            } else {
                Circle().strokeBorder(.red, lineWidth: 1.5)
            }
        case .pending, .capped:
            Circle().strokeBorder(.secondary, lineWidth: 1.5)
        }
    }

    private func progressLabel(_ state: MiniReviewProgressDot.State) -> String {
        switch state {
        case .current: "当前词"
        case .passed: "已通过"
        case .repeatNext: "下一轮继续"
        case .pending: "未轮到"
        case .capped: displayed.phase == .judgment ? "已达到判断次数上限" : "本轮已跳过"
        }
    }

    @ViewBuilder
    private func content(viewportHeight: CGFloat) -> some View {
        switch displayed.phase {
        case .judgment:
            if let word = displayed.currentWord { judgment(for: word) }
        case .spelling:
            if let word = displayed.currentWord { spelling(for: word, viewportHeight: viewportHeight) }
        case .finished:
            VStack(spacing: 12) {
                Text(displayed.spellingSkips?.isEmpty == false ? "Round complete" : finishTitle).font(.headline)
                Button(finishLabel, action: onFinish)
                    .miniStudyButton(prominent: true).disabled(saving)
            }
        }
    }

    private func judgment(for word: MiniWord) -> some View {
        VStack(spacing: 12) {
            Text(word.spelling)
                .font(cardTextSize.font(mediumSize: 35))
                .accessibilityIdentifier("reviewEnglish")
                .onTapGesture { playWord(word) }
                .accessibilityAddTraits(.isButton)

            if displayed.currentJudgment != nil {
                Text(word.meaning.isEmpty ? "No definition" : word.meaning)
                    .miniTranslationPrivacy()
                    .accessibilityIdentifier("reviewMeaning")
                example(for: word)
                HStack(spacing: 8) {
                    MiniStudyIconButton(title: "记错了", systemImage: "arrow.uturn.backward") {
                        advanceJudgment(markWrong: true)
                    }
                    MiniStudyIconButton(title: "下一个", systemImage: "arrow.right", prominent: true) {
                        advanceJudgment(markWrong: false)
                    }
                }
            } else {
                HStack(spacing: 8) {
                    MiniStudyIconButton(title: "遗忘", systemImage: "xmark") { chooseJudgment(.forgotten) }
                    MiniStudyIconButton(title: "模糊", systemImage: "questionmark") { chooseJudgment(.fuzzy) }
                    MiniStudyIconButton(title: "清晰", systemImage: "checkmark") { chooseJudgment(.clear) }
                }
            }
        }
    }

    @ViewBuilder
    private func example(for word: MiniWord) -> some View {
        if let sentence = sentenceForWord(word) {
            VStack(spacing: 3) {
                Text(sentence.attributedEnglish(appearance: appearance)).font(.callout)
                    .onTapGesture { playSentence(sentence) }
                    .accessibilityAddTraits(.isButton)
                Text(sentence.attributedTranslation).font(.caption).foregroundStyle(.secondary)
                    .miniTranslationPrivacy()
            }
            .textSelection(.enabled)
            .accessibilityIdentifier("studyExample")
        }
    }

    private func spelling(for word: MiniWord, viewportHeight: CGFloat) -> some View {
        let correcting = displayed.spellingState == .correcting
        let accepted = displayed.spellingState == .readyToAdvance
        let skipped = displayed.spellingState == .skipped
        let draft = commands?.draft ?? $session.spellingDraft
        let showingReference = skipped || (correcting
            && hiddenSpellingReferenceAt != displayed.spellingAttempts.count
            && displayed.lastSpellingAttempt?.answer == draft.wrappedValue)
        let fieldHeight: CGFloat = 30

        return VStack(spacing: 9) {
            VStack(spacing: 9) {
                Text(word.meaning)
                    .font(.title3)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("reviewSpellingPrompt")

                VStack(spacing: 2) {
                    ReviewAnswerField(
                        text: draft,
                        selectOnFocus: correcting && showingReference,
                        onSubmit: submitSpelling,
                        accepted: accepted,
                        incorrect: showingReference,
                        inputLocked: skipped
                    )
                    .frame(height: fieldHeight)
                    Divider().overlay {
                        if !appearance.isSimple, showingReference,
                           displayed.lastSpellingAttempt?.answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == true {
                            Color.red
                        }
                    }
                }
                .frame(width: 206)
            }
            // Anchor the typing row within the available space. Feedback grows below it.
            .frame(minHeight: (viewportHeight + fieldHeight) / 2, alignment: .bottom)

            VStack(spacing: 6) {
                if accepted || skipped {
                    MiniStudyIconButton(title: "下一词", systemImage: "arrow.right", prominent: true, action: advanceSpelling)
                        .keyboardShortcut(.defaultAction)
                        .font(.caption)
                        .accessibilityIdentifier("advanceCorrectSpelling")
                }
                if showingReference {
                    HStack(spacing: 4) {
                        if appearance.isSimple {
                            Image(systemName: "exclamationmark.circle").font(.caption).accessibilityHidden(true)
                        }
                        Text(word.spelling)
                            .lineLimit(1).minimumScaleFactor(0.65)
                    }
                    .font(.callout).foregroundStyle(.secondary)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("正确拼写 \(word.spelling)")
                    .accessibilityIdentifier("reviewExpectedSpelling")
                }
            }
            // Keep the scrollable extent stable even when both a button and a reference appear.
            .frame(height: 46, alignment: .top)
        }
        .onChange(of: draft.wrappedValue) { _, current in
            if correcting, current != displayed.lastSpellingAttempt?.answer {
                hiddenSpellingReferenceAt = displayed.spellingAttempts.count
            }
        }
    }

    /// Returns true when the rejected answer should stay selected for editing.
    private func submitSpelling(_ answer: String) -> Bool {
        if displayed.spellingState == .readyToAdvance || displayed.spellingState == .skipped {
            advanceSpelling()
            return false
        }
        if displayed.spellingState == .correcting, answer == displayed.lastSpellingAttempt?.answer {
            hiddenSpellingReferenceAt = nil
            return !answer.isEmpty
        }
        if let commands {
            commands.submitSpelling(answer)
            return false
        }
        var updated = session
        guard updated.submitSpelling(answer, advanceOnCorrect: appearance.isSimple) else { return false }
        let shouldSelectAnswer = updated.spellingState == .correcting
        session = updated
        return shouldSelectAnswer
    }

    private func advanceSpelling() {
        if let commands { commands.advanceSpelling?() }
        else { session.advanceSpelling() }
    }

    private func chooseJudgment(_ judgment: MiniReviewJudgment) {
        if let commands { commands.chooseJudgment(judgment) }
        else { session.chooseJudgment(judgment) }
    }

    private func advanceJudgment(markWrong: Bool) {
        if let commands { commands.advanceJudgment(markWrong) }
        else { session.advanceJudgment(markWrong: markWrong) }
    }
}

private struct SpellingProgressShape: Shape {
    var triangleAmount: CGFloat

    var animatableData: CGFloat {
        get { triangleAmount }
        set { triangleAmount = newValue }
    }

    func path(in rect: CGRect) -> Path {
        let size = min(rect.width, rect.height)
        let circleRadius = size * 0.4
        let triangleInradius = size * 0.23
        let sideArc = 2 * CGFloat.pi / 3
        let stepsPerSide = 24
        var path = Path()

        // Keep the same rays throughout the animation, including all three vertices.
        for step in 0..<(3 * stepsPerSide) {
            let offset = CGFloat(step) * sideArc / CGFloat(stepsPerSide)
            let angle = offset - .pi / 2
            let sideOffset = CGFloat(step % stepsPerSide) * sideArc / CGFloat(stepsPerSide)
            let triangleRadius = triangleInradius / cos(sideOffset - sideArc / 2)
            let radius = circleRadius + triangleAmount * (triangleRadius - circleRadius)
            let point = CGPoint(x: rect.midX + radius * cos(angle), y: rect.midY + radius * sin(angle))
            if step == 0 { path.move(to: point) } else { path.addLine(to: point) }
        }

        path.closeSubpath()
        return path
    }
}

struct ReviewAnswerField: NSViewRepresentable {
    @Binding var text: String
    let selectOnFocus: Bool
    let onSubmit: (String) -> Bool
    var accepted = false
    var incorrect = false
    var inputLocked = false
    var focusRequest = 0
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.miniStudyAppearance) private var appearance
    private var answerColor: NSColor {
        if appearance.isSimple { return .labelColor }
        if accepted { return .systemGreen }
        return incorrect ? .systemRed : .labelColor
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> AnswerTextField {
        let field = AnswerTextField()
        field.delegate = context.coordinator
        field.isBordered = false
        field.isBezeled = false
        field.drawsBackground = false
        field.isEditable = true
        field.isEnabled = isEnabled
        field.answerWasEnabled = isEnabled
        field.isSelectable = true
        field.focusRingType = .none
        field.maximumNumberOfLines = 1
        field.cell?.usesSingleLineMode = true
        field.cell?.isScrollable = true
        field.alignment = .center
        field.font = .systemFont(ofSize: 21, weight: .medium)
        field.textColor = answerColor
        field.isAutomaticTextCompletionEnabled = false
        if #available(macOS 15.2, *) { field.allowsWritingTools = false }
        field.setAccessibilityLabel("拼写答案")
        field.setAccessibilityIdentifier("reviewSpellingAnswer")
        field.stringValue = text
        field.selectOnFocus = selectOnFocus
        return field
    }

    func updateNSView(_ field: AnswerTextField, context: Context) {
        context.coordinator.owner = self
        let becameEnabled = isEnabled && !field.answerWasEnabled
        field.answerWasEnabled = isEnabled
        if field.isEnabled != isEnabled { field.isEnabled = isEnabled }
        if field.textColor != answerColor { field.textColor = answerColor }
        let shouldSelect = selectOnFocus && !field.selectOnFocus
        field.selectOnFocus = selectOnFocus
        if becameEnabled || field.focusRequest != focusRequest {
            field.focusRequest = focusRequest
            field.requestAnswerFocus()
        }
        if let editor = field.currentEditor() as? NSTextView {
            guard !editor.hasMarkedText() else { return }
            if editor.textColor != answerColor { editor.textColor = answerColor }
            let selectionColor = !appearance.isSimple && (accepted || incorrect) ? answerColor : NSColor.selectedTextColor
            if editor.selectedTextAttributes[.foregroundColor] as? NSColor != selectionColor {
                editor.selectedTextAttributes[.foregroundColor] = selectionColor
            }
            if shouldSelect, editor.string == text {
                editor.setSelectedRange(NSRange(location: 0, length: text.utf16.count))
                return
            }
            guard editor.string != text else { return }
            editor.string = text
            editor.setSelectedRange(NSRange(location: text.utf16.count, length: 0))
        } else if field.stringValue != text {
            field.stringValue = text
        }
    }

    final class Coordinator: NSObject, NSTextFieldDelegate {
        var owner: ReviewAnswerField

        init(_ owner: ReviewAnswerField) { self.owner = owner }

        func controlTextDidChange(_ notification: Notification) {
            guard let field = notification.object as? NSTextField,
                  let editor = field.currentEditor() as? NSTextView,
                  !editor.hasMarkedText() else { return }
            if owner.accepted || owner.inputLocked { editor.string = owner.text }
            else { owner.text = editor.string }
        }

        func control(_ control: NSControl, textView: NSTextView, doCommandBy command: Selector) -> Bool {
            guard command == #selector(NSResponder.insertNewline(_:)), !textView.hasMarkedText() else {
                return false
            }
            guard NSApp.currentEvent?.isARepeat != true else { return true }
            if owner.onSubmit(textView.string) {
                textView.setSelectedRange(NSRange(location: 0, length: textView.string.utf16.count))
            }
            return true
        }
    }
}

final class AnswerTextField: NSTextField {
    var selectOnFocus = false
    var focusRequest = 0
    var answerWasEnabled = false
    private var needsAnswerFocus = true

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        NotificationCenter.default.removeObserver(self, name: NSWindow.didBecomeKeyNotification, object: nil)
        guard window != nil else { return }
        NotificationCenter.default.addObserver(self, selector: #selector(answerWindowBecameKey),
                                               name: NSWindow.didBecomeKeyNotification, object: window)
        requestAnswerFocus()
    }

    func requestAnswerFocus() {
        needsAnswerFocus = true
        DispatchQueue.main.async { [weak self] in
            self?.focusAnswerIfNeeded()
        }
    }

    @objc private func answerWindowBecameKey() { focusAnswerIfNeeded() }

    private func focusAnswerIfNeeded() {
        guard needsAnswerFocus, isEnabled, let window,
              window.makeFirstResponder(self), let editor = currentEditor() as? NSTextView else { return }
        needsAnswerFocus = false
        let length = editor.string.utf16.count
        editor.setSelectedRange(selectOnFocus
            ? NSRange(location: 0, length: length)
            : NSRange(location: length, length: 0))
    }
}
