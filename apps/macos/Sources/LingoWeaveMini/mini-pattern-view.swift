import SwiftUI

struct MiniPatternView: View {
    var client: MiniPatternClient
    var automatic: Bool
    var muted: Bool
    var volume: Double
    var windowVisible: Bool
    var close: () -> Void
    var dialogue: () -> Void
    @Environment(\.miniStudyAppearance) private var appearance
    @State private var batch: MiniPatternBatch?
    @State private var exercise = false
    @State private var answer = ""
    @State private var reference: String?
    @State private var lastAnswer: String?
    @State private var usedHint = false
    @State private var busy = false
    @State private var error: String?
    @State private var pending: MiniPatternSubmission?
    @StateObject private var voice = MiniPatternVoice()
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Image(systemName: "text.quote").font(.headline)
                    .accessibilityLabel("起手句式")
                Spacer()
                if let batch, !batch.batch.isEmpty {
                    Text("\(batch.level) · \(batch.completedIds.count)/\(batch.batch.count)")
                        .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                }
            }
            if let batch, !batch.batch.isEmpty {
                ProgressView(value: Double(batch.completedIds.count), total: Double(batch.batch.count))
                    .progressViewStyle(.linear)
                    .tint(appearance.isSimple ? Color.secondary : Color(nsColor: .systemTeal))
                    .controlSize(.small)
                    .accessibilityLabel("本批句式")
            } else { Divider() }
            if let pattern = batch?.next {
                ScrollView {
                    VStack(alignment: .leading, spacing: 8) {
                        if exercise {
                            Text(pattern.cue).font(.title3.weight(.medium)).textSelection(.enabled)
                            Text(pattern.substitution).foregroundStyle(.secondary)
                            TextField("Type here…", text: $answer)
                                .focused($focused).textFieldStyle(.roundedBorder)
                                .onSubmit { submit(pattern) }
                                .accessibilityLabel("用英语写一句")
                            if let reference {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text("Reference").font(.caption).foregroundStyle(.secondary)
                                    Text(reference).font(.callout).textSelection(.enabled)
                                }
                            }
                        } else {
                            Text(pattern.frame)
                                .font(.system(.title2, design: .serif).weight(.semibold))
                                .textSelection(.enabled)
                                .onChange(of: windowVisible ? pattern.id : nil, initial: true) { _, visibleId in
                                    guard let visibleId, let batch else { return }
                                    Task { try? await client.recordView(batchId: batch.batchId, patternId: visibleId) }
                                }
                            Text(pattern.meaning).font(.callout).foregroundStyle(.secondary)
                            HStack(alignment: .top, spacing: 8) {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(pattern.example).font(.body.weight(.medium)).textSelection(.enabled)
                                    Text(pattern.translation).font(.callout).foregroundStyle(.secondary)
                                        .miniTranslationPrivacy()
                                }
                                Spacer(minLength: 0)
                                MiniStudyIconButton(title: "朗读例句", systemImage: "speaker.wave.2") {
                                    voice.read(pattern.example)
                                }
                                .disabled(muted)
                            }
                            .padding(9)
                            .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 7))
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }
                HStack {
                    closeButton
                    Spacer()
                    if exercise {
                        if let lastAnswer, reference != nil {
                            MiniStudyIconButton(title: "看过后继续", systemImage: "arrow.right") {
                                submit(pattern, previous: lastAnswer)
                            }
                        }
                        MiniStudyIconButton(title: "提交", systemImage: "arrow.up", prominent: true) { submit(pattern) }
                            .disabled(answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || answer.count > 800)
                    } else {
                        MiniStudyIconButton(title: "换个词试试", systemImage: "pencil", prominent: true) {
                            voice.stop()
                            exercise = true
                        }
                    }
                }.disabled(busy)
            } else if let batch {
                Spacer()
                Text(batch.batch.isEmpty ? "Level complete" : "Set complete")
                    .font(.headline).frame(maxWidth: .infinity)
                Text("\(batch.practicedCount)/\(batch.totalCount)")
                    .font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity)
                    .accessibilityLabel("已练过 \(batch.practicedCount) 个，共 \(batch.totalCount) 个")
                Spacer()
                HStack {
                    if automatic {
                        MiniStudyIconButton(title: "英文对话", systemImage: "bubble.left.and.bubble.right", action: dialogue)
                            .disabled(!batch.canDialogue)
                        Spacer()
                        Button("Start words", action: close)
                            .miniStudyButton(prominent: true)
                            .help("开始学词")
                            .accessibilityLabel("开始学词")
                    } else {
                        closeButton
                        Spacer()
                        MiniStudyIconButton(title: "英文对话", systemImage: "bubble.left.and.bubble.right",
                                            prominent: true, action: dialogue)
                            .disabled(!batch.canDialogue)
                    }
                }
            } else {
                Spacer()
                if error == nil { ProgressView().controlSize(.small).frame(maxWidth: .infinity) }
                Spacer()
                HStack {
                    closeButton
                    if error != nil {
                        MiniStudyIconButton(title: "重试", systemImage: "arrow.clockwise") { Task { await load() } }
                    }
                }
            }
            if let error = error ?? voice.error { Text(error).font(.caption).foregroundStyle(.secondary) }
        }
        .task { await load() }
        .onChange(of: exercise) { _, value in focused = value }
        .onChange(of: muted) { _, value in if value { voice.stop() } }
        .onChange(of: volume, initial: true) { _, value in voice.setVolume(value) }
        .onDisappear { voice.stop() }
    }

    @ViewBuilder
    private var closeButton: some View {
        if automatic {
            Button("Skip", action: close)
                .miniStudyButton()
                .help("先学单词")
                .accessibilityLabel("先学单词")
        } else {
            MiniStudyIconButton(title: "返回", systemImage: "arrow.left", action: close)
        }
    }

    private func load() async {
        error = nil
        do {
            let value = try await client.batch()
            guard !Task.isCancelled else { return }
            batch = value
            if automatic, value.next == nil { close() }
        }
        catch { self.error = "Unable to load." }
    }

    private func submit(_ pattern: MiniSentencePattern, previous: String? = nil) {
        let text = (previous ?? answer).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !busy, !text.isEmpty, text.count <= 800, let batch else { return }
        let retry = pending.flatMap {
            $0.answer == text && $0.patternId == pattern.id && $0.continueAfterFeedback == (previous != nil) ? $0 : nil
        }
        let payload = retry ?? MiniPatternSubmission(batchId: batch.batchId, patternId: pattern.id,
            answer: text, usedHint: usedHint, continueAfterFeedback: previous != nil)
        pending = payload
        busy = true; error = nil
        Task {
            defer { busy = false }
            do {
                let result = try await client.practice(payload)
                pending = nil
                self.batch = result.snapshot
                if result.snapshot.completedIds.contains(pattern.id) || result.snapshot.next?.id != pattern.id {
                    answer = ""; exercise = false; reference = nil; usedHint = false; lastAnswer = nil
                } else {
                    reference = result.reference; lastAnswer = text; usedHint = true
                    focused = true
                }
            } catch MiniStudyClientError.conflict {
                pending = nil; answer = ""; exercise = false; reference = nil; usedHint = false; lastAnswer = nil
                await load()
            } catch { self.error = error.localizedDescription }
        }
    }
}
