import SwiftUI

struct MiniDictationPracticeView: View {
    let practice: MiniDictation
    @Binding var draft: String
    let submit: (String) -> Void
    let reveal: () -> Void
    let close: () -> Void
    @State private var hiddenAttemptCount = 0
    @State private var showingReference = false
    @State private var focusRequest = 0
    @Environment(\.miniStudyAppearance) private var appearance

    private var attempt: MiniDictationAttempt? {
        practice.attempts.count > hiddenAttemptCount ? practice.attempts.last : nil
    }
    private var accepted: Bool { attempt?.correct == true }
    private var incorrect: Bool { attempt?.correct == false && attempt?.answer == draft }

    var body: some View {
        VStack(spacing: 8) {
            HStack {
                Text("Scratchpad").font(.caption).foregroundStyle(.secondary)
                    .accessibilityLabel("草稿拼写")
                Spacer()
                MiniStudyIconButton(title: "退出拼写", systemImage: "xmark", action: close)
                    .font(.caption)
                    .accessibilityIdentifier("closeScratchpad")
            }
            GeometryReader { area in
                ScrollView {
                    VStack(spacing: 12) {
                        Text(practice.word.meaning).font(.title3).multilineTextAlignment(.center)
                        VStack(spacing: 2) {
                            ReviewAnswerField(text: $draft, selectOnFocus: attempt?.correct == false,
                                onSubmit: { answer in
                                    if accepted { repeatSpelling() } else { submitAnswer(answer) }
                                    return false
                                }, accepted: accepted, incorrect: incorrect, focusRequest: focusRequest)
                                .frame(height: 30)
                                .accessibilityIdentifier("singleCardAnswer")
                            Divider()
                        }.frame(width: 206)
                        let referenceVisible = attempt?.correct == false || showingReference
                        ZStack {
                            Text(practice.word.spelling).font(.callout).foregroundStyle(.secondary)
                                .opacity(referenceVisible ? 1 : 0)
                                .accessibilityHidden(!referenceVisible)
                                .accessibilityIdentifier("singleCardRevealedAnswer")
                            if appearance.isSimple, accepted, !referenceVisible {
                                Image(systemName: "checkmark.circle").foregroundStyle(.secondary)
                                    .accessibilityLabel("拼写正确")
                            }
                        }.frame(height: 18)
                        HStack(spacing: 12) {
                            if accepted || showingReference {
                                MiniStudyIconButton(title: "再拼一次", systemImage: "arrow.clockwise", action: repeatSpelling)
                                    .accessibilityIdentifier("repeatScratchpad")
                            } else {
                                MiniStudyIconButton(title: "比对", systemImage: "checkmark", prominent: true) { submitAnswer() }
                                    .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                                MiniStudyIconButton(title: "看答案", systemImage: "eye") {
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
        .accessibilityIdentifier("singleCardPractice")
        .onChange(of: practice.attempts.count) { _, count in
            hiddenAttemptCount = min(count, hiddenAttemptCount)
        }
    }

    private func submitAnswer(_ answer: String? = nil) {
        let value = answer ?? draft
        guard !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        submit(value)
    }

    private func repeatSpelling() {
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
    @Environment(\.miniStudyAppearance) private var appearance
    private var cards: [MiniMemoryCard] { scheduling?.orderedCards.filter { MiniProbePrompt.text(for: $0.word) != nil } ?? [] }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label("Spelling check", systemImage: "pencil.line").font(.headline)
                    .accessibilityLabel("独立拼写检验")
                Spacer(minLength: 4)
                let active = scheduling?.activeProbe != nil
                MiniStudyIconButton(title: active ? "退出检验" : "返回", systemImage: active ? "xmark" : "arrow.left",
                                    action: close).font(.caption)
            }
            Divider()
            if let probe = scheduling?.activeProbe {
                ScrollView {
                    attempt(probe)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                }
            } else if !cards.isEmpty {
                HStack {
                    Text("Word")
                    Spacer()
                    Text("Suggested time")
                }
                .font(.caption).foregroundStyle(.secondary)
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(cards.prefix(20)) { card in
                            Button { begin(card.word) } label: {
                                HStack(spacing: 6) {
                                    Text(MiniProbePrompt.text(for: card.word) ?? "")
                                        .multilineTextAlignment(.leading)
                                    Spacer(minLength: 3)
                                    Text(card.suggestedProbeAt, style: .relative)
                                        .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                                        .environment(\.locale, Locale(identifier: "en_US"))
                                    Image(systemName: "chevron.right")
                                        .font(.caption2).foregroundStyle(.tertiary).accessibilityHidden(true)
                                }
                                .padding(.vertical, 7).contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            Divider()
                        }
                    }
                }
            } else {
                Text("No words available")
                    .font(.callout).foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .disabled(saving)
        .accessibilityIdentifier("independentSpellingProbe")
    }

    private func attempt(_ probe: MiniProbe) -> some View {
        VStack(spacing: 10) {
            Text(MiniProbePrompt.text(for: probe.word) ?? "No clue available").font(.title3).multilineTextAlignment(.center)
                .accessibilityIdentifier("independentProbePrompt")
            if probe.status == .active, MiniProbePrompt.text(for: probe.word) != nil {
                ReviewAnswerField(text: $draft, selectOnFocus: false, onSubmit: { answer in submitAnswer(answer); return false })
                    .frame(height: 32)
                    .accessibilityIdentifier("independentProbeAnswer")
                MiniStudyIconButton(title: "提交", systemImage: "arrow.up", prominent: true) { submitAnswer() }
                    .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            if let answer = probe.answer {
                Text(answer).font(.callout).textSelection(.enabled)
                    .accessibilityLabel("你的答案 \(answer)")
            }
            if let correct = probe.correct {
                Image(systemName: correct ? "checkmark.circle" : "arrow.counterclockwise")
                    .font(.callout).foregroundStyle(correct && !appearance.isSimple ? Color.green : .secondary)
                    .accessibilityLabel(correct ? "拼写正确" : "拼写需要调整")
            }
            if let classification = probe.classification {
                Text(classificationTitle(classification))
                    .font(.callout.weight(.medium)).accessibilityLabel(classification.label)
                if let due = probe.dueAt, probe.rating != nil {
                    let date = due.formatted(.dateTime.month().day().hour().minute().locale(Locale(identifier: "en_US")))
                    Text("Next check \(date)")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            if probe.revealedAt != nil {
                Text(probe.word.spelling).font(.title2.weight(.semibold)).textSelection(.enabled)
                    .accessibilityIdentifier("independentProbeRevealedAnswer")
            } else {
                MiniStudyIconButton(title: "揭晓答案", systemImage: "eye", action: reveal).font(.caption)
            }
            if probe.status == .answered {
                MiniStudyIconButton(title: "完成这一词", systemImage: "checkmark", prominent: true, action: end)
            }
        }
    }

    private func submitAnswer(_ answer: String? = nil) {
        let value = answer ?? draft
        guard !saving, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        submit(value)
    }

    private func classificationTitle(_ classification: MiniMeasurementClassification) -> String {
        switch classification {
        case .pendingReview: "Pending"
        case .unmeasured: "No attempt"
        case .supported: "Used a hint"
        case .tooSoon: "Try again later"
        case .independentSuccess: "Recalled without hints"
        case .independentFailure: "Needs more practice"
        }
    }
}
