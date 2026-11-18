import SwiftUI

struct MiniDictationPracticeView: View {
    let practice: MiniDictation
    @Binding var draft: String
    let saving: Bool
    let submit: (String) -> Void
    let reveal: () -> Void
    let close: () -> Void
    var playWord: (MiniWord) -> Void = { _ in }
    @State private var hiddenAttemptCount = 0
    @State private var showingReference = false
    @State private var focusRequest = 0

    private var attempt: MiniDictationAttempt? {
        practice.attempts.count > hiddenAttemptCount ? practice.attempts.last : nil
    }
    private var accepted: Bool { attempt?.correct == true }
    private var incorrect: Bool { attempt?.correct == false && attempt?.answer == draft }

    var body: some View {
        VStack(spacing: 8) {
            HStack {
                Text("草稿拼写").font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button("退出拼写", action: close).font(.caption)
                    .accessibilityIdentifier("closeScratchpad")
            }
            GeometryReader { area in
                ScrollView {
                    VStack(spacing: 12) {
                        Text(practice.word.meaning).font(.title3).multilineTextAlignment(.center)
                        VStack(spacing: 2) {
                            ReviewAnswerField(text: $draft, selectOnFocus: attempt?.correct == false,
                                onSubmit: { answer in
                                    guard !saving else { return false }
                                    if accepted { repeatSpelling() } else { submitAnswer(answer) }
                                    return false
                                }, accepted: accepted, incorrect: incorrect, inputLocked: saving, focusRequest: focusRequest)
                                .frame(height: 30)
                                .accessibilityIdentifier("singleCardAnswer")
                            Divider()
                        }.frame(width: 206)
                        let referenceVisible = attempt?.correct == false || showingReference
                        Text(practice.word.spelling).font(.callout).foregroundStyle(.secondary)
                            .frame(height: 18)
                            .opacity(referenceVisible ? 1 : 0)
                            .accessibilityHidden(!referenceVisible)
                            .accessibilityIdentifier("singleCardRevealedAnswer")
                        HStack(spacing: 12) {
                            if accepted || showingReference {
                                Button("再拼一次", action: repeatSpelling)
                                    .accessibilityIdentifier("repeatScratchpad")
                            } else {
                                Button("比对") { submitAnswer() }
                                    .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                                Button("看答案") {
                                    guard !saving else { return }
                                    showingReference = true
                                    reveal()
                                }
                            }
                        }.font(.caption).frame(height: 28)
                    }
                    .frame(maxWidth: .infinity, minHeight: area.size.height)
                }
            }
        }
        .allowsHitTesting(!saving)
        .accessibilityIdentifier("singleCardPractice")
        .onChange(of: practice.attempts.last?.id) { previous, current in
            if let current, current != previous { playWord(practice.word) }
        }
    }

    private func submitAnswer(_ answer: String? = nil) {
        let value = answer ?? draft
        guard !saving, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        submit(value)
    }

    private func repeatSpelling() {
        guard !saving else { return }
        hiddenAttemptCount = practice.attempts.count
        showingReference = false
        draft = ""
        focusRequest += 1
    }
}

struct MiniIndependentProbeView: View {
    let scheduling: MiniSchedulingSnapshot?
    @Binding var draft: String
    let saving: Bool
    let begin: (MiniWord) -> Void
    let submit: (String) -> Void
    let reveal: () -> Void
    let end: () -> Void
    let close: () -> Void
    private var cards: [MiniMemoryCard] { scheduling?.orderedCards.filter { MiniProbePrompt.text(for: $0.word) != nil } ?? [] }

    var body: some View {
        ScrollView {
            VStack(spacing: 10) {
                HStack {
                    Text("独立拼写检验").font(.headline)
                    Spacer(minLength: 4)
                    Button(scheduling?.activeProbe == nil ? "返回" : "退出检验", action: close)
                    .font(.caption)
                }
                if let probe = scheduling?.activeProbe {
                    attempt(probe)
                } else if !cards.isEmpty {
                    Text("按中文回忆英文拼写").font(.caption).foregroundStyle(.secondary)
                    ForEach(cards.prefix(20)) { card in
                        Button { begin(card.word) } label: {
                            HStack {
                                Text(MiniProbePrompt.text(for: card.word) ?? "").multilineTextAlignment(.leading)
                                Spacer(minLength: 5)
                                Text(card.dueAt, style: .relative).font(.caption2).foregroundStyle(.secondary)
                            }
                            .padding(.vertical, 4)
                        }
                        .buttonStyle(.borderless)
                    }
                } else {
                    Text("有中文释义的学习词卡会出现在这里。").font(.callout).foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
            }
            .padding(.vertical, 6)
        }
        .disabled(saving)
        .accessibilityIdentifier("independentSpellingProbe")
    }

    private func attempt(_ probe: MiniProbe) -> some View {
        VStack(spacing: 10) {
            Text(MiniProbePrompt.text(for: probe.word) ?? "暂无可用的中文提示").font(.title3).multilineTextAlignment(.center)
                .accessibilityIdentifier("independentProbePrompt")
            if probe.status == .active, MiniProbePrompt.text(for: probe.word) != nil {
                ReviewAnswerField(text: $draft, selectOnFocus: false, onSubmit: { answer in submitAnswer(answer); return false })
                    .frame(height: 32)
                    .accessibilityIdentifier("independentProbeAnswer")
                Button("提交") { submitAnswer() }
                    .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            if let answer = probe.answer {
                Text("你的答案 \(answer)").font(.callout).textSelection(.enabled)
            }
            if let correct = probe.correct {
                Label(correct ? "拼写正确" : "拼写需要调整", systemImage: correct ? "checkmark.circle" : "arrow.counterclockwise")
                    .font(.callout).foregroundStyle(correct ? .green : .secondary)
            }
            if let classification = probe.classification {
                Text(classification.label).font(.callout.weight(.medium))
                if let due = probe.dueAt, probe.rating != nil {
                    Text("下次检验 \(due.formatted(.dateTime.month().day().hour().minute()))")
                        .font(.caption).foregroundStyle(.secondary)
                }
                if classification == .tooSoon {
                    Text("稍后再检验，期间可以学习其他词。").font(.caption).foregroundStyle(.secondary)
                }
            }
            if probe.revealedAt != nil {
                Text(probe.word.spelling).font(.title2.weight(.semibold)).textSelection(.enabled)
                    .accessibilityIdentifier("independentProbeRevealedAnswer")
            } else {
                Button("揭晓答案", action: reveal).font(.caption)
            }
            if probe.status == .answered { Button("完成这一词", action: end) }
        }
    }

    private func submitAnswer(_ answer: String? = nil) {
        let value = answer ?? draft
        guard !saving, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        submit(value)
    }
}
