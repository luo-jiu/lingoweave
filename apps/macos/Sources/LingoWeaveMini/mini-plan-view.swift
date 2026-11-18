import SwiftUI

struct MiniPlanView: View {
    let planning: MiniPlanningState
    let context: MiniPlanContext
    let saving: Bool
    let notice: String?
    let saveLongTerm: (MiniLongTermPlan) -> Void
    let saveToday: (MiniPlanMode, MiniPlanBudget) -> Void
    let clearToday: () -> Void
    let vocabulary: MiniVocabularyCatalog?
    let vocabularyError: String?
    let activateDeck: (String?, MiniVocabularyOrder) -> Void
    let startCourse: () -> Void

    private enum Section: String, CaseIterable { case longTerm = "长期", today = "今日", vocabulary = "词书" }
    @State private var section: Section = .today
    @State private var longTerm: MiniLongTermPlan
    @State private var todayMode: MiniPlanMode
    @State private var todayBudget: MiniPlanBudget

    init(planning: MiniPlanningState, context: MiniPlanContext, saving: Bool,
         notice: String?,
         saveLongTerm: @escaping (MiniLongTermPlan) -> Void,
         saveToday: @escaping (MiniPlanMode, MiniPlanBudget) -> Void,
         clearToday: @escaping () -> Void,
         vocabulary: MiniVocabularyCatalog? = nil, vocabularyError: String? = nil,
         activateDeck: @escaping (String?, MiniVocabularyOrder) -> Void = { _, _ in }, startCourse: @escaping () -> Void = {}) {
        self.planning = planning
        self.context = context
        self.saving = saving
        self.notice = notice
        self.saveLongTerm = saveLongTerm
        self.saveToday = saveToday
        self.clearToday = clearToday
        self.vocabulary = vocabulary
        self.vocabularyError = vocabularyError
        self.activateDeck = activateDeck
        self.startCourse = startCourse
        _longTerm = State(initialValue: planning.longTerm)
        _todayMode = State(initialValue: context.todayOverride?.mode ?? context.effective.mode)
        _todayBudget = State(initialValue: context.todayOverride?.budget ?? context.effective.budget)
    }

    var body: some View {
        VStack(spacing: 8) {
            Picker("计划范围", selection: $section) {
                ForEach(Section.allCases, id: \.self) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("planScope")

            ScrollView {
                VStack(alignment: .leading, spacing: 9) {
                    switch section {
                    case .longTerm: longTermSection
                    case .today: todaySection
                    case .vocabulary: vocabularySection
                    }
                    if let notice {
                        Text(notice).font(.caption).foregroundStyle(.secondary)
                            .accessibilityAddTraits(.updatesFrequently)
                    }
                }
                .padding(.horizontal, 1)
                .padding(.bottom, 3)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            if section == .vocabulary, vocabulary != nil {
                Button("开始学习", action: startCourse)
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("startVocabularyCourse")
            }
        }
        .disabled(saving)
        .onChange(of: planning.longTerm) { _, updated in
            longTerm = updated
            if context.todayOverride == nil { todayBudget = context.effective.budget }
        }
        .onChange(of: context.todayOverride) { _, updated in
            todayMode = updated?.mode ?? context.effective.mode
            todayBudget = updated?.budget ?? context.effective.budget
        }
        .onChange(of: context.date) { _, _ in
            todayMode = context.todayOverride?.mode ?? context.effective.mode
            todayBudget = context.todayOverride?.budget ?? context.effective.budget
        }
        .accessibilityIdentifier("miniLearningPlan")
    }

    private var vocabularySection: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let vocabulary {
                HStack(spacing: 10) {
                    Picker("词汇等级", selection: Binding(
                        get: { vocabulary.activeDeck?.level ?? "all" },
                        set: { level in
                            guard let book = vocabulary.activeBook else { return }
                            activateDeck(book.deckId(for: level == "all" ? nil : level), vocabulary.activeOrder)
                        }
                    )) {
                        Text("全部").tag("all")
                        ForEach(vocabulary.activeBook?.levels ?? [], id: \.level) { item in
                            Text(item.level + " · \(item.wordCount) 词").tag(item.level)
                        }
                    }
                    .font(.caption)
                    .disabled(vocabulary.activeBook?.levels.isEmpty != false)
                    .accessibilityIdentifier("vocabularyLevel")

                    Picker("排列", selection: Binding(
                        get: { vocabulary.activeOrder },
                        set: { activateDeck(vocabulary.activeDeckId, $0) }
                    )) {
                        ForEach(MiniVocabularyOrder.allCases) { order in
                            Text(order.label).tag(order)
                        }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .frame(width: 104)
                    .accessibilityIdentifier("vocabularyOrder")
                }

                LazyVGrid(columns: [GridItem(.adaptive(minimum: 94, maximum: 110), alignment: .top)],
                          alignment: .leading, spacing: 12) {
                    ForEach(vocabulary.books) { book in
                        vocabularyBook(id: book.id, name: book.name, count: book.wordCount,
                                       selected: vocabulary.activeBook?.id == book.id) {
                            let level = vocabulary.activeDeck?.level
                            activateDeck(book.deckId(for: level), vocabulary.activeOrder)
                        }
                    }
                    vocabularyBook(id: "custom", name: "自定义\n词表", count: nil,
                                   selected: vocabulary.activeDeckId == nil) {
                        activateDeck(nil, vocabulary.activeOrder)
                    }
                }

                DisclosureGroup("词书来源") {
                    ForEach(vocabulary.sources) { source in
                        VStack(alignment: .leading, spacing: 2) {
                            if let url = URL(string: source.url), ["https", "http"].contains(url.scheme) {
                                Link(source.title, destination: url).font(.caption)
                            } else { Text(source.title).font(.caption) }
                            Text(source.version + " · " + source.license).font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                }
                .font(.caption)
            } else {
                ProgressView("读取词书…").controlSize(.small)
            }
            if let vocabularyError { Text(vocabularyError).font(.caption).foregroundStyle(.secondary) }
        }
        .accessibilityIdentifier("vocabularyCatalog")
    }

    private func vocabularyBook(id: String, name: String, count: Int?, selected: Bool,
                                action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 5) {
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 6)
                        .fill(selected ? Color.accentColor.opacity(0.18) : Color.secondary.opacity(0.09))
                    Rectangle().fill(Color.primary.opacity(0.07))
                        .frame(width: 6).padding(.vertical, 6)
                    Text(name)
                        .font(.system(size: 14, weight: .semibold))
                        .multilineTextAlignment(.leading)
                        .lineLimit(4)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                        .padding(.horizontal, 14).padding(.vertical, 20)
                }
                .frame(width: 94, height: 112)
                .overlay {
                    RoundedRectangle(cornerRadius: 6)
                        .strokeBorder(selected ? Color.accentColor : Color.primary.opacity(0.12), lineWidth: selected ? 2 : 1)
                }
                .overlay(alignment: .bottomTrailing) {
                    if selected {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(Color.accentColor)
                            .padding(7)
                    }
                }
                if let count {
                    Text("\(count) 个词条").font(.caption2).foregroundStyle(.secondary)
                }
            }
            .foregroundStyle(.primary)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(name.replacingOccurrences(of: "\n", with: ""))
        .accessibilityValue(selected ? "已选词书" : "可选词书")
        .accessibilityIdentifier("vocabularyBook:" + id)
    }

    private var longTermSection: some View {
        VStack(alignment: .leading, spacing: 9) {
            Text("平时怎么学").font(.headline)
            HStack(spacing: 5) {
                Text("每周").font(.caption).foregroundStyle(.secondary)
                ForEach(1...7, id: \.self) { weekday in
                    let selected = longTerm.weekdays.contains(weekday)
                    Button {
                        if selected {
                            if longTerm.weekdays.count > 1 { longTerm.weekdays.removeAll { $0 == weekday } }
                        } else { longTerm.weekdays = (longTerm.weekdays + [weekday]).sorted() }
                    } label: {
                        Text(["一", "二", "三", "四", "五", "六", "日"][weekday - 1])
                            .font(.system(size: 10, weight: selected ? .semibold : .regular))
                            .frame(maxWidth: .infinity, minHeight: 22)
                            .background(selected ? Color.accentColor.opacity(0.2) : Color.primary.opacity(0.05),
                                        in: RoundedRectangle(cornerRadius: 4))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("周" + ["一", "二", "三", "四", "五", "六", "日"][weekday - 1])
                    .accessibilityValue(selected ? "学习日" : "休息日")
                }
            }
            budgetControls(Binding(get: { longTerm.budget }, set: { value in
                longTerm.wordLimit = value.wordLimit
                longTerm.newWordLimit = value.newWordLimit
                longTerm.dailyNewGoal = value.dailyNewGoal
                longTerm.groupSize = value.groupSize
            }))
            Text("休息日可按自己的状态临时开启学习，不补学欠账。")
                .font(.caption).foregroundStyle(.secondary)
            Button("保存长期计划") { saveLongTerm(longTerm) }
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("saveLongTermPlan")
        }
    }

    private var todaySection: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack {
                Text("今天怎么学").font(.headline)
                Spacer(minLength: 2)
                Text(context.date).font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
            }
            Picker("今日安排", selection: $todayMode) {
                ForEach(MiniPlanMode.allCases, id: \.self) { Text($0.label).tag($0) }
            }
            .labelsHidden()
            .accessibilityIdentifier("todayPlanMode")
            if todayMode != .rest {
                budgetControls($todayBudget, reviewOnly: todayMode == .reviewOnly)
                Button("今天少学一点") {
                    todayBudget = .init(wordLimit: min(todayBudget.wordLimit, planning.longTerm.wordLimit, 3),
                                        newWordLimit: min(todayBudget.newWordLimit, planning.longTerm.newWordLimit, 1),
                                        dailyNewGoal: min(todayBudget.effectiveDailyGoal, 3),
                                        groupSize: todayBudget.effectiveGroupSize)
                }
                .font(.caption)
            }
            Text(todayMode == .rest ? "今天暂停学习，未完成的位置与输入会保留。明天恢复长期计划。"
                 : "只对今天生效，不改变长期设置，也不把剩余内容加到明天。")
                .font(.caption).foregroundStyle(.secondary)
            HStack(spacing: 7) {
                Button(todayMode == .rest ? "今天不学了" : "保存今日安排") { saveToday(todayMode, todayBudget) }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("saveTodayPlan")
                Button("恢复默认", action: clearToday)
                    .disabled(context.todayOverride == nil)
            }
        }
    }

    private func budgetControls(_ budget: Binding<MiniPlanBudget>, reviewOnly: Bool = false) -> some View {
        Grid(alignment: .leading, horizontalSpacing: 8, verticalSpacing: 6) {
            if !reviewOnly {
                GridRow {
                    Text("每日新词")
                    Text("\(budget.wrappedValue.effectiveDailyGoal)").monospacedDigit().gridColumnAlignment(.trailing)
                    Text("词").foregroundStyle(.secondary)
                    Stepper("每日新词完成目标", value: Binding(
                        get: { budget.wrappedValue.effectiveDailyGoal },
                        set: { budget.wrappedValue.dailyNewGoal = $0 }
                    ), in: 0...200)
                        .labelsHidden()
                }
                GridRow {
                    Text("每组数量")
                    Text("\(budget.wrappedValue.effectiveGroupSize)").monospacedDigit()
                    Text("词").foregroundStyle(.secondary)
                    Stepper("每组新词数量", value: Binding(
                        get: { budget.wrappedValue.effectiveGroupSize },
                        set: { budget.wrappedValue.groupSize = $0 }
                    ), in: 1...50)
                        .labelsHidden()
                }
            }

        }
        .font(.callout)
        .controlSize(.small)
    }
}
