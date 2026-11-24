import SwiftUI

struct MiniModelSettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var draft: MiniAISelection
    @State private var runtime: MiniChatRuntime?
    @State private var loading = false
    @State private var loadingError: String?

    let load: () async throws -> MiniChatRuntime
    let apply: (MiniAISelection) -> Void

    init(selection: MiniAISelection, load: @escaping () async throws -> MiniChatRuntime,
         apply: @escaping (MiniAISelection) -> Void) {
        _draft = State(initialValue: selection)
        self.load = load
        self.apply = apply
    }

    private var chosenModel: MiniChatModel? { runtime?.models.first { $0.id == draft.model } }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("AI 设置").font(.headline)
                Spacer()
                if loading { ProgressView().controlSize(.small) }
                Button("刷新模型列表", systemImage: "arrow.clockwise") {
                    Task { await refresh() }
                }
                .labelStyle(.iconOnly).buttonStyle(.borderless).disabled(loading)
                .help("刷新模型列表")
            }
            Text("模型").font(.subheadline.weight(.semibold))
            ScrollViewReader { scroll in
                ScrollView {
                    VStack(spacing: 1) {
                        if chosenModel == nil {
                            option(draft.model, selected: true, action: {}).disabled(true)
                        }
                        ForEach(runtime?.models ?? []) { model in
                            option(model.name, selected: model.id == draft.model) { draft.model = model.id }
                                .help(model.id).id(model.id)
                        }
                    }
                }
                .onChange(of: runtime?.models.map(\.id)) { _, _ in scroll.scrollTo(draft.model) }
            }
            .frame(height: 99)
            HStack {
                Text("推理强度").font(.subheadline.weight(.semibold))
                if chosenModel?.efforts.contains(draft.effort) != true {
                    Text(draft.effort).font(.caption).foregroundStyle(.secondary)
                }
            }
            if let efforts = chosenModel?.efforts, !efforts.isEmpty {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 78))], alignment: .leading, spacing: 2) {
                    ForEach(efforts, id: \.self) { value in
                        option(value, selected: draft.effort == value) { draft.effort = value }
                    }
                }
            }
            if let issue = loadingError ?? runtime?.selectionIssue(draft) {
                Text(issue).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Divider()
            HStack {
                Spacer()
                Button("取消") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("应用") { apply(draft); dismiss() }.keyboardShortcut(.defaultAction)
                    .disabled(loading || loadingError != nil || runtime == nil || runtime?.selectionIssue(draft) != nil)
            }
        }
        .padding(16)
        .frame(width: 338)
        .task { await refresh() }
    }

    private func option(_ title: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(selected ? Color.accentColor : .secondary)
                Text(title).lineLimit(1)
            }
            .font(.callout)
            .padding(.vertical, 4).padding(.horizontal, 4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func refresh() async {
        guard !loading else { return }
        loading = true
        loadingError = nil
        defer { loading = false }
        do {
            let current = try await load()
            try Task.checkCancellation()
            runtime = current
        } catch is CancellationError {
            return
        } catch { loadingError = error.localizedDescription }
    }
}
