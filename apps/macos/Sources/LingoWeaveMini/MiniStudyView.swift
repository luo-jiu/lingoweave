import AppKit
import SwiftUI

struct MiniStudyView: View {
    @Binding var isPinned: Bool
    @AppStorage("wordIndex") private var storedIndex = 0
    @AppStorage("customWordList") private var customWordList = ""
    @AppStorage("chatModel") private var modelID = ""
    @AppStorage("chatEffort") private var effort = ""
    @AppStorage("studyLevel") private var studyLevel = "A2"
    @State private var showingHome = true
    @State private var mode: Mode = .words
    @State private var tabWidth: CGFloat = 90
    @State private var titleActionsWidth: CGFloat = 110
    @State private var revealed = false
    @State private var editingList = false
    @State private var listDraft = ""
    @State private var listError: String?
    @State private var chats: [MiniWord: [MiniChatMessage]] = [:]
    @State private var drafts: [MiniWord: String] = [:]
    @State private var errors: [MiniWord: String] = [:]
    @State private var pendingWord: MiniWord?
    @State private var models: [MiniChatModel] = []
    @State private var loadingModels = false
    @State private var modelsError: String?
    @State private var reviewRecord: MiniReviewRecord?
    @State private var reviewLoaded = false
    @State private var reviewError: String?
    @State private var browsingWords = false
    @State private var dailyLedger: MiniDailyLedger?
    @State private var activeDailyID: String?
    @State private var dailyError: String?
    @State private var preparationDay: String?
    @State private var preparationError: String?
    @State private var gradingAttempt: UUID?
    @State private var gradingError: String?
    @State private var chatArchiveError: String?
    @FocusState private var chatFocused: Bool
    private let reviewStorage = MiniReviewStorage()
    private let dailyStorage = MiniDailyStorage()
    private let chatStorage = MiniChatStorage()

    private enum Mode: String, CaseIterable {
        case words = "词卡"
        case chat = "AI 聊天"
    }

    private var words: [MiniWord] {
        let custom = MiniWord.parseList(customWordList)
        return custom.isEmpty ? MiniWord.starter : custom
    }

    private var chosenModel: MiniChatModel? { models.first { $0.id == modelID } }
    private var dailyDay: MiniDailyDay? { dailyLedger?.days.last { $0.id == activeDailyID } }

    private var showingReview: Bool {
        reviewRecord.map { !$0.continuedToLearning } ?? false
    }

    private var stageLabel: String {
        if let record = reviewRecord, showingReview {
            if record.paused { return "复习 · 暂停" }
            switch record.session.phase {
            case .judgment: return "复习 · 判断"
            case .spelling: return "复习 · 拼写"
            case .finished: return "复习 · 完成"
            }
        }
        if browsingWords { return "浏览词表" }
        guard let day = dailyDay else { return "每日学习" }
        if day.paused { return "已暂停" }
        switch day.phase {
        case .review:
            switch day.review?.phase {
            case .spelling: return "复习 · 拼写"
            case .finished: return "复习 · 完成"
            default: return "复习 · 判断"
            }
        case .learning:
            if day.nextUnstudiedWord != nil { return "学习 · 新词" }
            return day.learning?.phase == .finished ? "学习 · 完成" : "学习 · 拼写"
        case .translation: return "语句 · 翻译"
        case .finished: return Calendar.current.isDateInToday(day.startedAt) ? "今日完成" : "已完成"
        }
    }

    private var studyingWord: MiniWord? {
        guard !browsingWords, !showingReview, let day = dailyDay else { return nil }
        switch day.phase {
        case .review: return day.review?.currentWord
        case .learning: return day.nextUnstudiedWord ?? day.learning?.currentWord
        case .translation: return day.currentTranslation?.sentence.word
        case .finished: return nil
        }
    }

    private var inJudgmentReview: Bool {
        showingReview || (!browsingWords && dailyDay?.phase == .review)
    }

    private var concealChatWord: Bool {
        guard !browsingWords, let day = dailyDay else { return false }
        return day.phase == .translation || (day.phase == .learning && day.nextUnstudiedWord == nil)
    }

    var body: some View {
        VStack(spacing: 0) {
            titleBar
            Divider()
            VStack(spacing: 8) {
                if showingHome {
                    MiniHomeView(day: dailyDay, ledger: dailyLedger, start: resumeStudy,
                                 error: dailyError, hasLegacyReview: showingReview)
                } else {
                    activeContent
                }
                if let error = reviewError ?? (showingHome || browsingWords ? nil : dailyError) {
                    Text(error)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .accessibilityAddTraits(.updatesFrequently)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .windowBackgroundColor))
        .tint(.primary)
        .miniWindowScrollbars()
        .onChange(of: modelID) { _, _ in effort = chosenModel?.defaultEffort ?? "" }
        .onAppear {
            restoreReview()
            restoreChats()
            beginDaily()
        }
        .onReceive(NotificationCenter.default.publisher(for: .NSCalendarDayChanged)) { _ in beginDaily() }
    }

    @ViewBuilder
    private var activeContent: some View {
        let deck = words
        let index = min(max(0, storedIndex), deck.count - 1)
        if mode == .chat {
            chat(for: studyingWord ?? deck[index])
                .task { if models.isEmpty { await refreshModels() } }
        } else if browsingWords && editingList {
            listEditor
        } else if let record = reviewRecord, showingReview {
            if record.paused {
                reviewPaused
            } else {
                MiniReviewView(
                    session: Binding(
                        get: { reviewRecord?.session ?? record.session },
                        set: { session in updateReview { $0.session = session } }
                    ),
                    onFinish: continueToLearning
                )
            }
        } else if browsingWords {
            flashcard(deck[index], index: index, count: deck.count)
        } else if let day = dailyDay {
            dailyContent(day)
        } else {
            VStack(spacing: 8) {
                Text(dailyError == nil ? "准备每日学习…" : "每日学习暂不可用")
                if dailyError != nil { Button("重试", action: beginDaily) }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func dailyContent(_ day: MiniDailyDay) -> some View {
        let continueToday: (() -> Void)? = Calendar.current.isDateInToday(day.startedAt) ? nil : { beginDaily() }
        return MiniDailyView(
            day: Binding(
                get: { dailyDay ?? day },
                set: { replacement in
                    guard replacement.id == dailyDay?.id else { return }
                    updateDaily { $0 = replacement; return true }
                }
            ),
            preparing: preparationDay == day.id,
            preparationError: preparationError,
            grading: gradingAttempt != nil,
            gradingError: gradingError,
            retryPreparation: { Task { await prepareDaily() } },
            gradeTranslation: { Task { await gradeDailyTranslation() } },
            continueToday: continueToday
        )
        .id(day.id)
    }

    private var titleBar: some View {
        GeometryReader { area in
            ZStack {
                ViewThatFits(in: .horizontal) {
                    Text("LingoWeave Mini")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.secondary)
                        .fixedSize()
                        .padding(.horizontal, max(76 + tabWidth, 8 + titleActionsWidth) + 6)
                    Color.clear
                }
                .accessibilityHidden(true)
                .allowsHitTesting(false)

                HStack(spacing: 4) {
                    modeTabs
                        .onGeometryChange(for: CGFloat.self, of: { $0.size.width }) { tabWidth = $0 }
                    MiniTitleDragRegion()
                        .frame(minWidth: 4, maxWidth: .infinity, maxHeight: .infinity)
                        .accessibilityHidden(true)
                    titleActions(compact: area.size.width < 330)
                        .onGeometryChange(for: CGFloat.self, of: { $0.size.width }) { titleActionsWidth = $0 }
                }
                .padding(.leading, 76)
                .padding(.trailing, 8)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(height: 32)
    }

    private func titleActions(compact: Bool) -> some View {
        HStack(spacing: 4) {
            Button {
                showingHome = true
                chatFocused = false
            } label: {
                Image(systemName: showingHome ? "house.fill" : "house")
                    .frame(width: 20, height: 24)
            }
            .accessibilityLabel(showingHome ? "首页" : "返回首页")
            .help("返回首页")
            .disabled(showingHome)

            reviewMenu(compact: compact)

            Button {
                isPinned.toggle()
            } label: {
                Image(systemName: isPinned ? "pin.fill" : "pin")
                    .frame(width: 20, height: 24)
            }
            .accessibilityLabel(isPinned ? "取消置顶" : "置顶")
            .help(isPinned ? "取消置顶" : "置顶")
        }
        .font(.system(size: 11, weight: .medium))
        .buttonStyle(.borderless)
    }

    private var modeTabs: some View {
        HStack(spacing: 1) {
            ForEach(Mode.allCases, id: \.self) { item in
                let selected = !showingHome && mode == item
                Button {
                    openMode(item)
                } label: {
                    Text(item.rawValue)
                        .font(.system(size: 10, weight: selected ? .semibold : .medium))
                        .lineLimit(1)
                        .padding(.horizontal, 7)
                        .frame(height: 18)
                        .contentShape(Rectangle())
                        .background(selected ? Color.primary.opacity(0.14) : .clear,
                                    in: RoundedRectangle(cornerRadius: 4))
                }
                .buttonStyle(.plain)
                .disabled(item == .chat && inJudgmentReview)
                .accessibilityAddTraits(selected ? .isSelected : [])
            }
        }
        .padding(1)
        .background(Color.primary.opacity(0.07), in: RoundedRectangle(cornerRadius: 5))
        .fixedSize()
        .accessibilityElement(children: .contain)
        .accessibilityLabel("模式")
    }

    private func openMode(_ item: Mode) {
        mode = item
        showingHome = false
        chatFocused = item == .chat
    }

    private func resumeStudy() {
        if dailyDay == nil || dailyDay?.phase == .finished {
            beginDaily()
        }
        browsingWords = false
        openMode(.words)
    }

    private func reviewMenu(compact: Bool) -> some View {
        Menu {
            if showingReview {
                if let record = reviewRecord, record.session.phase != .finished {
                    Button(record.paused ? "继续复习" : "暂停复习") {
                        updateReview { $0.paused.toggle() }
                    }
                } else {
                    Button("开始学习", action: continueToLearning)
                }
            } else if browsingWords {
                if !editingList {
                    Button("编辑词表") {
                        listDraft = customWordList
                        listError = nil
                        editingList = true
                        openMode(.words)
                    }
                }
                Button("返回每日学习", action: resumeStudy)
            } else {
                if let day = dailyDay, day.phase != .finished {
                    Button(day.paused ? "继续学习" : "暂停学习") {
                        updateDaily { $0.setPaused(!$0.paused) }
                    }
                } else {
                    Button("检查今日任务", action: beginDaily)
                }
                Picker("英语水平", selection: $studyLevel) {
                    ForEach(["A1", "A2", "B1", "B2", "C1", "C2"], id: \.self) { Text($0).tag($0) }
                }
                Divider()
                Button("浏览词表") {
                    browsingWords = true
                    openMode(.words)
                }
            }
        } label: {
            Text(compact ? stageLabel.components(separatedBy: " · ").last ?? stageLabel : stageLabel)
                .font(.system(size: 10, weight: .medium))
                .lineLimit(1)
        }
        .controlSize(.mini)
        .menuStyle(.borderlessButton)
        .fixedSize()
        .accessibilityLabel("当前阶段：\(stageLabel)")
    }

    private var reviewPaused: some View {
        VStack(spacing: 12) {
            Text("复习已暂停").font(.headline)
            Button("继续复习") { updateReview { $0.paused = false } }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func restoreReview() {
        guard !reviewLoaded else { return }
        reviewLoaded = true
        do {
            reviewRecord = try reviewStorage.load()
        } catch {
            reviewError = "读取复习记录失败。请先检查本机记录。"
        }
    }

    private func beginDaily() {
        do {
            let existing = try dailyLedger ?? dailyStorage.load()
            var updated = existing
            let day = updated.beginOrResume(deck: words)
            if updated != existing { try dailyStorage.save(updated) }
            if day.id != dailyDay?.id {
                preparationError = nil
                gradingError = nil
                if !browsingWords, day.phase == .review { mode = .words }
            }
            dailyLedger = updated
            activeDailyID = day.id
            dailyError = nil
            if !day.wordsToPrepare.isEmpty {
                Task { await prepareDaily() }
            }
        } catch {
            dailyError = "无法读取或保存每日任务，已有记录已保留。"
        }
    }

    @discardableResult
    private func updateDaily(_ update: (inout MiniDailyDay) -> Bool) -> Bool {
        guard var ledger = dailyLedger,
              let index = ledger.days.lastIndex(where: { $0.id == activeDailyID }) else { return false }
        guard update(&ledger.days[index]) else { return false }
        do {
            try dailyStorage.save(ledger)
            dailyLedger = ledger
            dailyError = nil
            return true
        } catch {
            dailyError = "学习进度保存失败，请重试。"
            return false
        }
    }

    private func prepareDaily() async {
        guard let day = dailyDay, !day.wordsToPrepare.isEmpty, preparationDay != day.id else { return }
        let requestDay = day.id
        preparationDay = requestDay
        preparationError = nil
        defer { if preparationDay == requestDay { preparationDay = nil } }
        do {
            let sentences = try await MiniDailyAI().prepare(
                words: day.wordsToPrepare, history: teachingHistory(for: day.wordsToPrepare),
                level: preparationLevel, model: modelID.isEmpty ? nil : modelID, effort: effort.isEmpty ? nil : effort
            )
            guard dailyDay?.id == requestDay else { return }
            if !updateDaily({ $0.addSentences(sentences) }) {
                preparationError = "未能保存今日例句，请重试。"
            }
        } catch is CancellationError {
            return
        } catch {
            if dailyDay?.id == requestDay { preparationError = error.localizedDescription }
        }
    }

    private func gradeDailyTranslation() async {
        guard let day = dailyDay, let task = day.currentTranslation,
              let attempt = day.currentAttempt, attempt.feedback == nil, gradingAttempt == nil else { return }
        gradingAttempt = attempt.id
        gradingError = nil
        defer { gradingAttempt = nil }
        do {
            let feedback = try await MiniDailyAI().grade(
                prompt: task.prompt, reference: task.reference, answer: attempt.answer,
                direction: task.direction, history: teachingHistory(for: [task.sentence.word]),
                model: modelID.isEmpty ? nil : modelID, effort: effort.isEmpty ? nil : effort
            )
            guard dailyDay?.id == day.id else { return }
            if !updateDaily({ $0.gradeTranslation(id: attempt.id, feedback: feedback) }) {
                gradingError = "批改未能保存，作答仍在。"
            }
        } catch is CancellationError {
            return
        } catch {
            if dailyDay?.id == day.id { gradingError = error.localizedDescription }
        }
    }

    private func teachingHistory(for words: [MiniWord]) -> [String] {
        guard let ledger = dailyLedger else { return [] }
        let spellings = Set(words.map { $0.spelling.lowercased() })
        let relevant = ledger.days.reversed().lazy.flatMap { day in
            day.translation.reversed().compactMap { attempt -> String? in
                let spelling = attempt.task.sentence.word.spelling
                guard spellings.contains(spelling.lowercased()), let feedback = attempt.feedback else { return nil }
                return "\(day.id) \(spelling)：\(feedback.comment)；\(feedback.tip)"
            }
        }.prefix(6)
        return Array(ledger.teachingHistory.suffix(10)) + Array(relevant.reversed())
    }

    private var preparationLevel: String {
        let practicedWords = Set((dailyLedger?.days ?? []).flatMap { day in
            day.scheduleUpdates.map { $0.word.spelling.lowercased() }
        }).count
        return "\(studyLevel)；本机有 \(practicedWords) 个词的已完成练习记录（非总词汇量）"
    }

    private func restoreChats() {
        do {
            chats = try chatStorage.load()
            chatArchiveError = nil
        } catch {
            chatArchiveError = "无法读取以前的聊天。已有聊天文件已保留。"
        }
    }

    private func continueToLearning() {
        guard let record = reviewRecord, record.session.phase == .finished else { return }
        updateReview { $0.continuedToLearning = true }
        if reviewRecord?.continuedToLearning == true { move(to: record.nextWordIndex) }
    }

    private func updateReview(_ update: (inout MiniReviewRecord) -> Void) {
        guard var record = reviewRecord else { return }
        update(&record)
        saveReview(record)
    }

    private func saveReview(_ record: MiniReviewRecord) {
        do {
            try reviewStorage.save(record)
            reviewRecord = record
            reviewError = nil
        } catch {
            reviewError = "复习进度保存失败，请重试。"
        }
    }

    private func flashcard(_ word: MiniWord, index: Int, count: Int) -> some View {
        VStack(spacing: 10) {
            GeometryReader { area in
                ScrollView {
                    VStack(spacing: 7) {
                        Text(word.spelling)
                            .font(.system(size: 35, weight: .semibold, design: .serif))
                            .textSelection(.enabled)
                            .accessibilityIdentifier("wordSpelling")

                        if !word.phonetic.isEmpty {
                            Text(word.phonetic).foregroundStyle(.secondary)
                        }

                        if revealed {
                            if word.meaning.isEmpty {
                                Button("问 AI 词义") { mode = .chat }
                            } else {
                                Text(word.meaning).font(.body)
                            }
                        } else {
                            Button("显示释义") { revealed = true }
                                .keyboardShortcut(.space, modifiers: [])
                        }
                    }
                    .multilineTextAlignment(.center)
                    .padding(.vertical, 18)
                    .frame(maxWidth: .infinity, minHeight: area.size.height)
                }
            }

            HStack {
                Button("上一个", systemImage: "chevron.left") { move(to: index - 1) }
                    .disabled(index == 0)
                    .keyboardShortcut(.leftArrow, modifiers: [])
                Spacer()
                Text("\(index + 1) / \(count)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("第 \(index + 1) 个，共 \(count) 个")
                Spacer()
                Button(index == count - 1 ? "从头开始" : "下一个", systemImage: "chevron.right") {
                    move(to: (index + 1) % count)
                }
                .keyboardShortcut(.rightArrow, modifiers: [])
            }
        }
    }

    private var listEditor: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("每行一个词，Tab 后填中文释义。只有带释义的词会加入每日任务。")
                .font(.caption)
                .foregroundStyle(.secondary)
            TextEditor(text: $listDraft)
                .font(.system(.body, design: .monospaced))
                .accessibilityLabel("自定义词表")
                .border(Color(nsColor: .separatorColor))
            if let listError {
                Text(listError).font(.caption)
            }
            HStack {
                if !customWordList.isEmpty {
                    Button("用内置词表") { saveList("") }
                }
                Spacer()
                Button("返回") { editingList = false }
                Button("保存") {
                    let parsed = MiniWord.parseList(listDraft)
                    guard !parsed.isEmpty, parsed.count <= 500, listDraft.count <= 60_000 else {
                        listError = "请输入 1–500 个词，最多 60,000 字符。"
                        return
                    }
                    saveList(listDraft)
                }
            }
        }
    }

    private func chat(for word: MiniWord) -> some View {
        let messages = chats[word, default: []]
        let draft = Binding(
            get: { drafts[word, default: ""] },
            set: { drafts[word] = $0 }
        )

        return VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(concealChatWord ? "当前练习" : word.spelling)
                    .font(.headline)
                    .lineLimit(1)
                Spacer(minLength: 8)
                modelMenu
            }

            if let modelsError {
                Text(modelsError)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            if let chatArchiveError {
                Text(chatArchiveError).font(.caption2).foregroundStyle(.secondary)
            }

            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 9) {
                        if messages.isEmpty {
                            Text("可以问词义、用法或例句。")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        ForEach(messages) { message in
                            VStack(alignment: .leading, spacing: 3) {
                                Text(message.role == .user ? "你" : "AI")
                                    .font(.caption2.weight(.semibold))
                                    .foregroundStyle(.secondary)
                                Text(message.text).font(.callout).textSelection(.enabled)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        if pendingWord == word {
                            ProgressView("等待 AI 回复…").controlSize(.small)
                        }
                        if let error = errors[word] {
                            Text(error).font(.caption)
                        }
                        Color.clear.frame(height: 1).id("endOfChat")
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .defaultScrollAnchor(.bottom)
                .onChange(of: messages.count) { _, _ in proxy.scrollTo("endOfChat", anchor: .bottom) }
                .onChange(of: pendingWord) { _, _ in proxy.scrollTo("endOfChat", anchor: .bottom) }
            }

            HStack {
                TextField("问问这个词…", text: draft)
                    .textFieldStyle(.roundedBorder)
                    .focused($chatFocused)
                    .onSubmit { send(draft.wrappedValue, about: word) }
                Button("发送", systemImage: "arrow.up") { send(draft.wrappedValue, about: word) }
                    .labelStyle(.iconOnly)
                    .disabled(pendingWord != nil || draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .help("发送")
            }
        }
    }

    private var modelMenu: some View {
        Menu {
            Picker("模型", selection: $modelID) {
                Text("默认模型").tag("")
                ForEach(models) { model in Text(model.name).tag(model.id) }
            }
            if let model = chosenModel, !model.efforts.isEmpty {
                Picker("推理强度", selection: $effort) {
                    ForEach(model.efforts, id: \.self) { value in
                        Text(effortLabel(value)).tag(value)
                    }
                    if model.defaultEffort == nil { Text("默认").tag("") }
                }
            }
            Divider()
            Button("刷新模型列表") { Task { await refreshModels() } }
                .disabled(loadingModels)
        } label: {
            let model = chosenModel?.name ?? "默认模型"
            Text(loadingModels ? "读取模型…" : (effort.isEmpty || chosenModel == nil ? model : "\(model) · \(effortLabel(effort))"))
                .font(.caption)
                .lineLimit(1)
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .disabled(pendingWord != nil)
        .accessibilityLabel("模型和推理强度")
    }

    private func effortLabel(_ value: String) -> String {
        value == "xhigh" ? "XHigh" : value.capitalized
    }

    private func refreshModels() async {
        guard !loadingModels else { return }
        loadingModels = true
        modelsError = nil
        defer { loadingModels = false }
        do {
            models = try await MiniChatService().models()
            if let model = chosenModel {
                if !model.efforts.contains(effort) { effort = model.defaultEffort ?? "" }
            } else if !modelID.isEmpty {
                modelID = ""
                effort = ""
                modelsError = "已选模型不在当前列表，已切回默认。"
            }
        } catch is CancellationError {
            return
        } catch {
            modelsError = "暂时读不到模型列表，可从菜单刷新。"
        }
    }

    private func move(to index: Int) {
        storedIndex = index
        revealed = false
    }

    private func saveList(_ text: String) {
        customWordList = text
        move(to: 0)
        editingList = false
        beginDaily()
    }

    private func send(_ raw: String, about word: MiniWord) {
        let question = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard pendingWord == nil, !question.isEmpty else { return }
        guard question.count <= 2_000 else {
            errors[word] = "问题最多 2,000 字符。"
            return
        }

        let message = MiniChatMessage(role: .user, text: question)
        let history = chats[word, default: []] + [message]
        let model = chosenModel
        let reasoningEffort = model?.efforts.contains(effort) == true ? effort : nil
        chats[word] = history
        drafts[word] = ""
        errors[word] = nil
        pendingWord = word

        Task {
            defer { pendingWord = nil }
            do {
                let reply = try await MiniChatService().reply(
                    to: history, word: word.chatContext, model: model?.id, effort: reasoningEffort,
                    studyHistory: teachingHistory(for: [word])
                )
                chats[word, default: []].append(MiniChatMessage(role: .assistant, text: reply))
                do {
                    try chatStorage.save(chats)
                    chatArchiveError = nil
                } catch {
                    chatArchiveError = "这次聊天暂未写入本机记录。"
                }
            } catch {
                chats[word] = Array(history.dropLast())
                if drafts[word, default: ""].isEmpty { drafts[word] = question }
                errors[word] = error.localizedDescription
            }
        }
    }
}
