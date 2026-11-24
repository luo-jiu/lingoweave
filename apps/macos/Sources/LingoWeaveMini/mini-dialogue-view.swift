import SwiftUI

struct MiniDialogueView: View {
    let snapshot: MiniAISnapshot?
    let busy: Bool
    let error: String?
    let client: MiniPatternClient
    let draft: (String) -> Binding<String>
    let start: (String, String?, Bool) -> Void
    let control: (MiniAIJob, Bool) -> Void
    let reconnect: () -> Void
    let patterns: () -> Void
    @State private var selected: String?
    @State private var eligible: Bool?
    @State private var loadError = false
    @FocusState private var focused: Bool
    @Environment(\.miniStudyAppearance) private var appearance

    private var scenes: [MiniAIConversation] {
        guard let snapshot else { return [] }
        let ids = Set(snapshot.jobs.lazy.filter { $0.kind == .dialogue }.map(\.conversationId))
        return snapshot.conversations.filter { ids.contains($0.id) }
    }
    private var conversationId: String? { selected ?? scenes.last?.id }
    private var messages: [MiniAIMessage] {
        snapshot?.messages.filter { $0.conversationId == conversationId } ?? []
    }
    private var latest: MiniAIJob? {
        snapshot?.jobs.last { $0.kind == .dialogue && $0.conversationId == conversationId }
    }
    private var closed: Bool { latest?.dialogueStep == "reflect" && latest?.status == .completed }
    private var canStart: Bool { !busy && snapshot?.imported == true && eligible == true }
    private var canReply: Bool { !busy && latest?.status == .completed && !closed }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label("Dialogue", systemImage: "bubble.left.and.bubble.right").font(.headline)
                Spacer(minLength: 4)
                if !scenes.isEmpty {
                    Menu {
                        ForEach(Array(scenes.reversed())) { scene in
                            let first = snapshot?.messages.first { $0.conversationId == scene.id && $0.role == .assistant }
                            let title = first.map { String($0.text.prefix(36)) } ?? scene.title
                            Button { selected = scene.id } label: {
                                if conversationId == scene.id { Label(title, systemImage: "checkmark") }
                                else { Text(title) }
                            }
                        }
                    } label: { Image(systemName: "clock.arrow.circlepath") }
                    .menuStyle(.borderlessButton).fixedSize().controlSize(.small)
                    .help("场景记录").accessibilityLabel("场景记录")
                    if !closed {
                        MiniStudyIconButton(title: "开始新场景", systemImage: "square.and.pencil", action: newScene)
                            .disabled(!canStart || latest?.status.isActive == true)
                    }
                }
            }
            Divider()
            if let id = conversationId, latest != nil || !messages.isEmpty {
                ScrollViewReader { proxy in
                    ScrollView {
                        VStack(alignment: .leading, spacing: 8) {
                            ForEach(messages) { message in
                                utterance(message.text, mine: message.role == .user)
                            }
                            if let job = latest, job.status.isActive {
                                if !job.text.isEmpty { utterance(job.text, mine: false) }
                                HStack {
                                    ProgressView().controlSize(.mini)
                                    MiniStudyIconButton(title: "停止", systemImage: "stop") { control(job, false) }
                                }
                            } else if let job = latest, job.status != .completed {
                                if let issue = job.error { Text(issue).font(.caption).foregroundStyle(.secondary) }
                                MiniStudyIconButton(title: "重试", systemImage: "arrow.clockwise") { control(job, true) }
                                    .disabled(busy)
                            }
                            Color.clear.frame(height: 1).id("dialogue-end")
                        }.frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .defaultScrollAnchor(.bottom)
                    .onChange(of: conversationId) { _, _ in proxy.scrollTo("dialogue-end", anchor: .bottom) }
                    .onChange(of: messages.count) { _, _ in proxy.scrollTo("dialogue-end", anchor: .bottom) }
                }
                if closed || latest == nil {
                    Button("New scene", action: newScene)
                        .miniStudyButton(prominent: true).disabled(!canStart)
                        .frame(maxWidth: .infinity, alignment: .trailing)
                } else {
                    let input = draft(id)
                    if canReply && messages.contains(where: { $0.role == .user }) {
                        Button("Finish & review") { start(id, nil, true) }
                            .miniStudyButton().font(.caption)
                            .frame(maxWidth: .infinity, alignment: .trailing)
                    }
                    HStack {
                        TextField("Reply in English…", text: input).textFieldStyle(.roundedBorder).focused($focused)
                            .onSubmit { reply(input.wrappedValue, id: id) }
                        MiniStudyIconButton(title: "发送英文回复", systemImage: "arrow.up", prominent: true) {
                            reply(input.wrappedValue, id: id)
                        }
                            .disabled(!canReply || input.wrappedValue.count > 8_000 ||
                                      input.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
            } else {
                Spacer()
                HStack {
                    Spacer()
                    if busy && selected != nil {
                        ProgressView().controlSize(.small).accessibilityLabel("等待场景")
                    } else if loadError {
                        MiniStudyIconButton(title: "重新读取句式", systemImage: "arrow.clockwise") { Task { await load() } }
                    } else if eligible == false {
                        Button("Practice a pattern", action: patterns).miniStudyButton()
                    } else {
                        Button("Start", action: newScene)
                            .miniStudyButton(prominent: true).disabled(!canStart)
                    }
                    Spacer()
                }
                Spacer()
            }
            if let error {
                Text(error).font(.caption).foregroundStyle(.secondary)
                MiniStudyIconButton(title: "重新连接", systemImage: "arrow.clockwise", action: reconnect)
            }
        }
        .task { await load() }
        .onChange(of: canReply) { _, ready in if ready { focused = true } }
    }

    private func utterance(_ text: String, mine: Bool) -> some View {
        VStack(alignment: mine ? .trailing : .leading, spacing: 3) {
            Text(mine ? "You" : "AI").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
            Text(text).textSelection(.enabled)
                .padding(.horizontal, mine ? 9 : 0).padding(.vertical, mine ? 5 : 0)
                .background(mine ? (appearance.isSimple ? Color.primary : .accentColor).opacity(0.09) : .clear,
                            in: RoundedRectangle(cornerRadius: 7))
        }
        .padding(mine ? .leading : .trailing, 20)
        .frame(maxWidth: .infinity, alignment: mine ? .trailing : .leading)
    }

    private func load() async {
        do { eligible = try await client.batch().canDialogue; loadError = false }
        catch { loadError = true }
    }
    private func newScene() {
        guard canStart else { return }
        let id = "dialogue:" + UUID().uuidString.lowercased()
        selected = id
        start(id, nil, false)
    }
    private func reply(_ text: String, id: String) {
        let message = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canReply, !message.isEmpty, message.count <= 8_000 else { return }
        start(id, message, false)
    }
}
