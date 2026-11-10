import AppKit
import SwiftUI

struct MiniReviewView: View {
    @Binding var session: MiniReviewSession
    var onFinish: () -> Void
    var finishTitle = "复习完成"
    var finishLabel = "开始学习"
    var sentenceForWord: (MiniWord) -> (english: String, chinese: String)? = { _ in nil }
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 8) {
            if session.totalCount > 0 {
                progressDots
            }

            GeometryReader { area in
                ScrollView {
                    content
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 4)
                        .padding(.vertical, 8)
                        .frame(maxWidth: .infinity, minHeight: area.size.height)
                }
            }
        }
    }

    private var progressDots: some View {
        let dots = session.progressDots
        return HStack(spacing: 7) {
            ForEach(dots.indices, id: \.self) { index in
                let state = dots[index].state
                progressMarker(state)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("第 \(index + 1) 个词")
                    .accessibilityValue(progressLabel(state))
            }
        }
        .padding(.top, 2)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("本组进度")
    }

    @ViewBuilder
    private func progressMarker(_ state: MiniReviewProgressDot.State) -> some View {
        if session.phase != .judgment {
            let shape = SpellingProgressShape(triangleAmount: state == .current ? 1 : 0)
            shape.fill(.primary)
                .opacity(state == .passed ? 1 : 0)
                .overlay {
                    shape.stroke(
                        Color.primary.opacity(state == .current || state == .passed ? 1 : 0.55),
                        style: StrokeStyle(lineWidth: 1.25, lineJoin: .round)
                    )
                }
                .frame(width: 11, height: 11)
                .animation(reduceMotion ? nil : .easeInOut(duration: 0.16), value: state)
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
            Circle().strokeBorder(.green, lineWidth: 1.5)
        case .repeatNext:
            Circle().strokeBorder(.red, lineWidth: 1.5)
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
        case .capped: "已达到判断次数上限"
        }
    }

    @ViewBuilder
    private var content: some View {
        switch session.phase {
        case .judgment:
            if let word = session.currentWord { judgment(for: word) }
        case .spelling:
            if let word = session.currentWord { spelling(for: word) }
        case .finished:
            VStack(spacing: 12) {
                Text(finishTitle).font(.headline)
                Button(finishLabel, action: onFinish)
            }
        }
    }

    private func judgment(for word: MiniWord) -> some View {
        VStack(spacing: 12) {
            Text(word.spelling)
                .font(.system(size: 35, weight: .semibold, design: .serif))
                .accessibilityIdentifier("reviewEnglish")

            if session.currentJudgment != nil {
                Text(word.meaning.isEmpty ? "暂无中文释义" : word.meaning)
                    .accessibilityIdentifier("reviewMeaning")
                example(for: word)
                HStack(spacing: 8) {
                    Button("记错了") { session.advanceJudgment(markWrong: true) }
                    Button("下一个") { session.advanceJudgment() }
                }
            } else {
                HStack(spacing: 8) {
                    Button("遗忘") { session.chooseJudgment(.forgotten) }
                    Button("模糊") { session.chooseJudgment(.fuzzy) }
                    Button("清晰") { session.chooseJudgment(.clear) }
                }
            }
        }
    }

    @ViewBuilder
    private func example(for word: MiniWord) -> some View {
        if let sentence = sentenceForWord(word) {
            VStack(spacing: 3) {
                Text(sentence.english).font(.callout)
                Text(sentence.chinese).font(.caption).foregroundStyle(.secondary)
            }
            .textSelection(.enabled)
            .accessibilityIdentifier("studyExample")
        }
    }

    private func spelling(for word: MiniWord) -> some View {
        let correcting = session.spellingState == .correcting

        return VStack(spacing: 9) {
            Text(word.meaning)
                .font(.title3)
                .accessibilityIdentifier("reviewSpellingPrompt")

            VStack(spacing: 2) {
                ReviewAnswerField(
                    text: $session.spellingDraft,
                    selectOnFocus: correcting && session.lastSpellingAttempt?.answer == session.spellingDraft,
                    onSubmit: submitSpelling
                )
                .frame(height: 30)
                Divider()
            }
            .frame(width: 206)

            if correcting {
                Text(word.spelling)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("正确拼写 \(word.spelling)")
                    .accessibilityIdentifier("reviewExpectedSpelling")
            }
        }
    }

    /// Returns true when the rejected answer should stay selected for editing.
    private func submitSpelling(_ answer: String) -> Bool {
        var updated = session
        guard updated.submitSpelling(answer) else { return false }
        let shouldSelectAnswer = updated.spellingState == .correcting
        if updated.spellingState == .readyToAdvance { updated.advanceSpelling() }
        session = updated
        return shouldSelectAnswer
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

private struct ReviewAnswerField: NSViewRepresentable {
    @Binding var text: String
    let selectOnFocus: Bool
    let onSubmit: (String) -> Bool

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> AnswerTextField {
        let field = AnswerTextField()
        field.delegate = context.coordinator
        field.isBordered = false
        field.isBezeled = false
        field.drawsBackground = false
        field.isEditable = true
        field.isSelectable = true
        field.focusRingType = .none
        field.maximumNumberOfLines = 1
        field.cell?.usesSingleLineMode = true
        field.cell?.isScrollable = true
        field.alignment = .center
        field.font = .systemFont(ofSize: 21, weight: .medium)
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
        field.selectOnFocus = selectOnFocus
        if let editor = field.currentEditor() as? NSTextView {
            guard !editor.hasMarkedText(), editor.string != text else { return }
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
            owner.text = editor.string
        }

        func control(_ control: NSControl, textView: NSTextView, doCommandBy command: Selector) -> Bool {
            guard command == #selector(NSResponder.insertNewline(_:)), !textView.hasMarkedText() else {
                return false
            }
            if owner.onSubmit(textView.string) {
                textView.setSelectedRange(NSRange(location: 0, length: textView.string.utf16.count))
            }
            return true
        }
    }
}

private final class AnswerTextField: NSTextField {
    var selectOnFocus = false

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        guard window != nil else { return }
        DispatchQueue.main.async { [weak self] in
            guard let self, let window, window.makeFirstResponder(self),
                  let editor = currentEditor() as? NSTextView else { return }
            let length = editor.string.utf16.count
            editor.setSelectedRange(selectOnFocus
                ? NSRange(location: 0, length: length)
                : NSRange(location: length, length: 0))
        }
    }
}
