import AppKit
import SwiftUI

extension Notification.Name {
    static let miniOpenSettings = Notification.Name("lingoweave.open-settings")
}

struct MiniStudyView: View {
    @Binding var isPinned: Bool
    @AppStorage("wordIndex") private var storedIndex = 0
    @AppStorage("customWordList") private var customWordList = ""
    @AppStorage("chatModel") private var modelID = MiniAISelection.initial.model
    @AppStorage("chatEffort") private var effort = MiniAISelection.initial.effort
    @AppStorage("audioMuted") private var audioMuted = false
    @AppStorage("audioVolume") private var audioVolume = 1.0
    @AppStorage("cardTextSize") private var cardTextSize: MiniCardTextSize = .medium
    @AppStorage("studyAppearance") private var studyAppearance: MiniStudyAppearance = .rich
    @State private var previewAudioMuted = false
    @State private var previewWordList = ""
    @State private var previewWordIndex = 0
    @StateObject private var audio = MiniAudioController()
    @State private var audioWindowVisible = true
    @State private var showingHome = true
    @State private var showingPlan = false
    @State private var showingProbe = false
    private enum Supplement { case patterns, dialogue, translations, learnedPatterns }
    @State private var supplement: Supplement?
    @State private var translationReviewDate = Date.now
    @State private var selectedTranslationTaskId: String?
    @State private var patternStart: MiniPatternStartIntent?
    @State private var patternsBeforeNextGroup = false
    @State private var introducedPatternDate: String?
    @State private var preferLegacyReview = false
    @State private var localReviewIntent: MiniStudyIntent?
    @State private var mode: Mode = .words
    @State private var advisorChat = false
    @State private var tabWidth: CGFloat = 90
    @State private var titleActionsWidth: CGFloat = 110
    @State private var editingList = false
    @State private var listDraft = ""
    @State private var listError: String?
    @State private var aiSnapshot: MiniAISnapshot?
    @State private var aiSubmitting = false
    @State private var aiError: String?
    @State private var pendingAIRequest: MiniAIStart?
    @State private var aiObservation: Task<Void, Never>?
    @State private var appliedAIJobs: [UUID: Date] = [:]
    @State private var chatDrafts: [String: String] = [:]
    @State private var previewChats: [String: [MiniChatMessage]] = [:]
    @State private var settings: Settings?
    @State private var reviewRecord: MiniReviewRecord?
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
    @State private var serviceSnapshot: MiniStudySnapshot?
    @State private var planContext: MiniPlanContext?
    @State private var planNotice: String?
    @State private var serviceBusy = false
    @State private var reviewInputs: [MiniReviewInput] = []
    @State private var pendingCommand: MiniStudyCommand?
    @State private var inputDrafts: [String: String] = [:]
    @State private var inputDraftsLoaded = false
    @State private var serviceGeneration = UUID()
    @State private var refreshingPlanDate = false
    @State private var vocabulary: MiniVocabularyCatalog?
    @State private var vocabularyBusy = false
    @State private var vocabularyError: String?
    @State private var pendingVocabulary: MiniVocabularyActivation?
    @State private var viewedCardIdentity: String?
    @State private var viewedCardSaved = false
    @State private var viewedCardVisit = UUID()
    @State private var cardViewRequests: [UUID: UUID] = [:]
    @State private var cardViewFailed = false
    @State private var cardNeedsRefresh = false
    @State private var previewDictation: MiniDictation?
    @State private var previewDictationDraft = ""
    @State private var previewTranslationDrafts: [String: String] = [:]
    @State private var cardHides: [MiniStudyCommand] = []
    @State private var cardHidesLoaded = false
    @State private var lastHiddenWord: MiniWord?
    @State private var browseViewport = MiniBrowseViewport()
    @State private var browseOutbox: [MiniStudyCommand] = []
    @State private var browseOutboxLoaded = false
    @State private var browseDrain: Task<Bool, Never>?
    @State private var browseIdle: Task<Void, Never>?
    @FocusState private var chatFocused: Bool
    #if DEBUG
    @State private var devStage: MiniDevStage = .live
    @State private var devGeneration = UUID()
    #endif
    private let studyClient = MiniStudyClient()
    private let aiClient = MiniAIClient()
    private let chatStorage = MiniChatStorage()
    private let vocabularyClient = MiniVocabularyClient()
    private let patternClient = MiniPatternClient()
    private static let planDateChecks = Timer.publish(every: 60, tolerance: 5, on: .main, in: .common).autoconnect()

    private enum Mode: String, CaseIterable {
        case words = "词卡"
        case chat = "AI 聊天"
    }

    private enum Settings: Identifiable {
        case display, ai
        var id: Self { self }
    }

    private var deckTitle: String {
        isPreview ? "示例词表" : (vocabulary?.activeBook?.name ?? vocabulary?.activeSelectionName ?? "自定义词表")
    }

    private var customList: String { isPreview ? previewWordList : customWordList }

    private var editableListText: String {
        customList.isEmpty ? MiniWord.starter.map { "\($0.spelling)\t\($0.meaning)" }.joined(separator: "\n") : customList
    }

    private var words: [MiniWord] {
        if !isPreview, let vocabulary, vocabulary.activeDeckId != nil { return vocabulary.activeWords }
        let custom = MiniWord.parseList(customList)
        let customWords = custom.isEmpty ? MiniWord.starter : custom
        return !isPreview ? (vocabulary?.orderedCustomWords(customWords) ?? customWords) : customWords
    }

    private var dailyDay: MiniDailyDay? { dailyLedger?.days.last { $0.id == activeDailyID } }

    private var presentedDailyDay: MiniDailyDay? {
        guard var day = dailyDay else { return nil }
        guard !isPreview, day.memoryWindow != nil else { return day }
        for input in reviewInputs where input.windowCursor != nil {
            input.presentWindow(in: &day)
        }
        return day
    }

    private var isPreview: Bool {
        #if DEBUG
        devStage.isPreview
        #else
        false
        #endif
    }

    private var savingStudy: Bool { !isPreview && (serviceBusy || refreshingPlanDate || vocabularyBusy || pendingVocabulary != nil || pendingCommand != nil || audio.authorizing) }
    private var savingStudyControls: Bool {
        !isPreview && (serviceBusy || refreshingPlanDate || vocabularyBusy || pendingVocabulary != nil || pendingCommand != nil)
    }
    private var effectiveAudioMuted: Bool { (isPreview ? previewAudioMuted : audioMuted) || audioVolume <= 0 }
    private var activeDictation: MiniDictation? {
        guard !browsingWords else { return nil }
        if isPreview { return previewDictation }
        var practice = serviceSnapshot?.practice?.activeDictation
        for input in reviewInputs {
            input.presentDictation(in: &practice)
        }
        guard let practice, practice.target != .daily || practice.dayId == dailyDay?.id else { return nil }
        return practice
    }

    private var showingReview: Bool {
        guard let reviewRecord, !reviewRecord.continuedToLearning else { return false }
        if preferLegacyReview || isPreview { return true }
        guard serviceSnapshot?.planning.activeDayId == nil, let planContext else { return false }
        let latest = reviewRecord.session.lastSpellingAttempt?.submittedAt
            ?? reviewRecord.session.judgmentEvents.last.map { $0.finalizedAt ?? $0.selectedAt }
        return latest.map(planContext.includesDate) == true
    }

    private var usesQuietStudyControls: Bool {
        if supplement == .patterns || supplement == .dialogue || showingProbe { return true }
        return supplement == nil && !showingHome && !showingPlan && !browsingWords && !advisorChat
    }

    private var stageLabels: (title: String, spoken: String) {
        if supplement == .patterns { return ("Patterns", "起手句式") }
        if supplement == .dialogue { return ("Dialogue", "英文对话") }
        if supplement == .translations { return ("翻译点评", "翻译点评") }
        if supplement == .learnedPatterns { return ("学过的句式", "学过的句式") }
        if showingProbe { return ("Check", "独立检验") }
        if showingPlan { return ("学习计划", "学习计划") }
        if showingHome {
            let title = planContext?.todayCompleted == true && !showingReview ? "今日完成" : "首页"
            return (title, title)
        }
        if mode == .chat { return (advisorChat ? "AI 聊天" : "Chat", "AI 聊天") }
        if browsingWords {
            let title = editingList ? "编辑词表" : "浏览词表"
            return (title, title)
        }
        if let record = reviewRecord, showingReview {
            if record.paused { return ("Paused", "复习 · 暂停") }
            switch record.session.phase {
            case .judgment: return ("Review", "复习 · 判断")
            case .spelling: return ("Spell", "复习 · 拼写")
            case .finished: return ("Done", "复习 · 完成")
            }
        }
        guard let day = dailyDay else { return ("Study", "每日学习") }
        if day.paused && day.phase != .finished { return ("Paused", "已暂停") }
        switch day.phase {
        case .review:
            if day.memoryWindow != nil { return ("Recall", "复习 · 重新记忆") }
            switch day.review?.phase {
            case .spelling: return ("Spell", "复习 · 拼写")
            case .finished: return ("Done", "复习 · 完成")
            default: return ("Review", "复习 · 判断")
            }
        case .learning:
            if day.retainedLearningWord != nil || day.nextUnstudiedWord != nil { return ("Words", "学习 · 新词") }
            return day.learning?.phase == .finished ? ("Done", "学习 · 完成") : ("Spell", "学习 · 拼写")
        case .translation: return ("Write", "语句 · 翻译")
        case .finished: return ("Done", Calendar.current.isDateInToday(day.startedAt) ? "今日完成" : "已完成")
        }
    }

    private func displayedTranslation(_ day: MiniDailyDay) -> MiniTranslationTask? {
        day.translationTask(at: day.translationPageIndex(selection: selectedTranslationTaskId))
    }

    private var studyingWord: MiniWord? {
        guard !browsingWords, !showingReview, let day = presentedDailyDay else { return nil }
        switch day.phase {
        case .review: return day.memoryWindow?.visit?.word ?? day.review?.currentWord
        case .learning: return day.retainedLearningWord ?? day.nextUnstudiedWord ?? day.learning?.currentWord
        case .translation: return displayedTranslation(day)?.sentence.word
        case .finished: return nil
        }
    }

    private var hasStudyToReturnTo: Bool {
        if showingReview { return reviewRecord?.session.phase != .finished }
        guard let day = dailyDay else { return false }
        return day.phase != .finished && day.flow?.goalReached != true
    }

    private var inJudgmentReview: Bool {
        showingReview || (!browsingWords && dailyDay?.phase == .review)
    }

    private var concealChatWord: Bool {
        guard !browsingWords, let day = dailyDay else { return false }
        return day.phase == .translation || (day.phase == .learning && day.nextUnstudiedWord == nil)
    }

    private var panelContent: some View {
        VStack(spacing: 0) {
            titleBar
            Divider()
            VStack(spacing: 8) {
                if supplement == .patterns {
                    MiniPatternView(client: patternClient, automatic: patternStart != nil || patternsBeforeNextGroup,
                                    muted: effectiveAudioMuted, volume: audioVolume, windowVisible: audioWindowVisible, close: leavePatterns,
                                    dialogue: { openSupplement(.dialogue) })
                } else if supplement == .dialogue {
                    dialogueContent
                } else if supplement == .translations {
                    translationReviewContent
                } else if supplement == .learnedPatterns {
                    MiniPatternLibraryView(load: { text, offset in
                        if isPreview { return MiniPhrasePage(total: 0, items: []) }
                        return try await patternClient.learnedPatterns(query: text, offset: offset)
                    }, close: resetSupplement)
                } else if showingProbe {
                    probeContent
                } else if showingPlan {
                    planContent
                } else if showingHome {
                    MiniHomeView(day: dailyDay, ledger: dailyLedger, start: { resumeStudy($0) },
                                 error: dailyError, legacyReview: showingReview ? reviewRecord?.session : nil, preview: isPreview,
                                 context: planContext, saving: savingStudy,
                                 startExtraGroup: { resumeStudy(extraGroupForDate: $0) }, openPlan: openLearningPlan,
                                 deckName: deckTitle,
                                 deckDetail: isPreview ? nil : vocabulary?.activeSelectionDetail,
                                 bookId: isPreview ? nil : vocabulary?.activeBook?.id,
                                 openWords: openWordBrowser,
                                 assessmentClient: isPreview ? nil : MiniAssessmentClient(study: studyClient),
                                 assessmentUpdated: { try? await refreshPlanContext(generation: serviceGeneration) },
                                 assessmentPreview: previewAssessment?.snapshot,
                                 assessmentPreviewDetail: previewAssessment?.detail,
                                 openTranslationReview: isPreview ? nil : { openTranslationReview(.now) },
                                 openLearnedPatterns: { openSupplement(.learnedPatterns) })
                } else {
                    activeContent
                        .safeAreaInset(edge: .bottom, spacing: 2) {
                            if mode == .words, !editingList, activeDictation == nil {
                                MiniAudioFooter(notice: audio.notice) { audioControls }
                            }
                        }
                }
                if let error = reviewError ?? dailyError {
                    Text(error)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .accessibilityAddTraits(.updatesFrequently)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            #if DEBUG
            .id(devGeneration)
            #endif
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .windowBackgroundColor))
        .miniWindowScrollbars()
        .environment(\.miniCardTextSize, cardTextSize)
        .environment(\.miniStudyAppearance, studyAppearance)
        .sheet(item: $settings) { section in
            switch section {
            case .display:
                displaySettings
            case .ai:
                MiniModelSettingsView(selection: aiSelection, load: { try await MiniChatService(client: aiClient).runtime() }) { updated in
                    modelID = updated.model
                    effort = updated.effort
                }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .miniOpenSettings)) { _ in
            settings = .display
        }
    }

    var body: some View {
        panelContent
        .onAppear {
            audio.setVolume(audioVolume)
            #if DEBUG
            selectDevStage(devStage)
            #else
            beginDaily()
            #endif
        }
        .onDisappear {
            browseViewportChanged([])
            if let word = visibleEnglishWord { queueCardHide(word) }
            aiObservation?.cancel(); aiObservation = nil; audio.disconnect()
        }
        .onChange(of: audioPresentation) { synchronizeAudio() }
        .onChange(of: visibleAnswerCard) { recordVisibleCardIfNeeded() }
        .onChange(of: visibleEnglishWord) { previous, current in
            if let previous, previous != current { queueCardHide(previous) }
            if current != nil, audioWindowVisible { lastHiddenWord = nil }
            if current != nil, visibleAnswerCard == nil { cardNeedsRefresh = true }
            recordVisibleCardIfNeeded()
        }
        .onChange(of: savingStudy) {
            if !savingStudy {
                recordVisibleCardIfNeeded()
                drainReviewInputs()
            }
        }
        .onChange(of: audioPrefetchTargets) { prefetchAudio() }
        .onChange(of: dailyDay) { previous, current in
            if isPreview, localReviewIntent == .review, previous?.id == current?.id,
               previous?.phase == .review, current?.phase != .review { showingHome = true }
            startBackgroundPreparationIfNeeded()
        }
        .onChange(of: aiSubmitting) { startBackgroundPreparationIfNeeded() }
        .onChange(of: aiSnapshot?.imported) { startBackgroundPreparationIfNeeded() }
        .onChange(of: effectiveAudioMuted) { synchronizeAudio() }
        .onChange(of: audioVolume) { _, gain in audio.setVolume(gain) }
        .onReceive(NotificationCenter.default.publisher(for: .miniWindowVisibilityChanged)) { event in
            guard let visible = event.object as? Bool else { return }
            if visible, !audioWindowVisible { cardNeedsRefresh = true }
            if visible {
                lastHiddenWord = nil
                refreshPlanDateIfNeeded()
            }
            if !visible, audioWindowVisible, let word = visibleEnglishWord { queueCardHide(word) }
            audioWindowVisible = visible
            browseViewportChanged(browseViewport.rows)
            recordVisibleCardIfNeeded()
            synchronizeAudio()
        }
        .onReceive(NotificationCenter.default.publisher(for: .NSCalendarDayChanged)) { _ in refreshPlanDateIfNeeded() }
        .onReceive(NotificationCenter.default.publisher(for: .NSSystemTimeZoneDidChange)) { _ in refreshPlanDateIfNeeded() }
        .onReceive(NotificationCenter.default.publisher(for: .NSSystemClockDidChange)) { _ in refreshPlanDateIfNeeded() }
        .onReceive(NSWorkspace.shared.notificationCenter.publisher(for: NSWorkspace.didWakeNotification)) { _ in refreshPlanDateIfNeeded() }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in refreshPlanDateIfNeeded() }
        .onReceive(Self.planDateChecks) { _ in refreshPlanDateIfNeeded() }
        .onChange(of: showingHome) { _, visible in
            if visible {
                audio.stop()
                refreshPlanDateIfNeeded()
            }
        }
    }

    private var audioPresentation: MiniAudioPresentation? {
        // Projected prompts can already be on screen while the service still owns
        // the preceding visit. Only request audio for a matching confirmed card.
        let displayedPractice = activeDictation?.id
        if !isPreview, !browsingWords, displayedPractice != serviceSnapshot?.practice?.activeDictation?.id { return nil }
        if !isPreview, !browsingWords, !showingReview, displayedPractice == nil,
           let visit = dailyDay?.memoryWindow?.visit {
            let displayed = presentedDailyDay?.memoryWindow?.visit
            if displayed?.id != visit.id || displayed?.showsFullCard != visit.showsFullCard { return nil }
        }
        if !isPreview, let pending = reviewInputs.first,
           let confirmed = currentReviewSession(for: pending.action) {
            let displayed = presentedReview(confirmed, for: pending.action)
            if MiniReviewInput.Cursor(displayed) != MiniReviewInput.Cursor(confirmed) {
                return nil
            }
        }
        if !isPreview, let card = visibleAnswerCard,
           viewedCardIdentity != card.id || !viewedCardSaved { return nil }
        return cardAudioPresentation
    }

    private var visibleAnswerCard: MiniAudioPresentation? {
        guard activeDictation == nil else { return nil }
        guard let card = cardAudioPresentation else { return nil }
        if browsingWords { return nil }
        if let record = reviewRecord, showingReview {
            return record.session.phase == .judgment ? card : nil
        }
        guard let day = presentedDailyDay else { return nil }
        switch day.phase {
        case .review: return day.memoryWindow != nil || day.review?.phase == .judgment ? card : nil
        case .learning:
            return day.retainedLearningWord != nil || day.nextUnstudiedWord != nil ? card : nil
        case .translation:
            guard let task = displayedTranslation(day) else { return nil }
            let attempt = day.translation.last { $0.taskID == task.id }
            return task.direction == .englishToChinese || (attempt?.feedback?.referenceTranslation != nil && attempt?.revisions?.isEmpty != false) ? card : nil
        case .finished: return nil
        }
    }

    private var visibleEnglishWord: MiniWord? {
        guard supplement == nil, !showingHome, !showingPlan else { return nil }
        if showingProbe, let probe = serviceSnapshot?.scheduling?.activeProbe {
            return probe.revealedAt != nil ? probe.word : nil
        }
        guard mode == .words else { return nil }
        if let practice = activeDictation {
            return practice.revealedAt != nil || !practice.attempts.isEmpty ? practice.word : nil
        }
        return visibleAnswerCard?.word
    }

    private func queueCardHide(_ word: MiniWord) {
        guard !isPreview, lastHiddenWord != word else { return }
        do {
            if !cardHidesLoaded { cardHides = try studyClient.pendingCardHides(); cardHidesLoaded = true }
            let action = MiniStudyAction(type: .hideCard, target: .daily, word: word)
            cardHides.append(MiniStudyCommand(expectedRevision: serviceSnapshot?.revision ?? 0, action: action))
            lastHiddenWord = word
            try studyClient.saveCardHides(cardHides)
        } catch {
            cardViewFailed = true
        }
    }

    private func loadBrowseOutbox() throws {
        if !browseOutboxLoaded {
            browseOutbox = try studyClient.pendingBrowseViews()
            browseOutboxLoaded = true
        }
    }

    private func browseViewportChanged(_ words: [MiniWord]) {
        guard !isPreview else { return }
        let changed = browseViewport.update(words, visible: audioWindowVisible, revision: serviceSnapshot?.revision ?? 0)
        guard !changed.isEmpty else { return }
        do {
            try loadBrowseOutbox()
            browseOutbox.append(contentsOf: changed)
            try studyClient.saveBrowseViews(browseOutbox)
        } catch { return }
        // Browsing doesn't lock the controls. Let rapid scrolls settle before sending.
        browseIdle?.cancel()
        let generation = serviceGeneration
        browseIdle = Task {
            do { try await Task.sleep(for: .milliseconds(160)) } catch { return }
            guard generation == serviceGeneration, !serviceBusy, pendingCommand == nil else { return }
            _ = await flushBrowseViews(generation: generation)
        }
    }

    private func flushBrowseViews(generation: UUID) async -> Bool {
        guard generation == serviceGeneration, !isPreview else { return false }
        if let browseDrain { return await browseDrain.value }
        do { try loadBrowseOutbox() } catch { return false }
        guard !browseOutbox.isEmpty else { return true }
        guard serviceSnapshot?.imported == true else { return false }
        let drain = Task { @MainActor in
            defer { if generation == serviceGeneration { browseDrain = nil } }
            do {
                while generation == serviceGeneration, !isPreview, var command = browseOutbox.first {
                    let snapshot: MiniStudySnapshot
                    do {
                        snapshot = try await studyClient.perform(command)
                    } catch MiniStudyClientError.conflict {
                        // An explicit conflict didn't save this observation. Keep its real time;
                        // after an uncertain outcome the original persisted identity is replayed.
                        let current = try await studyClient.snapshot()
                        guard generation == serviceGeneration, !isPreview else { return false }
                        command = MiniStudyCommand(expectedRevision: current.revision, action: command.action,
                                                   occurredAt: command.occurredAt)
                        browseOutbox[0] = command
                        try studyClient.saveBrowseViews(browseOutbox)
                        snapshot = try await studyClient.perform(command)
                    }
                    guard generation == serviceGeneration, !isPreview else { return false }
                    applySnapshot(snapshot)
                    browseOutbox.removeFirst()
                    // Only the head can have been sent. Give its unsent successor the
                    // acknowledged revision so a scroll does not cause one conflict per row.
                    if let next = browseOutbox.first, next.expectedRevision != snapshot.revision {
                        browseOutbox[0] = MiniStudyCommand(requestId: next.requestId, expectedRevision: snapshot.revision,
                                                          action: next.action, occurredAt: next.occurredAt)
                    }
                    try studyClient.saveBrowseViews(browseOutbox)
                }
                return generation == serviceGeneration && !isPreview
            } catch { return false }
        }
        browseDrain = drain
        return await drain.value
    }

    private func recordVisibleCardIfNeeded() {
        let card = visibleAnswerCard
        if viewedCardIdentity != card?.id {
            viewedCardIdentity = card?.id
            viewedCardSaved = false
            viewedCardVisit = UUID()
            cardViewFailed = false
            cardNeedsRefresh = false
        }
        guard !isPreview, !cardViewFailed, serviceSnapshot != nil else { return }
        // Capture a rendered review visit even when an earlier answer or hide is in flight.
        // Its cursor places that observation between the choice and the next card.
        if let card, card.enabled, audioWindowVisible, (!viewedCardSaved || cardNeedsRefresh),
           activeDictation == nil {
            let action = cardViewAction(card)
            let input: MiniReviewInput?
            if let day = presentedDailyDay, day.id == action.dayId, let visit = day.memoryWindow?.visit {
                input = MiniReviewInput(action: action, visit: visit)
            } else if let session = currentReviewSession(for: action), session.phase == .judgment {
                input = MiniReviewInput(action: action, session: presentedReview(session, for: action))
            } else { input = nil }
            if let input {
                if !cardViewRequests.values.contains(viewedCardVisit) {
                    cardViewRequests[input.id] = viewedCardVisit
                    appendReviewInput(input)
                }
                return
            }
        }
        guard !savingStudy, reviewInputs.isEmpty else { return }
        if let command = cardHides.first {
            submitCardHide(command)
            return
        }
        guard activeDictation == nil else { return }
        if cardNeedsRefresh, card == nil, audioWindowVisible, let word = visibleEnglishWord {
            submitStudyAction(MiniStudyAction(type: .recordCardView, target: .daily, word: word))
            return
        }
        guard !isPreview, (!viewedCardSaved || cardNeedsRefresh), !cardViewFailed, audioWindowVisible, !savingStudy,
              let card, card.enabled else { return }
        submitStudyAction(cardViewAction(card))
    }

    private func submitCardHide(_ command: MiniStudyCommand) {
        // This original envelope already lives in the visibility outbox. A delayed
        // close is checked against the word and visit time, even after the revision advances.
        serviceBusy = true
        let generation = serviceGeneration
        Task {
            let snapshot = try? await studyClient.perform(command)
            guard generation == serviceGeneration, !isPreview else { return }
            if let snapshot { applySnapshot(snapshot) }
            cardHides.removeAll { $0.requestId == command.requestId }
            try? studyClient.saveCardHides(cardHides)
            serviceBusy = false
        }
    }

    private func cardViewAction(_ card: MiniAudioPresentation) -> MiniStudyAction {
        var action = MiniStudyAction(type: .recordCardView, target: .daily)
        action.word = card.word
        if !showingReview, let day = presentedDailyDay, day.phase == .translation,
           let task = displayedTranslation(day), task.direction == .englishToChinese,
           task.id == day.currentTranslation?.id, !day.translation.contains(where: { $0.taskID == task.id }) {
            action.dayId = day.id
            action.taskId = task.id
            return action
        }
        if let context = card.context, showingReview || dailyDay?.phase != .translation {
            switch context {
            case .daily(let dayId, let session): action.dayId = dayId; action.session = session
            case .translation: break
            case .review(let recordId): action = MiniStudyAction(type: .recordCardView, target: .review, recordId: recordId, word: card.word)
            }
            if !showingReview, let day = dailyDay, day.phase == .learning, day.memoryWindow == nil,
               day.memory?.round == 2 {
                action.visibleSentence = savedSentence(for: card.word)
            } else if card.sequence != .word {
                action.visibleSentence = card.automaticSentence
            }
        }
        return action
    }

    private var cardAudioPresentation: MiniAudioPresentation? {
        guard supplement == nil, !showingHome, !showingPlan, !showingProbe, mode == .words, !editingList else { return nil }
        if let practice = activeDictation {
            let context: MiniAudioContext
            if practice.target == .review {
                guard let recordId = practice.recordId else { return nil }
                context = .review(recordId: recordId)
            } else {
                guard let dayId = practice.dayId else { return nil }
                context = .daily(dayId: dayId, session: practice.session)
            }
            return MiniAudioPresentation(id: "dictation:" + practice.id.uuidString.lowercased(),
                word: practice.word, context: context, automatic: false,
                enabled: true, preview: isPreview, sequence: .word)
        }
        if let record = reviewRecord, !browsingWords, showingReview, let word = record.session.currentWord {
            return reviewAudioPresentation(record.session, word: word, id: "review:" + record.id.uuidString.lowercased(),
                                           context: .review(recordId: record.id), paused: record.paused)
        }
        if browsingWords {
            let deck = words
            guard let index = browseIndex(in: deck) else { return nil }
            let word = deck[index]
            return MiniAudioPresentation(id: "browse:" + MiniAudioTarget.word(word).requestKey, word: word,
                                         context: nil, automatic: false, enabled: true, preview: isPreview)
        }
        guard let day = presentedDailyDay else { return nil }
        switch day.phase {
        case .review:
            if let visit = day.memoryWindow?.visit { return windowAudioPresentation(visit, day: day, session: .review) }
            guard let session = day.review, let word = session.currentWord else { return nil }
            return reviewAudioPresentation(session, word: word, id: "daily:" + day.id + ":review",
                                           context: .daily(dayId: day.id, session: .review), paused: day.paused)
        case .learning:
            if let word = day.retainedLearningWord ?? day.nextUnstudiedWord {
                guard let sentence = day.sentences.first(where: { $0.word == word }) else { return nil }
                guard lessonPreparation(for: day)?.readyToStudy == true else { return nil }
                if let visit = day.memoryWindow?.visit {
                    return windowAudioPresentation(visit, day: day, session: .learning)
                }
                let revealed = day.memoryShowsFullCard
                let memoryIdentity = day.memory.map { ":round:\($0.round):\($0.events.count):\($0.reveals.count):\($0.revealed)" } ?? ""
                return MiniAudioPresentation(id: "daily:" + day.id + ":new:" + MiniAudioTarget.word(word).requestKey + memoryIdentity,
                                             word: word, context: .daily(dayId: day.id, session: .learning),
                                             automatic: revealed,
                                             enabled: !day.paused, preview: isPreview,
                                             automaticSentence: revealed ? sentence : nil)
            }
            guard let session = day.learning, let word = session.currentWord else { return nil }
            return reviewAudioPresentation(session, word: word, id: "daily:" + day.id + ":learning-spelling",
                                           context: .daily(dayId: day.id, session: .learning), paused: day.paused)
        case .translation:
            guard let task = displayedTranslation(day) else { return nil }
            let context: MiniAudioContext = task.id == day.currentTranslation?.id
                ? .daily(dayId: day.id, session: nil) : .translation(dayId: day.id, taskId: task.id)
            return MiniAudioPresentation(id: "writing:" + task.id, word: task.sentence.word,
                                         context: context, automatic: false,
                                         enabled: !day.paused, preview: isPreview)
        case .finished: return nil
        }
    }

    private func windowAudioPresentation(_ visit: MiniMemoryWindow.Visit, day: MiniDailyDay,
                                         session: MiniStudyAction.Session) -> MiniAudioPresentation {
        let sequence: MiniAudioPresentation.Sequence = visit.showsFullCard ? .wordThenSentence
            : (visit.stage == 1 ? .sentence : .word)
        return MiniAudioPresentation(id: "window:" + visit.id.uuidString.lowercased() + (visit.showsFullCard ? ":revealed" : ":hidden"),
                                     word: visit.word, context: .daily(dayId: day.id, session: session),
                                     automatic: true, enabled: !day.paused, preview: isPreview,
                                     automaticSentence: savedSentence(for: visit.word),
                                     sequence: sequence)
    }

    private func reviewAudioPresentation(_ confirmed: MiniReviewSession, word confirmedWord: MiniWord, id: String,
                                         context: MiniAudioContext, paused: Bool) -> MiniAudioPresentation {
        let action: MiniStudyAction
        switch context {
        case .review(let record): action = MiniStudyAction(type: .recordCardView, target: .review, recordId: record)
        case .daily(let day, let part): action = MiniStudyAction(type: .recordCardView, target: .daily, dayId: day, session: part)
        case .translation: action = MiniStudyAction(type: .recordCardView, target: .daily)
        }
        let session = presentedReview(confirmed, for: action)
        let word = session.currentWord ?? confirmedWord
        let sequence = session.phase == .judgment
            ? session.judgmentEvents.filter { $0.final != nil }.count
            : session.spellingAttempts.filter { $0.kind == .first }.count
        return MiniAudioPresentation(id: id + ":\(session.phase.rawValue):\(sequence):\(session.currentJudgment?.rawValue ?? "hidden"):" + MiniAudioTarget.word(word).requestKey,
                                     word: word, context: context, automatic: session.phase == .judgment,
                                     enabled: !paused && session.phase != .finished, preview: isPreview,
                                     automaticSentence: session.currentJudgment == nil ? nil : savedSentence(for: word))
    }

    private var audioSentence: MiniStudySentence? {
        guard let card = cardAudioPresentation, !browsingWords else { return nil }
        if let day = presentedDailyDay, !showingReview {
            if day.phase == .translation { return displayedTranslation(day)?.sentence }
            if let visit = day.memoryWindow?.visit, visit.stage == 2, !visit.showsFullCard { return nil }
            if let memory = day.memory, memory.round == 3, !memory.revealed { return nil }
        }
        return savedSentence(for: card.word)
    }

    private func savedSentence(for word: MiniWord) -> MiniStudySentence? {
        if let sentence = dailyDay?.sentences.first(where: { $0.word == word }) { return sentence }
        return dailyLedger?.days.reversed().compactMap { day in
            day.sentences.first { $0.word == word }
        }.first
    }

    private var audioPrefetchTargets: [MiniAudioTarget] {
        guard !showingHome, !showingPlan, !showingProbe, !browsingWords, mode == .words else { return [] }
        if let record = reviewRecord, showingReview, !record.paused {
            return record.session.progressDots.map { .word($0.id) }
        }
        guard let day = dailyDay, !day.paused, day.phase != .finished else { return [] }
        let requiredWord = day.memoryWindow?.visit?.word ?? cardAudioPresentation?.word
        let current: [MiniAudioTarget] = requiredWord.map { word in
            [.word(word)] + (savedSentence(for: word).map { [.sentence($0)] } ?? [])
        } ?? []
        if day.phase == .review, studyIntent(for: day.id) == .review {
            return current + day.reviewWords.flatMap { word in
                [.word(word)] + (savedSentence(for: word).map { [.sentence($0)] } ?? [])
            }
        }
        return current + (day.reviewWords + day.preparationWords).map { .word($0) }
            + day.sentences.map { .sentence($0) }
    }

    private func synchronizeAudio() {
        let expectedID = audioPresentation?.id
        let expectedGeneration = serviceGeneration
        audio.update(audioPresentation, visible: audioWindowVisible, muted: effectiveAudioMuted) { revision in
            guard !isPreview, audioWindowVisible, serviceGeneration == expectedGeneration,
                  audioPresentation?.id == expectedID else { throw CancellationError() }
            if let revision, revision > (serviceSnapshot?.revision ?? -1) {
                try await refreshPlanContext(generation: expectedGeneration)
            }
            guard !isPreview, audioWindowVisible, serviceGeneration == expectedGeneration,
                  audioPresentation?.id == expectedID else { throw CancellationError() }
        }
        prefetchAudio()
    }

    private var audioPreparationScope: String {
        let mode = isPreview ? "preview:" : "study:"
        if let record = reviewRecord, showingReview { return mode + "review:" + record.id.uuidString.lowercased() }
        return mode + (dailyDay?.id ?? "none")
    }

    private func prefetchAudio() { audio.prefetch(audioPrefetchTargets, scope: audioPreparationScope) }

    private func playSpellingResult(_ word: MiniWord) {
        synchronizeAudio()
        if isPreview, studyAppearance.isSimple {
            audio.playPreviewSpellingResult(word)
        } else {
            audio.play(.word(word), automatic: true)
        }
    }

    private func lessonPreparation(for day: MiniDailyDay) -> MiniLessonPreparation? {
        guard day.phase == .learning else { return nil }
        let scope = audioPreparationScope
        let job = preparationJob(for: day, kind: .prepare)
        let preparingExamples = preparationDay == day.id || (preparationError == nil && (
            job?.status.isActive == true || (pendingAIRequest?.kind == .prepare && pendingAIRequest?.dayId == day.id)
        ))
        let examplesError = preparationError ?? job?.error
            ?? (aiSnapshot?.imported != true && !isPreview ? aiError : nil)
        let failed = examplesError != nil || job?.status == .cancelled || job?.status == .interrupted || job?.status == .failed
        return MiniLessonPreparation(day: day, preparingExamples: preparingExamples, examplesFailed: failed,
                                     examplesError: examplesError) { target in
            audio.preparationItem(for: target, scope: scope)
        }
    }

    private func retryLessonPreparation() {
        guard let day = dailyDay else { return }
        let words = day.preparationWords
        let included = Set(words)
        let sentences = day.sentences.filter { included.contains($0.word) }
        audio.retryPreparation(words.map { .word($0) } + sentences.map { .sentence($0) },
                               scope: audioPreparationScope)
        if !day.wordsToPrepare.isEmpty { startPreparation() }
    }

    @ViewBuilder
    private var audioControls: some View {
        if let card = cardAudioPresentation, activeDictation == nil {
            let showsWord = card.automatic || browsingWords || dailyDay?.memory?.currentWord != nil
                || (dailyDay?.phase == .learning && dailyDay?.nextUnstudiedWord != nil)
            HStack(spacing: 10) {
                audioPlayButton(.word(card.word), label: browsingWords ? card.word.spelling : (showsWord ? "读词" : "听词提示"))
                if let sentence = audioSentence { audioPlayButton(.sentence(sentence), label: showsWord ? "例句" : "英文提示") }
                Spacer(minLength: 0)
                if canOpenScratchpad {
                    Button { openScratchpad(card) } label: { Image(systemName: "pencil.and.outline") }
                        .help("草稿拼写").accessibilityLabel("草稿拼写")
                        .accessibilityIdentifier("openScratchpad")
                }
                Menu {
                    Button("Stop") { audio.stop() }
                    Button("Regenerate word") { audio.regenerate(.word(card.word)) }
                    if let sentence = audioSentence {
                        Button("Regenerate example") { audio.regenerate(.sentence(sentence)) }
                    }
                    Menu("Voice") {
                        ForEach(["ryan", "aiden", "serena"], id: \.self) { voice in
                            Button(voice.capitalized) { audio.regenerate(.word(card.word), voice: voice) }
                        }
                    }
                } label: { Image(systemName: "ellipsis.circle") }
                .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize().help("音频选项")
            }
            .font(.caption).buttonStyle(.borderless)
            .disabled(!card.enabled)
            .allowsHitTesting(audioPresentation != nil)
        }
    }

    private func audioPlayButton(_ target: MiniAudioTarget, label: String) -> some View {
        Button {
            guard !serviceBusy, pendingCommand == nil, !vocabularyBusy else { return }
            audio.play(target)
        } label: {
            HStack(spacing: 3) {
                switch target {
                case .word:
                    Image(systemName: "speaker.wave.2").frame(width: 14)
                case .sentence:
                    Image(systemName: "text.bubble").frame(width: 14)
                }
                if browsingWords { Text(label).lineLimit(1) }
            }
        }
        .help(label.contains("提示") ? "\(label) · 使用听音帮助" : label)
        .accessibilityLabel(label)
    }

    @ViewBuilder
    private var activeContent: some View {
        let deck = words
        let index = browseIndex(in: deck)
        if mode == .words, let practice = activeDictation {
            dictationContent(practice)
        } else if mode == .chat {
            chat(for: advisorChat ? nil : (browsingWords ? index.map { deck[$0] } : studyingWord))
        } else if browsingWords && editingList {
            listEditor
        } else if let record = reviewRecord, !browsingWords, showingReview {
            if record.paused {
                reviewPaused
            } else {
                MiniReviewView(
                    session: Binding(
                        get: { reviewRecord?.session ?? record.session },
                        set: { session in updateReview { $0.session = session } }
                    ),
                    onFinish: continueToLearning,
                    finishLabel: "Finish review",
                    sentenceForWord: savedSentence,
                    playWord: { audio.play(.word($0)) },
                    playSentence: { audio.play(.sentence($0)) },
                    playSpellingResult: playSpellingResult,
                    commands: isPreview ? nil : reviewCommands(target: .review, session: nil),
                    saving: savingStudyControls
                )
            }
        } else if browsingWords {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Image(systemName: "book.closed").foregroundStyle(.secondary)
                    Text(deckTitle)
                        .font(.callout.weight(.semibold)).lineLimit(1)
                    Text("\(deck.count) 词").font(.caption).foregroundStyle(.secondary)
                    Spacer(minLength: 4)
                    Button(vocabulary?.activeDeckId == nil ? "编辑" : "编辑自定义词表") {
                        listDraft = editableListText
                        listError = nil
                        editingList = true
                    }
                    .font(.caption).buttonStyle(.borderless).accessibilityLabel("编辑自定义词表")
                }
                if deck.isEmpty {
                    Text("词表为空").foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    MiniWordBrowser(words: deck, selection: Binding(get: { index }, set: { value in
                        if let value { move(to: value) }
                    }), visibleWordsChanged: browseViewportChanged)
                    .onDisappear { browseViewportChanged([]) }
                }
            }
        } else if let day = presentedDailyDay {
            dailyContent(day)
        } else {
            VStack(spacing: 8) {
                if dailyError == nil {
                    ProgressView().controlSize(.small).accessibilityLabel("准备每日学习")
                } else {
                    MiniStudyIconButton(title: "重试", systemImage: "arrow.clockwise", action: beginDaily)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func dailyContent(_ day: MiniDailyDay) -> some View {
        let continueToday: (() -> Void)? = isPreview
            ? (Calendar.current.isDateInToday(day.startedAt) ? nil : { resumeStudy() })
            : (planContext?.hasTaskAfterReview == true ? { resumeStudy() } : nil)
        let planOpener: (() -> Void)? = isPreview ? nil : { openLearningPlan() }
        let dayJob = aiSnapshot?.jobs.filter { $0.dayId == day.id && $0.kind != .advisor }
            .max { $0.createdAt < $1.createdAt }
        let cancel: (() -> Void)? = dayJob?.status.isActive == true
            ? { if let dayJob { Task { await controlAI(dayJob, retry: false) } } } : nil
        let lesson = lessonPreparation(for: day)
        let showReviews: ((Date) -> Void)? = isPreview ? nil : { openTranslationReview($0) }
        let previewWorksheet = previewTranslationWorksheet(day)
        let view = MiniDailyView(
            day: Binding(
                get: { presentedDailyDay ?? day },
                set: { replacement in
                    guard replacement.id == dailyDay?.id else { return }
                    updateDaily { $0 = replacement; return true }
                }
            ),
            preparing: preparationDay == day.id || preparationJob(for: day)?.status.isActive == true,
            preparationError: preparationError ?? preparationJob(for: day)?.error ?? aiError,
            grading: gradingAttempt != nil || feedbackJob(for: day)?.status.isActive == true,
            gradingError: gradingError ?? feedbackJob(for: day)?.error ?? aiError,
            retryPreparation: startPreparation,
            gradeTranslation: { Task { await gradeDailyTranslation() } },
            continueToday: continueToday,
            reviewGroupIndex: dailyLedger.flatMap { planContext?.reviewGroupIndex(for: day, in: $0) },
            hasNextReviewGroup: (planContext?.dueCount ?? 0) > day.reviewWords.count,
            commands: isPreview ? nil : dailyCommands(day),
            saving: savingStudyControls,
            pauseMessage: isPreview ? nil : pauseMessage(for: day),
            canResume: isPreview || planContext?.pendingGroups.first(where: { $0.dayId == day.id })?.canContinue == true,
            openPlan: planOpener,
            cancelAI: cancel,
            lessonPreparation: lesson,
            retryLessonPreparation: retryLessonPreparation,
            openTranslationReview: showReviews,
            playWord: { audio.play(.word($0)) },
            playSentence: { audio.play(.sentence($0)) },
            playSpellingResult: playSpellingResult,
            savedSentence: savedSentence,
            previewWindow: previewWindowCommands,
            previewLearningSpelling: previewSpellingCommands,
            previewAdvanceTranslation: previewTranslationAdvance,
            previewTranslationNavigation: previewWorksheet?.navigation,
            previewTranslationDraft: previewWorksheet?.draft
        )
        return view.id(day.id)
        #if DEBUG
        .safeAreaInset(edge: .bottom, spacing: 4) {
            if devStage == .learningPreparing, !day.wordsToPrepare.isEmpty {
                Button("Ready", action: startPreparation)
                    .font(.caption)
                    .accessibilityIdentifier("completePreviewPreparation")
            }
        }
        #endif
    }

    private func pauseMessage(for day: MiniDailyDay) -> String? {
        if let blocked = planContext?.pendingGroups.first(where: { $0.dayId == day.id })?.blockedReason { return blocked }
        return nil
    }

    private var titleBar: some View {
        GeometryReader { _ in
            ZStack {
                if !usesQuietStudyControls {
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
                }

                HStack(spacing: 4) {
                    modeTabs
                        .onGeometryChange(for: CGFloat.self, of: { $0.size.width }) { tabWidth = $0 }
                    MiniTitleDragRegion()
                        .frame(minWidth: 4, maxWidth: .infinity, maxHeight: .infinity)
                        .accessibilityHidden(true)
                    titleActions
                        .onGeometryChange(for: CGFloat.self, of: { $0.size.width }) { titleActionsWidth = $0 }
                }
                .padding(.leading, 76)
                .padding(.trailing, 8)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(height: 32)
    }

    private var titleActions: some View {
        HStack(spacing: 4) {
            Button {
                resetSupplement()
                if showingProbe { closeIndependentProbe(); return }
                showingHome = true
                showingPlan = false
                chatFocused = false
            } label: {
                Image(systemName: showingHome && supplement == nil ? "house.fill" : "house")
                    .frame(width: 20, height: 24)
            }
            .accessibilityLabel(showingHome && supplement == nil ? "首页" : "返回首页")
            .help("返回首页")
            .disabled(showingHome && supplement == nil)

            reviewMenu.disabled(showingProbe && serviceSnapshot?.scheduling?.activeProbe != nil)

            MiniVolumeControl(volume: $audioVolume, muted: isPreview ? $previewAudioMuted : $audioMuted)

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
                if item == .chat {
                    Rectangle()
                        .fill(Color(nsColor: .separatorColor))
                        .frame(width: 0.5, height: 10)
                        .accessibilityHidden(true)
                }
                let selected = supplement == nil && !showingHome && !showingPlan && mode == item
                Button {
                    selectModeTab(item)
                } label: {
                    Group {
                        if usesQuietStudyControls {
                            Image(systemName: item == .words ? "rectangle.on.rectangle" : "bubble.left")
                                .frame(width: 14)
                        } else {
                            Text(item.rawValue)
                        }
                    }
                        .font(.system(size: 10, weight: selected ? .semibold : .medium))
                        .lineLimit(1)
                        .padding(.horizontal, 7)
                        .frame(height: 18)
                        .contentShape(Rectangle())
                        .background(selected ? Color.primary.opacity(0.14) : .clear,
                                    in: RoundedRectangle(cornerRadius: 4))
                }
                .buttonStyle(.plain)
                .disabled(showingProbe || (item == .chat && inJudgmentReview))
                .help(usesQuietStudyControls ? item.rawValue : "")
                .accessibilityLabel(item.rawValue)
                .accessibilityAddTraits(selected ? .isSelected : [])
            }
        }
        .padding(1)
        .background(Color.primary.opacity(0.07), in: RoundedRectangle(cornerRadius: 5))
        .fixedSize()
        .accessibilityElement(children: .contain)
        .accessibilityLabel("模式")
    }

    private func selectModeTab(_ item: Mode) {
        if showingHome || showingPlan || supplement != nil {
            browsingWords = false
            editingList = false
        }
        if item == .words, !browsingWords, !hasStudyToReturnTo {
            resetSupplement()
            showingHome = true
            showingPlan = false
            mode = .words
            chatFocused = false
            return
        }
        openMode(item)
    }

    private func openWordBrowser() {
        browsingWords = true
        editingList = false
        openMode(.words)
    }

    private func openMode(_ item: Mode) {
        let opensAdvisor = item == .chat && (showingHome || showingPlan || supplement != nil || (mode == .chat && advisorChat))
        resetSupplement()
        mode = item
        advisorChat = opensAdvisor
        showingHome = false
        showingPlan = false
        showingProbe = false
        chatFocused = item == .chat
    }

    private func resetSupplement() {
        supplement = nil
        patternStart = nil
        patternsBeforeNextGroup = false
    }

    private func openSupplement(_ destination: Supplement) {
        guard (!isPreview || destination == .learnedPatterns), !showingProbe else { return }
        audio.stop()
        resetSupplement()
        chatFocused = false
        supplement = destination
    }

    private func openTranslationReview(_ date: Date) {
        translationReviewDate = date
        openSupplement(.translations)
    }

    private var translationReviewContent: some View {
        let client = MiniAssessmentClient(study: studyClient)
        let timezone = planContext.flatMap { TimeZone(identifier: $0.timezone) } ?? .current
        return MiniTranslationReviewView(date: translationReviewDate, timezone: timezone, load: { date, zone in
            try await client.translations(date: date, timezone: zone)
        }, retryJob: { job, request in
            _ = try await client.retry(job, requestId: request)
        }, gradeMissing: { date, zone in
            try await client.gradeMissing(date: date, timezone: zone)
        }, close: resetSupplement)
    }

    private func leavePatterns() {
        let intent = patternStart
        let prepare = patternsBeforeNextGroup
        if intent != nil || prepare { introducedPatternDate = planContext?.date }
        resetSupplement()
        if let intent {
            resumeStudy(intent.entry, dayId: intent.dayId,
                        extraGroupForDate: intent.extraGroupForDate, introduced: true)
        } else if prepare { startPreparation() }
    }

    private var canIntroduceAtBoundary: Bool {
        !showingHome && !showingPlan && !showingProbe && !browsingWords && mode == .words &&
            supplement == nil && introducedPatternDate != planContext?.date
    }

    private var dialogueContent: some View {
        MiniDialogueView(snapshot: aiSnapshot, busy: aiSubmitting || pendingAIRequest != nil,
                         error: aiError, client: patternClient,
                         draft: { id in
            Binding(get: { chatDrafts[id, default: ""] }, set: { text in
                chatDrafts[id] = text
                try? chatStorage.saveDrafts(chatDrafts)
            })
        }, start: { id, message, reflect in
            Task {
                await startAI(MiniAIStart(kind: .dialogue, conversationId: id, message: message,
                                          dialogueStep: reflect ? "reflect" : nil, model: aiSelection.model,
                                          effort: aiSelection.effort))
            }
        }, control: { job, retry in Task { await controlAI(job, retry: retry) } },
                         reconnect: { Task { await connectAI(generation: serviceGeneration) } },
                         patterns: { openSupplement(.patterns) })
    }

    private func studyIntent(for dayId: String) -> MiniStudyIntent {
        if let intent = serviceSnapshot?.planning.sessions.last(where: { $0.dayId == dayId })?.intent { return intent }
        if let day = serviceSnapshot?.ledger.days.last(where: { $0.id == dayId }), day.phase == .review,
           planContext?.learningAvailable == false { return .review }
        return .learn
    }

    private func resumeStudy(_ entry: MiniStudyIntent? = nil, dayId: String? = nil,
                             extraGroupForDate: String? = nil, introduced: Bool = false) {
        let entry = entry ?? dayId.map { studyIntent(for: $0) } ?? .learn
        if isPreview {
            localReviewIntent = entry
            browsingWords = false
            openMode(.words)
            return
        }
        guard serviceSnapshot != nil, let planContext else {
            beginDaily()
            return
        }
        guard planContext.matchesLocalDay(at: .now, in: .autoupdatingCurrent) else {
            refreshPlanDateIfNeeded()
            return
        }
        guard !savingStudyControls else { return }
        if let extraGroupForDate {
            guard planContext.canStartExtraGroup == true, planContext.date == extraGroupForDate else { return }
        }
        if let probe = serviceSnapshot?.scheduling?.activeProbe {
            submitStudyAction(probeAction(.endProbe, probe: probe), afterSave: {
                resumeStudy(entry, dayId: dayId,
                            extraGroupForDate: extraGroupForDate, introduced: introduced)
            })
            return
        }
        if extraGroupForDate == nil, dayId == nil, let record = reviewRecord, showingReview {
            localReviewIntent = entry
            if record.paused {
                var action = MiniStudyAction(type: .pause, target: .review, recordId: record.id)
                action.paused = false
                submitStudyAction(action, afterSave: {
                    browsingWords = false
                    openMode(.words)
                })
            } else {
                browsingWords = false
                openMode(.words)
            }
            return
        }
        let intent = MiniPatternStartIntent(dayId: dayId,
                                            entry: entry, extraGroupForDate: extraGroupForDate)
        if !introduced, introducedPatternDate != planContext.date,
           intent.offersIntroduction(planContext) {
            openSupplement(.patterns)
            patternStart = intent
            return
        }
        resetSupplement()
        var action = MiniStudyAction(type: .begin, target: .daily)
        action.deck = words
        action.flowVersion = "sliding-window-v2"
        action.intent = entry
        action.timezone = planContext.timezone
        action.dayId = dayId
        action.extraGroupForDate = extraGroupForDate
        submitStudyAction(action, afterSave: {
            preferLegacyReview = false
            browsingWords = false
            openMode(.words)
            if dailyDay?.wordsToPrepare.isEmpty == false, dailyDay?.paused == false {
                startPreparation()
            }
        })
    }

    @ViewBuilder
    private var reviewMenu: some View {
        let labels = stageLabels
        if #available(macOS 14.4, *) {
            MiniStageMenuButton(title: labels.title, accessibilityLabel: "当前阶段：\(labels.spoken)", content: reviewMenuItems)
                .fixedSize()
        } else {
            Menu { reviewMenuItems } label: {
                Text(labels.title).font(.system(size: 10, weight: .medium)).lineLimit(1)
            }
            .font(.system(size: NSFont.menuFont(ofSize: 0).pointSize))
            .controlSize(.regular)
            .menuStyle(.borderlessButton)
            .fixedSize()
            .accessibilityLabel("当前阶段：\(labels.spoken)")
        }
    }

    @ViewBuilder
    private var reviewMenuItems: some View {
        let onCard = !showingHome && !showingPlan && !showingProbe && supplement == nil && !browsingWords && mode == .words
        if onCard, let record = reviewRecord, showingReview, record.session.phase != .finished {
            Button(record.paused ? "Resume" : "Pause") { pauseLegacyReview(!record.paused) }
            Divider()
        } else if onCard, !showingReview, hasStudyToReturnTo, let day = dailyDay {
            Button(day.paused ? "Resume" : "Pause") {
                if day.paused { resumeStudy(dayId: day.id) } else { pauseDaily(true) }
            }
            Divider()
        }
        if browsingWords, !showingHome, !showingPlan, !showingProbe, supplement == nil, hasStudyToReturnTo {
            Button("返回学习") {
                browsingWords = false
                editingList = false
                openMode(.words)
            }
        }
        Button(studyMenuTitle("浏览词表", english: "Word list"), systemImage: "book.closed", action: openWordBrowser)
            .disabled(browsingWords && !editingList && mode == .words && !showingHome && !showingPlan && supplement == nil)
        Button(studyMenuTitle("学习计划", english: "Plan"), systemImage: "calendar", action: openLearningPlan)
            .disabled(isPreview || (showingPlan && supplement == nil))
        Menu(studyMenuTitle("专项练习", english: "Practice"), systemImage: "pencil.and.outline") {
            Button(studyMenuTitle("起手句式", english: "Patterns")) { openSupplement(.patterns) }
            Button(studyMenuTitle("英文对话", english: "Dialogue")) { openSupplement(.dialogue) }
            Button(serviceSnapshot?.scheduling?.activeProbe == nil
                   ? studyMenuTitle("独立拼写检验", english: "Spelling check")
                   : studyMenuTitle("继续独立拼写检验", english: "Resume check"),
                   action: openIndependentProbe).disabled(savingStudy)
        }
        .disabled(isPreview || showingProbe)
        if let record = reviewRecord, !record.continuedToLearning, !showingReview {
            Button(studyMenuTitle("继续旧复习", english: "Resume saved review")) { preferLegacyReview = true; resumeStudy(.review) }
                .disabled(savingStudy)
        }
        Divider()
        Button(studyMenuTitle("记忆曲线…", english: "Memory curve…"), systemImage: "chart.xyaxis.line") {
            NotificationCenter.default.post(name: .miniOpenMemoryWindow, object: nil)
        }
        Button(studyMenuTitle("设置…", english: "Settings…"), systemImage: "gearshape") { settings = .display }
        Button(studyMenuTitle("AI 设置…", english: "AI settings…"), systemImage: "slider.horizontal.3") { settings = .ai }
        #if DEBUG
        Divider()
        MiniDevMenu(stage: devStage, select: selectDevStage)
        #endif
    }

    private func studyMenuTitle(_ title: String, english: String) -> String {
        usesQuietStudyControls ? english : title
    }

    private var displaySettings: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("设置").font(.headline)
            HStack(spacing: 12) {
                Text("词卡字号").accessibilityHidden(true)
                Picker("词卡字号", selection: $cardTextSize) {
                    ForEach(MiniCardTextSize.allCases, id: \.self) { size in
                        Text(size.label).tag(size)
                    }
                }
                .labelsHidden()
                .pickerStyle(.segmented)
                .accessibilityIdentifier("cardTextSize")
            }
            HStack(spacing: 12) {
                Text("学习样式").accessibilityHidden(true)
                Picker("学习样式", selection: $studyAppearance) {
                    ForEach(MiniStudyAppearance.allCases, id: \.self) { appearance in
                        Text(appearance.label).tag(appearance)
                    }
                }
                .labelsHidden()
                .pickerStyle(.segmented)
                .accessibilityIdentifier("studyAppearance")
            }
            HStack {
                Spacer()
                Button("完成") { settings = nil }
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(16)
        .frame(width: 270)
    }

    private var reviewPaused: some View {
        VStack(spacing: 12) {
            Text("Paused").font(.headline)
            Button("Resume") { pauseLegacyReview(false) }
                .miniStudyButton(prominent: true)
                .accessibilityLabel("继续复习")
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func dictationContent(_ practice: MiniDictation) -> some View {
        MiniDictationPracticeView(practice: practice,
                                  draft: isPreview ? $previewDictationDraft
                                    : draftBinding(key: "dictation/" + practice.id.uuidString.lowercased(),
                                                   fallback: practice.attempts.last?.answer ?? ""),
                                  submit: { answer in
            var action = dictationAction(.submitDictation, practice: practice)
            action.answer = answer
            enqueueDictationInput(action, from: practice)
        }, reveal: {
            enqueueDictationInput(dictationAction(.revealDictation, practice: practice), from: practice)
        }, close: {
            enqueueDictationInput(dictationAction(.closeDictation, practice: practice), from: practice)
        })
        .id(practice.id)
    }

    private func enqueueDictationInput(_ action: MiniStudyAction, from practice: MiniDictation) {
        guard let current = activeDictation, current.id == practice.id,
              (action.type != .submitDictation || current.attempts.count == practice.attempts.count),
              let input = MiniReviewInput(action: action, practice: current) else { return }
        if isPreview {
            var displayed = previewDictation
            input.presentDictation(in: &displayed)
            previewDictation = displayed
            if action.type == .submitDictation { playSpellingResult(practice.word) }
            return
        }
        appendReviewInput(input)
    }

    private var canOpenScratchpad: Bool {
        guard mode == .words, !browsingWords, activeDictation == nil else { return false }
        if showingReview, let record = reviewRecord {
            let action = MiniStudyAction(type: .openDictation, target: .review, recordId: record.id)
            return presentedReview(record.session, for: action).currentJudgment != nil
        }
        guard let day = presentedDailyDay, !day.paused else { return false }
        if let visit = day.memoryWindow?.visit { return visit.showsFullCard }
        if day.phase == .review, let session = day.review {
            let action = MiniStudyAction(type: .openDictation, target: .daily, dayId: day.id, session: .review)
            return presentedReview(session, for: action).currentJudgment != nil
        }
        return day.phase == .learning && day.memoryShowsFullCard
            && (day.memory != nil || day.retainedLearningWord != nil)
    }

    private func openScratchpad(_ card: MiniAudioPresentation) {
        guard canOpenScratchpad, cardAudioPresentation?.id == card.id, let context = card.context else { return }
        let action: MiniStudyAction
        switch context {
        case .translation: return
        case .daily(let dayId, let session):
            action = MiniStudyAction(type: .openDictation, target: .daily, dayId: dayId, session: session, word: card.word)
        case .review(let recordId):
            action = MiniStudyAction(type: .openDictation, target: .review, recordId: recordId, word: card.word)
        }
        if isPreview {
            previewDictationDraft = ""
            previewDictation = MiniDictation(id: UUID(), target: action.target, dayId: action.dayId,
                recordId: action.recordId, session: action.session, word: card.word,
                openedAt: .now, closedAt: nil, revealedAt: nil, attempts: [])
        } else {
            recordVisibleCardIfNeeded()
            if let visit = presentedDailyDay?.memoryWindow?.visit,
               let input = MiniReviewInput(action: action, visit: visit) {
                appendReviewInput(input)
            } else if let session = currentReviewSession(for: action, displaying: true),
                      let input = MiniReviewInput(action: action, session: presentedReview(session, for: action)) {
                appendReviewInput(input)
            } else {
                submitStudyAction(action)
            }
        }
    }

    private func dictationAction(_ kind: MiniStudyAction.Kind, practice: MiniDictation) -> MiniStudyAction {
        var action = MiniStudyAction(type: kind, target: practice.target, dayId: practice.dayId,
                                    recordId: practice.recordId, session: practice.session)
        action.dictationId = practice.id
        return action
    }

    private var probeContent: some View {
        let probe = serviceSnapshot?.scheduling?.activeProbe
        let draft = probe.map { draftBinding(key: "probe/" + $0.id.uuidString.lowercased(), fallback: "") } ?? .constant("")
        return MiniIndependentProbeView(scheduling: serviceSnapshot?.scheduling, draft: draft, saving: savingStudy,
                                        begin: { word in
            var action = MiniStudyAction(type: .beginProbe, target: .daily)
            action.word = word
            submitStudyAction(action)
        }, submit: { answer in
            guard let probe else { return }
            var action = probeAction(.submitProbe, probe: probe)
            action.answer = answer
            submitStudyAction(action)
        }, reveal: {
            guard let probe else { return }
            submitStudyAction(probeAction(.revealProbe, probe: probe))
        }, end: {
            guard let probe else { return }
            submitStudyAction(probeAction(.endProbe, probe: probe))
        }, close: closeIndependentProbe)
    }

    private func probeAction(_ kind: MiniStudyAction.Kind, probe: MiniProbe) -> MiniStudyAction {
        var action = MiniStudyAction(type: kind, target: .daily)
        action.probeId = probe.id
        return action
    }

    private func openIndependentProbe() {
        guard !isPreview, !savingStudy else { return }
        browseViewportChanged([])
        audio.stop()
        if let card = visibleAnswerCard, audioWindowVisible {
            submitStudyAction(cardViewAction(card), afterSave: { showIndependentProbe() })
        } else { showIndependentProbe() }
    }

    private func showIndependentProbe() {
        resetSupplement()
        showingProbe = true
        showingHome = false
        showingPlan = false
        mode = .words
        chatFocused = false
        beginDaily()
    }

    private func closeIndependentProbe() {
        if let probe = serviceSnapshot?.scheduling?.activeProbe {
            submitStudyAction(probeAction(.endProbe, probe: probe), afterSave: {
                showingProbe = false
                showingHome = true
            })
        } else {
            showingProbe = false
            showingHome = true
        }
    }

    @ViewBuilder
    private var planContent: some View {
        if let snapshot = serviceSnapshot, let context = planContext {
            MiniPlanView(planning: snapshot.planning, context: context, saving: savingStudy,
                         notice: planNotice,
                         saveLongTerm: { plan in
                var action = MiniStudyAction(type: .setLongTermPlan, target: .daily)
                action.plan = plan
                savePlanAction(action)
            }, saveToday: { mode, budget in
                var action = MiniStudyAction(type: .setTodayPlan, target: .daily)
                action.date = context.date
                action.timezone = context.timezone
                action.mode = mode
                action.wordLimit = budget.wordLimit
                action.newWordLimit = budget.newWordLimit

                action.dailyNewGoal = budget.effectiveDailyGoal
                action.groupSize = budget.effectiveGroupSize
                savePlanAction(action)
            }, clearToday: {
                var action = MiniStudyAction(type: .clearTodayPlan, target: .daily)
                action.date = context.date
                action.timezone = context.timezone
                savePlanAction(action)
            }, vocabulary: vocabulary, vocabularyError: vocabularyError, activateDeck: { activateVocabulary($0, order: $1) },
                         startCourse: {
                if context.learningAvailable { resumeStudy(.learn) }
                else if context.canStartExtraGroup == true { resumeStudy(.learn, extraGroupForDate: context.date) }
            })
        } else {
            VStack(spacing: 8) {
                if serviceBusy { ProgressView("读取学习计划…").controlSize(.small) }
                else {
                    Text("学习计划暂不可用").font(.headline)
                    Button("重试读取", action: beginDaily)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func openLearningPlan() {
        guard !isPreview else { return }
        resetSupplement()
        showingPlan = true
        showingProbe = false
        preferLegacyReview = false
        showingHome = false
        chatFocused = false
        planNotice = nil
        beginDaily()
    }

    private func loadVocabulary(generation: UUID) async throws {
        var catalog = try await vocabularyClient.catalog()
        guard generation == serviceGeneration, !isPreview else { return }
        pendingVocabulary = try vocabularyClient.pending()
        if let request = pendingVocabulary {
            do {
                catalog = try await vocabularyClient.activate(request)
                try vocabularyClient.clearPending(request.requestId)
                pendingVocabulary = nil
            } catch MiniStudyClientError.conflict {
                try vocabularyClient.clearPending(request.requestId)
                pendingVocabulary = nil
                vocabularyError = "词库选择已变化，请重新选择。"
            } catch MiniStudyClientError.rejected {
                try vocabularyClient.clearPending(request.requestId)
                pendingVocabulary = nil
                vocabularyError = "这次词库选择未被接受，请重新选择。"
            }
        }
        guard generation == serviceGeneration, !isPreview else { return }
        vocabulary = catalog
    }

    private func activateVocabulary(_ deckId: String?, order: MiniVocabularyOrder? = nil) {
        guard !isPreview, !savingStudy, let vocabulary else { return }
        transmitVocabulary(MiniVocabularyActivation(expectedRevision: vocabulary.revision, deckId: deckId, order: order))
    }

    private func transmitVocabulary(_ request: MiniVocabularyActivation) {
        vocabularyBusy = true
        vocabularyError = nil
        let generation = serviceGeneration
        Task {
            defer { if generation == serviceGeneration { vocabularyBusy = false } }
            do {
                try vocabularyClient.savePending(request)
                pendingVocabulary = request
                let catalog = try await vocabularyClient.activate(request)
                try vocabularyClient.clearPending(request.requestId)
                guard generation == serviceGeneration, !isPreview else { return }
                pendingVocabulary = nil
                vocabulary = catalog
                planNotice = nil
                try await refreshPlanContext(generation: generation)
            } catch MiniStudyClientError.conflict {
                try? vocabularyClient.clearPending(request.requestId)
                guard generation == serviceGeneration, !isPreview else { return }
                pendingVocabulary = nil
                vocabularyError = "词库选择已变化，请重新读取后选择。"
                vocabulary = try? await vocabularyClient.catalog()
            } catch MiniStudyClientError.rejected {
                try? vocabularyClient.clearPending(request.requestId)
                guard generation == serviceGeneration, !isPreview else { return }
                pendingVocabulary = nil
                vocabularyError = "这次词库选择未被接受，请重新选择。"
            } catch {
                guard generation == serviceGeneration, !isPreview else { return }
                try? vocabularyClient.clearPending(request.requestId)
                pendingVocabulary = nil
            }
        }
    }

    private func savePlanAction(_ action: MiniStudyAction) {
        planNotice = nil
        submitStudyAction(action)
    }

    private func readCurrentPlan() async throws -> MiniStudySnapshot {
        let timezone = TimeZone.autoupdatingCurrent
        let snapshot = try await studyClient.planPreview(deck: words, timezone: timezone.identifier)
        guard snapshot.planContext?.matchesLocalDay(at: .now, in: .autoupdatingCurrent) == true else {
            throw MiniStudyClientError.invalidResponse
        }
        return snapshot
    }

    private func refreshPlanContext(generation: UUID) async throws {
        let deckRevision = vocabulary?.revision
        let snapshot = try await readCurrentPlan()
        guard generation == serviceGeneration, !isPreview, vocabulary?.revision == deckRevision else { return }
        applySnapshot(snapshot)
    }

    private func refreshPlanDateIfNeeded() {
        let now = Date.now
        guard !isPreview, serviceSnapshot?.imported == true, !serviceBusy, !refreshingPlanDate,
              planContext?.matchesLocalDay(at: now, in: .autoupdatingCurrent) != true else { return }
        if planContext?.includesDate(now) == false, !showingPlan, !showingProbe, !browsingWords,
           (supplement == nil && (mode == .words || !advisorChat)) || patternStart != nil || patternsBeforeNextGroup {
            resetSupplement()
            showingHome = true
            preferLegacyReview = false
            activeDailyID = nil
        }
        let generation = serviceGeneration
        refreshingPlanDate = true
        Task {
            defer { if generation == serviceGeneration { refreshingPlanDate = false } }
            do { try await refreshPlanContext(generation: generation) }
            catch {
                guard generation == serviceGeneration,
                      planContext?.matchesLocalDay(at: .now, in: .autoupdatingCurrent) != true else { return }
                planContext = nil
                dailyError = "暂时无法读取今天的学习计划。"
            }
        }
    }

    private func beginDaily() {
        guard !isPreview, !serviceBusy else { return }
        serviceBusy = true
        let generation = serviceGeneration
        Task { await connectDaily(generation: generation) }
    }

    @discardableResult
    private func updateDaily(_ update: (inout MiniDailyDay) -> Bool) -> Bool {
        guard isPreview, var ledger = dailyLedger,
              let index = ledger.days.lastIndex(where: { $0.id == activeDailyID }) else { return false }
        guard update(&ledger.days[index]) else { return false }
        dailyLedger = ledger
        dailyError = nil
        return true
    }

    private func applySnapshot(_ snapshot: MiniStudySnapshot) {
        if let current = serviceSnapshot, snapshot.revision < current.revision { return }
        serviceSnapshot = snapshot
        dailyLedger = snapshot.ledger
        reviewRecord = snapshot.reviewRecord
        if let context = snapshot.planContext { planContext = context }
        let selectedID = snapshot.planning.activeDayId
        let selectedDay = selectedID.flatMap { id in snapshot.ledger.days.last { $0.id == id } }
        let day = selectedDay.flatMap { value in
            planContext?.includesDay(value) == true ? value : nil
        }
        let finishingReview = pendingCommand?.action.type == .completeReview && pendingCommand?.action.dayId == activeDailyID
        if day == nil, activeDailyID != nil, !finishingReview, !browsingWords, !showingProbe, !showingPlan,
           mode == .words, supplement == nil {
            showingHome = true
        }
        if day?.id != activeDailyID {
            preparationError = nil
            gradingError = nil
            if !browsingWords, day?.phase == .review { mode = .words }
        }
        activeDailyID = day?.id
        if day?.paused == true || day?.phase == .finished {
            preparationDay = nil
        }
        dailyError = nil
        reviewError = nil
    }

    private func connectDaily(generation: UUID) async {
        defer { if generation == serviceGeneration { serviceBusy = false } }
        do {
            if !inputDraftsLoaded {
                _ = await MiniStudyClient.draftJournal.flushed()
                let client = studyClient
                let drafts = try await MiniStudyClient.draftJournal.perform { try client.loadDrafts() }
                guard generation == serviceGeneration, !isPreview else { return }
                inputDrafts = drafts
                inputDraftsLoaded = true
            }
            if !cardHidesLoaded { cardHides = try studyClient.pendingCardHides(); cardHidesLoaded = true }
            try await loadVocabulary(generation: generation)
            guard generation == serviceGeneration, !isPreview else { return }
            var snapshot = try await studyClient.snapshot()
            guard generation == serviceGeneration, !isPreview else { return }
            if !snapshot.imported {
                let legacy = try studyClient.prepareLegacyImport()
                snapshot = try await studyClient.importLegacy(legacy)
                try studyClient.recordImportReceipt(snapshot)
            }
            guard generation == serviceGeneration, !isPreview else { return }
            applySnapshot(snapshot)
            _ = await MiniStudyClient.reviewJournal.flushed()
            let client = studyClient
            let (queued, transmitting) = try await MiniStudyClient.reviewJournal.perform {
                (try client.pendingReviewInputs(), try client.pendingCommand())
            }
            guard generation == serviceGeneration, !isPreview else { return }
            reviewInputs = queued
            pendingCommand = transmitting
            if let pendingCommand {
                let input = queued.first { $0.id == pendingCommand.requestId }
                let recovered = await transmitStudyCommand(pendingCommand, generation: generation,
                                                           remainingRebases: input == nil ? 0 : 3)
                guard generation == serviceGeneration, !isPreview else { return }
                if !recovered, pendingCommand.action.type == .hideCard {
                    cardHides.removeAll { $0.requestId == pendingCommand.requestId }
                    try studyClient.saveCardHides(cardHides)
                } else if !recovered {
                    guard let input else { return }
                    if input.action.type == .recordCardView { reviewInputs.removeAll { $0.id == input.id } }
                    else { reviewInputs.removeAll() }
                    MiniStudyClient.reviewJournal.replace(reviewInputs)
                }
            }
            guard await flushBrowseViews(generation: generation) else { return }
            try await refreshPlanContext(generation: generation)
            serviceBusy = false
            await connectAI(generation: generation)
            guard generation == serviceGeneration, !isPreview else { return }
            audio.recover(preview: false)
        } catch is DecodingError {
            guard generation == serviceGeneration else { return }
            dailyError = "学习记录或恢复文件格式损坏，迁移已停止。原文件已保留，请先检查本机记录。"
        } catch {
            guard generation == serviceGeneration else { return }
            dailyError = "无法读取本机学习服务或迁移旧记录。已有文件已保留，请重试。"
        }
    }

    private func submitStudyAction(_ action: MiniStudyAction, afterSave: (() async -> Void)? = nil) {
        guard !isPreview, !savingStudyControls, serviceSnapshot != nil else { return }
        if action.type == .begin || action.type == .beginProbe { browseViewportChanged([]) }
        serviceBusy = true
        let generation = serviceGeneration
        let occurredAt = Date.now
        Task {
            while audio.authorizing {
                do { try await Task.sleep(for: .milliseconds(20)) }
                catch {
                    if generation == serviceGeneration { serviceBusy = false }
                    return
                }
                guard generation == serviceGeneration, !isPreview else { return }
            }
            guard await flushBrowseViews(generation: generation) else {
                if generation == serviceGeneration { serviceBusy = false }
                return
            }
            guard generation == serviceGeneration, !isPreview, let snapshot = serviceSnapshot else { return }
            let command = MiniStudyCommand(expectedRevision: snapshot.revision, action: action, occurredAt: occurredAt)
            if action.type == .recordCardView { cardViewRequests[command.requestId] = viewedCardVisit }
            let saved = await transmitStudyCommand(command, generation: generation, conflictSnapshot: snapshot)
            guard generation == serviceGeneration else { return }
            serviceBusy = false
            if !saved, action.type == .recordCardView { cardViewFailed = true }
            if saved { await afterSave?() }
        }
    }

    private func transmitStudyCommand(_ command: MiniStudyCommand, generation: UUID, remainingRebases: Int = 1,
                                      conflictSnapshot: MiniStudySnapshot? = nil) async -> Bool {
        let before = conflictSnapshot ?? serviceSnapshot
        let observation = command.action.type == .recordCardView || command.action.type == .hideCard
        do {
            try await studyClient.persistPending(command)
            guard generation == serviceGeneration, !isPreview else { return false }
            pendingCommand = command
            let snapshot = try await studyClient.perform(command)
            guard generation == serviceGeneration, !isPreview else { return true }
            let queued = reviewInputs.contains { $0.id == command.requestId }
            if !queued { try await studyClient.releasePending(command.requestId) }
            applySnapshot(snapshot)
            if queued {
                // Keep the exact acknowledged envelope (including its expected revision)
                // until recovery can no longer replay this intent from the input journal.
                // An exposure can be accepted without changing the displayed input cursor.
                reviewInputs.removeAll { $0.id == command.requestId }
                MiniStudyClient.reviewJournal.replace(reviewInputs)
                if await MiniStudyClient.reviewJournal.flushed() {
                    try? await studyClient.releasePending(command.requestId)
                }
                guard generation == serviceGeneration, !isPreview else { return true }
            }
            pendingCommand = nil
            if command.action.type == .recordCardView, cardViewRequests[command.requestId] == viewedCardVisit {
                viewedCardSaved = true
                cardViewFailed = false
                cardNeedsRefresh = false
            }
            cardViewRequests.removeValue(forKey: command.requestId)
            if command.action.type == .recordCardView { cardNeedsRefresh = false }
            if command.action.type == .hideCard {
                cardHides.removeAll { $0.requestId == command.requestId }
                try studyClient.saveCardHides(cardHides)
                cardViewFailed = false
            }
            clearSubmittedDraft(command.action)
            if command.action.type == .continueToLearning, let record = snapshot.reviewRecord {
                move(to: record.nextWordIndex)
            }
            // The response is an authoritative study snapshot. These actions do not
            // change a plan or switch groups. The finish command refreshes the plan.
            switch command.action.type {
            case .chooseJudgment, .advanceJudgment, .submitSpelling, .advanceSpelling, .recordCardView, .hideCard,
                 .windowChoose, .windowCorrect, .windowDraft, .openDictation, .submitDictation, .revealDictation, .closeDictation:
                break
            case .windowAdvance, .windowFamiliar:
                if dailyDay?.memoryWindow?.visit != nil { break }
                fallthrough
            default:
                do { try await refreshPlanContext(generation: generation) }
                catch {
                    guard generation == serviceGeneration else { return true }
                    planContext = nil
                }
            }
            return true
        } catch MiniStudyClientError.conflict {
            do {
                let snapshot = try await readCurrentPlan()
                guard generation == serviceGeneration, !isPreview else { return false }
                let expired = command.action.dayId.flatMap { id in
                    snapshot.ledger.days.first { $0.id == id }
                }.map { snapshot.planContext?.includesDay($0) == false } ?? false
                let queued = reviewInputs.first { $0.id == command.requestId }
                if !expired, remainingRebases > 0, let before, let occurredAt = command.occurredAt,
                   (queued?.matches(snapshot) ??
                    MiniStudyClient.eligibleRebase(command: command, before: before, after: snapshot)) {
                    applySnapshot(snapshot)
                    let retry = MiniStudyCommand(requestId: queued?.id ?? UUID(), expectedRevision: snapshot.revision, action: command.action,
                                                 occurredAt: occurredAt)
                    if let visit = cardViewRequests.removeValue(forKey: command.requestId) { cardViewRequests[retry.requestId] = visit }
                    if command.action.type == .hideCard, let index = cardHides.firstIndex(where: { $0.requestId == command.requestId }) {
                        cardHides[index] = retry
                        try studyClient.saveCardHides(cardHides)
                    }
                    return await transmitStudyCommand(retry, generation: generation,
                                                      remainingRebases: remainingRebases - 1)
                }
                try await studyClient.releasePending(command.requestId)
                guard generation == serviceGeneration, !isPreview else { return false }
                pendingCommand = nil
                applySnapshot(snapshot)
                if !expired, !observation, queued == nil { dailyError = MiniStudyClientError.conflict.localizedDescription }
            } catch {
                if generation == serviceGeneration, !observation { dailyError = "暂时无法读取学习进度。请重试。" }
            }
            return false
        } catch MiniStudyClientError.commandRejected(let reason) {
            try? await studyClient.releasePending(command.requestId)
            let snapshot = try? await studyClient.snapshot()
            guard generation == serviceGeneration, !isPreview else { return false }
            pendingCommand = nil
            if let snapshot { applySnapshot(snapshot) }
            if !observation { dailyError = reason }
            return false
        } catch MiniStudyClientError.rejected {
            do { try await studyClient.releasePending(command.requestId) } catch { }
            guard generation == serviceGeneration else { return false }
            pendingCommand = nil
            if !observation { dailyError = MiniStudyClientError.rejected.localizedDescription }
            return false
        } catch {
            guard generation == serviceGeneration else { return false }
            try? await studyClient.releasePending(command.requestId)
            guard generation == serviceGeneration, !isPreview else { return false }
            pendingCommand = nil
            return false
        }
    }

    private func dailyAction(_ type: MiniStudyAction.Kind, dayId: String? = nil) -> MiniStudyAction {
        MiniStudyAction(type: type, target: .daily, dayId: dayId ?? dailyDay?.id)
    }

    private func pauseDaily(_ paused: Bool) {
        if isPreview { updateDaily { $0.setPaused(paused) }; return }
        if !paused { resumeStudy(dayId: dailyDay?.id); return }
        var action = dailyAction(.pause)
        action.paused = paused
        submitStudyAction(action)
    }

    private func pauseLegacyReview(_ paused: Bool) {
        if isPreview { updateReview { $0.paused = paused }; return }
        guard let record = reviewRecord else { return }
        var action = MiniStudyAction(type: .pause, target: .review, recordId: record.id)
        action.paused = paused
        submitStudyAction(action)
    }

    private func draftKey(target: MiniStudyAction.Target, session: MiniStudyAction.Session?, word: MiniWord,
                          identity: String? = nil) -> String {
        let currentIdentity = identity ?? (target == .daily ? (dailyDay?.id ?? "") : (reviewRecord?.id.uuidString ?? ""))
        return "\(target.rawValue)/\(currentIdentity)/\(session?.rawValue ?? "review")/\(word.spelling)/\(word.meaning)"
    }

    private func draftBinding(key: String, fallback: String) -> Binding<String> {
        Binding(get: { inputDrafts[key] ?? fallback }, set: { value in
            inputDrafts[key] = value
            MiniStudyClient.draftJournal.replace(inputDrafts)
        })
    }

    private func clearSubmittedDraft(_ action: MiniStudyAction) {
        if action.type == .submitSpelling, let word = action.word {
            let identity = action.target == .daily ? action.dayId : action.recordId?.uuidString
            let key = draftKey(target: action.target, session: action.session, word: word, identity: identity)
            guard inputDrafts[key] == action.answer else { return }
            inputDrafts.removeValue(forKey: key)
        } else if action.type == .windowAdvance || action.type == .windowFamiliar, let visitId = action.visitId {
            inputDrafts.removeValue(forKey: "window/" + visitId.uuidString.lowercased())
        } else if (action.type == .submitTranslation || action.type == .reviseTranslation), let taskId = action.taskId {
            inputDrafts.removeValue(forKey: MiniTranslationAttempt.draftKey(taskId: taskId, revision: action.attemptId))
        } else if action.type == .closeDictation, let id = action.dictationId {
            inputDrafts.removeValue(forKey: "dictation/" + id.uuidString.lowercased())
        } else if action.type == .submitProbe, let id = action.probeId {
            inputDrafts.removeValue(forKey: "probe/" + id.uuidString.lowercased())
        } else { return }
        MiniStudyClient.draftJournal.replace(inputDrafts)
    }

    private func currentReviewSession(for action: MiniStudyAction, displaying: Bool = false) -> MiniReviewSession? {
        switch action.target {
        case .review:
            guard let record = reviewRecord, record.id == action.recordId, !record.paused,
                  !record.continuedToLearning else { return nil }
            return record.session
        case .daily:
            guard let day = displaying ? presentedDailyDay : dailyDay, day.id == action.dayId, !day.paused else { return nil }
            if action.session == .review && day.phase == .review { return day.review }
            if action.session == .learning && day.phase == .learning { return day.learning }
            return nil
        }
    }

    private func presentedReview(_ confirmed: MiniReviewSession, for action: MiniStudyAction) -> MiniReviewSession {
        var displayed = confirmed
        for input in reviewInputs where input.applies(to: action) {
            input.present(in: &displayed)
        }
        return displayed
    }

    private func enqueueReviewInput(_ action: MiniStudyAction, from cursor: MiniReviewInput.Cursor?) {
        guard !isPreview, serviceSnapshot != nil, !showingHome, !showingPlan,
              let confirmed = currentReviewSession(for: action, displaying: true) else { return }
        let displayed = presentedReview(confirmed, for: action)
        guard cursor == MiniReviewInput.Cursor(displayed),
              let input = MiniReviewInput(action: action, session: displayed),
              !reviewInputs.contains(where: { $0.action.type != .recordCardView && $0.applies(to: action) && $0.cursor == input.cursor }) else { return }
        recordVisibleCardIfNeeded()
        appendReviewInput(input)
    }

    private func appendReviewInput(_ input: MiniReviewInput) {
        reviewInputs.append(input)
        MiniStudyClient.reviewJournal.replace(reviewInputs)
        drainReviewInputs()
    }

    private func drainReviewInputs() {
        guard !isPreview, !savingStudy, let snapshot = serviceSnapshot else { return }
        // A recovered command may already be reflected in SQLite. Remove consumed
        // cursors before sending anything; stale input never targets a later visit.
        let originalCount = reviewInputs.count
        while let head = reviewInputs.first,
              (head.action.target == .daily && head.action.dayId != dailyDay?.id) || !head.matches(snapshot) {
            reviewInputs.removeFirst()
            cardViewRequests.removeValue(forKey: head.id)
        }
        if reviewInputs.count != originalCount { MiniStudyClient.reviewJournal.replace(reviewInputs) }
        guard let input = reviewInputs.first else { return }
        serviceBusy = true
        let generation = serviceGeneration
        Task {
            let durable = await MiniStudyClient.reviewJournal.flushed()
            guard generation == serviceGeneration, !isPreview else { return }
            guard durable else {
                if let visit = cardViewRequests.removeValue(forKey: input.id), visit == viewedCardVisit { cardViewFailed = true }
                reviewInputs.removeAll()
                MiniStudyClient.reviewJournal.replace([])
                serviceBusy = false
                return
            }
            if browseDrain != nil || !browseOutbox.isEmpty {
                guard await flushBrowseViews(generation: generation) else {
                    if generation == serviceGeneration {
                        reviewInputs.removeAll()
                        MiniStudyClient.reviewJournal.replace([])
                        serviceBusy = false
                    }
                    return
                }
            }
            guard generation == serviceGeneration, !isPreview, let snapshot = serviceSnapshot else { return }
            let command = MiniStudyCommand(requestId: input.id, expectedRevision: snapshot.revision,
                                           action: input.action, occurredAt: input.occurredAt)
            let saved = await transmitStudyCommand(command, generation: generation, remainingRebases: 3,
                                                    conflictSnapshot: snapshot)
            guard generation == serviceGeneration, !isPreview else { return }
            if !saved, input.action.type == .recordCardView {
                reviewInputs.removeAll { $0.id == input.id }
                if cardViewRequests.removeValue(forKey: input.id) == viewedCardVisit { cardViewFailed = true }
            } else if !saved {
                // Later intents depend on this exact cursor transition. Discard the
                // projection and recover the canonical card after exhausted retries.
                reviewInputs.removeAll()
                if let confirmed = try? await studyClient.snapshot(), generation == serviceGeneration {
                    applySnapshot(confirmed)
                }
            }
            guard generation == serviceGeneration, !isPreview else { return }
            if !saved { MiniStudyClient.reviewJournal.replace(reviewInputs) }
            if saved, input.action.type == .submitSpelling, let word = input.action.word,
               let cursor = input.cursor,
               let canonical = currentReviewSession(for: input.action),
               canonical.spellingAttempts.count == cursor.attemptCount + 1,
               let attempt = canonical.spellingAttempts.last, attempt.word == word, attempt.answer == input.action.answer,
               MiniReviewInput.Cursor(presentedReview(canonical, for: input.action)) == MiniReviewInput.Cursor(canonical),
               audioWindowVisible, !showingHome, !showingPlan, !showingProbe, !browsingWords,
               supplement == nil, mode == .words {
                if input.action.advanceAfterCorrect == true, attempt.correct {
                    synchronizeAudio()
                    audio.playSpellingResult(word, submissionId: input.id)
                } else if canonical.currentWord == word, cardAudioPresentation?.word == word {
                    playSpellingResult(word)
                }
            }
            if saved, input.action.type == .submitDictation, let practice = activeDictation,
               practice.id == input.action.dictationId, practice.attempts.last?.id == input.id,
               cardAudioPresentation?.id == "dictation:" + practice.id.uuidString.lowercased() {
                playSpellingResult(practice.word)
            }
            serviceBusy = false
            recordVisibleCardIfNeeded()
            drainReviewInputs()
        }
    }

    private func reviewCommands(target: MiniStudyAction.Target, session: MiniStudyAction.Session?) -> MiniReviewCommands {
        let context = MiniStudyAction(type: .submitSpelling, target: target,
                                      dayId: target == .daily ? dailyDay?.id : nil,
                                      recordId: target == .review ? reviewRecord?.id : nil, session: session)
        let current = currentReviewSession(for: context, displaying: true).map { presentedReview($0, for: context) }
        let cursor = current.map(MiniReviewInput.Cursor.init)
        let word = current?.currentWord
        let draft = word.map { draftBinding(key: draftKey(target: target, session: session, word: $0),
                                            fallback: current?.spellingDraft ?? "") } ?? .constant("")
        func action(_ type: MiniStudyAction.Kind) -> MiniStudyAction {
            MiniStudyAction(type: type, target: target, dayId: target == .daily ? dailyDay?.id : nil,
                            recordId: target == .review ? reviewRecord?.id : nil, session: session, word: word)
        }
        return MiniReviewCommands(draft: draft, chooseJudgment: { judgment in
            guard word != nil else { return }
            var command = action(.chooseJudgment)
            command.judgment = judgment
            enqueueReviewInput(command, from: cursor)
        }, advanceJudgment: { markWrong in
            guard word != nil else { return }
            var command = action(.advanceJudgment)
            command.markWrong = markWrong
            enqueueReviewInput(command, from: cursor)
        }, submitSpelling: { answer in
            guard word != nil else { return }
            var command = action(.submitSpelling)
            command.answer = answer
            command.advanceOnCorrect = false
            command.advanceAfterCorrect = studyAppearance.isSimple ? true : nil
            enqueueReviewInput(command, from: cursor)
        }, advanceSpelling: {
            guard word != nil else { return }
            enqueueReviewInput(action(.advanceSpelling), from: cursor)
        }, openDictation: {
            guard word != nil else { return }
            submitStudyAction(action(.openDictation))
        }, clearJudgment: {
            guard word != nil else { return }
            submitStudyAction(action(.clearJudgment))
        }, presentedSession: current)
    }

    private func dailyCommands(_ day: MiniDailyDay) -> MiniDailyCommands {
        let index = day.translationPageIndex(selection: selectedTranslationTaskId)
        let task = day.translationTask(at: index)
        let attempt = task.flatMap { displayed in day.translation.last { $0.taskID == displayed.id } }
        let draft = task.map {
            draftBinding(key: MiniTranslationAttempt.draftKey(taskId: $0.id, revision: attempt?.latestID),
                         fallback: attempt?.latestAnswer ?? day.translationDraft)
        } ?? .constant("")
        let navigation = task.map { displayed in
            MiniTranslationNavigation(index: index, select: { next in
                guard let target = day.translationTask(at: next) else { return }
                selectedTranslationTaskId = next == day.translationIndex ? nil : target.id
            }, revise: { answer in
                guard let attempt else { return }
                var action = dailyAction(.reviseTranslation, dayId: day.id)
                action.taskId = displayed.id
                action.attemptId = attempt.latestID
                action.answer = answer
                action.aiSelection = aiSelection
                submitStudyAction(action)
            }, pendingEdit: index + 1 == day.translationCount ? day.pendingTranslationEdit(in: inputDrafts) : nil)
        }
        let memory = day.memory
        let memoryWord = memory?.currentWord
        let memoryKey = memoryWord.map { "memory/" + day.id + "/" + String(memory?.round ?? 1) + "/" + $0.spelling + "/" + $0.meaning }
        let memoryDraft = memoryKey.map { key in
            draftBinding(key: key, fallback: memory?.drafts.first { $0.word == memoryWord && $0.round == memory?.round }?.text ?? "")
        } ?? .constant("")
        func memoryAction(_ type: MiniStudyAction.Kind) -> MiniStudyAction {
            var action = dailyAction(type, dayId: day.id)
            action.word = memoryWord
            action.round = memory?.round
            action.draft = memoryDraft.wrappedValue
            return action
        }
        let memoryCommands = MiniMemoryCommands(draft: memoryDraft, advance: { remembered in
            var action = memoryAction(.memoryAdvance)
            action.remembered = remembered
            submitStudyAction(action)
        }, reveal: {
            submitStudyAction(memoryAction(.memoryReveal))
        }, saveDraft: {
            submitStudyAction(memoryAction(.memoryDraft))
        }, undo: {
            submitStudyAction(dailyAction(.memoryUndo, dayId: day.id))
        })
        return MiniDailyCommands(review: reviewCommands(target: .daily, session: .review),
                                 learning: reviewCommands(target: .daily, session: .learning),
                                 translationDraft: draft, resume: { resumeStudy(dayId: day.id) }, markStudied: { word in
            var action = dailyAction(.markStudied, dayId: day.id)
            action.word = word
            action.remainOnCard = true
            submitStudyAction(action)
        }, completeReview: {
            let entry = studyIntent(for: day.id)
            submitStudyAction(dailyAction(.completeReview, dayId: day.id), afterSave: {
                await continueAfterReview(entry)
            })
        }, completeLearning: {
            submitStudyAction(dailyAction(.completeLearning, dayId: day.id), afterSave: { startPreparation() })
        }, submitTranslation: { answer in
            guard let task, task.id == day.currentTranslation?.id else { return }
            var action = dailyAction(.submitTranslation, dayId: day.id)
            action.taskId = task.id
            action.answer = answer
            submitStudyAction(action, afterSave: { if day.flow == nil { await gradeDailyTranslation() } })
        }, advanceTranslation: {
            guard let task, task.id == day.currentTranslation?.id else { return }
            var action = dailyAction(.advanceTranslation, dayId: day.id)
            action.taskId = task.id
            action.aiSelection = aiSelection
            submitStudyAction(action, afterSave: {
                if dailyDay?.flow?.goalReached == true || dailyDay?.phase == .finished { showingHome = true }
                else if canIntroduceAtBoundary, let next = dailyDay, next.phase == .learning,
                        let group = next.flow?.groupIndex, let oldGroup = day.flow?.groupIndex, group > oldGroup {
                    openSupplement(.patterns)
                    patternsBeforeNextGroup = true
                }
            })
        }, translationNavigation: navigation, memory: memoryCommands, window: windowCommands(day), openDictation: { word in
            var action = dailyAction(.openDictation, dayId: day.id)
            action.session = .learning
            action.word = word
            submitStudyAction(action)
        }, unmarkStudied: { word in
            var action = dailyAction(.unmarkStudied, dayId: day.id)
            action.word = word
            submitStudyAction(action)
        }, advanceLearningCard: { word in
            var action = dailyAction(.advanceLearningCard, dayId: day.id)
            action.word = word
            submitStudyAction(action)
        })
    }

    private var previewAssessment: MiniAssessmentPreview? {
        #if DEBUG
        return isPreview ? MiniAssessmentPreview.make(devStage) : nil
        #else
        return nil
        #endif
    }

    private var previewWindowCommands: MiniWindowCommands? {
        #if DEBUG
        guard isPreview, let visit = dailyDay?.memoryWindow?.visit else { return nil }
        let draft = Binding<String>(get: { dailyDay?.memoryWindow?.visit?.draft ?? "" }, set: { value in
            updateDaily { MiniDevPreview.editVisit(&$0, draft: value) }
        })
        return MiniWindowCommands(draft: draft, choose: { remembered in
            updateDaily { MiniDevPreview.editVisit(&$0, choice: remembered) }
        }, correct: {
            selectDevStage(.learning)
        }, advance: { remembered in
            let passed = remembered ?? dailyDay?.memoryWindow?.visit?.willRemember ?? false
            selectDevStage(!passed ? .learning : (visit.stage == 0 ? .learningContext : (visit.stage == 1 ? .learningMeaning : .learningSpelling)))
        }, saveDraft: {}, markFamiliar: dailyDay?.phase == .learning && visit.stage == 0 ? {
            guard dailyDay?.memoryWindow?.visit?.id == visit.id, visit.initial == nil else { return }
            selectDevStage(.learningSpelling)
        } : nil)
        #else
        return nil
        #endif
    }

    private var previewSpellingCommands: MiniReviewCommands? {
        #if DEBUG
        guard isPreview, dailyDay?.flow != nil, dailyDay?.learning != nil else { return nil }
        let draft = Binding<String>(get: { dailyDay?.learning?.spellingDraft ?? "" }, set: { value in
            updateDaily { $0.learning?.spellingDraft = value; return true }
        })
        return MiniReviewCommands(draft: draft, chooseJudgment: { _ in }, advanceJudgment: { _ in }, submitSpelling: { answer in
            let answered = updateDaily { $0.learning?.submitSpelling(answer, advanceOnCorrect: studyAppearance.isSimple) ?? false }
            if answered, studyAppearance.isSimple, dailyDay?.learning?.phase == .finished {
                selectDevStage(.learningFinished)
            }
        }, advanceSpelling: { selectDevStage(.learningFinished) })
        #else
        return nil
        #endif
    }

    private func previewTranslationWorksheet(_ day: MiniDailyDay) -> (navigation: MiniTranslationNavigation, draft: Binding<String>)? {
        #if DEBUG
        guard isPreview, let task = displayedTranslation(day) else { return nil }
        let index = day.translationPageIndex(selection: selectedTranslationTaskId)
        let attempt = day.translation.last { $0.taskID == task.id }
        let key = MiniTranslationAttempt.draftKey(taskId: task.id, revision: attempt?.latestID)
        let draft = Binding(get: { previewTranslationDrafts[key] ?? attempt?.latestAnswer ?? "" },
                            set: { previewTranslationDrafts[key] = $0 })
        return (.init(index: index, select: { next in
            guard let target = day.translationTask(at: next) else { return }
            selectedTranslationTaskId = next == day.translationIndex ? nil : target.id
        }, revise: { text in
            guard let attempt else { return }
            if updateDaily({ $0.revisePreviewTranslation(attempt: attempt, answer: text) }) {
                previewTranslationDrafts.removeValue(forKey: key)
            }
        }, pendingEdit: day.pendingTranslationEdit(in: previewTranslationDrafts)), draft)
        #else
        return nil
        #endif
    }

    private var previewTranslationAdvance: (() -> Void)? {
        #if DEBUG
        guard isPreview, dailyDay?.phase == .translation else { return nil }
        return {
            updateDaily { day in
                if let attempt = day.currentAttempt, attempt.feedback == nil {
                    day.gradeTranslation(id: attempt.id, feedback: MiniDevPreview.sampleFeedback)
                }
                return day.advanceTranslation()
            }
        }
        #else
        return nil
        #endif
    }

    private func windowCommands(_ day: MiniDailyDay) -> MiniWindowCommands? {
        guard let visit = day.memoryWindow?.visit else { return nil }
        let draft = draftBinding(key: "window/" + visit.id.uuidString.lowercased(), fallback: visit.draft)
        func action(_ kind: MiniStudyAction.Kind) -> MiniStudyAction {
            MiniStudyAction.window(kind, dayId: day.id, session: day.phase == .review ? .review : .learning,
                                   visit: visit, draft: draft.wrappedValue)
        }
        func enqueue(_ action: MiniStudyAction) {
            guard !isPreview, !showingHome, !showingPlan, !browsingWords, mode == .words, supplement == nil,
                  !showingProbe, activeDictation == nil, let current = presentedDailyDay,
                  current.id == day.id, !current.paused, let displayed = current.memoryWindow?.visit,
                  MiniReviewInput.WindowCursor(visit) == MiniReviewInput.WindowCursor(displayed) else { return }
            recordVisibleCardIfNeeded()
            guard let input = MiniReviewInput(action: action, visit: displayed) else { return }
            // An event from the previous card cannot act on its projected successor.
            if reviewInputs.contains(where: {
                $0.windowCursor == input.windowCursor && $0.applies(to: action)
                    && $0.action.type != .recordCardView && $0.action.type != .windowDraft
            }) { return }
            appendReviewInput(input)
        }
        return MiniWindowCommands(draft: draft, choose: { remembered in
            var command = action(.windowChoose)
            command.remembered = remembered
            enqueue(command)
        }, correct: {
            var command = action(.windowAdvance)
            command.markWrong = true
            enqueue(command)
        }, advance: { remembered in
            var command = action(.windowAdvance)
            command.remembered = remembered
            enqueue(command)
        }, saveDraft: {
            enqueue(action(.windowDraft))
        }, markFamiliar: day.phase == .learning && visit.stage == 0 ? {
            enqueue(action(.windowFamiliar))
        } : nil)
    }

    private func preparationJob(for day: MiniDailyDay, kind: MiniAIJob.Kind? = nil) -> MiniAIJob? {
        aiSnapshot?.jobs.filter {
            $0.dayId == day.id && ($0.kind == .prepare || $0.kind == .writing) && (kind == nil || $0.kind == kind)
        }
            .max { $0.createdAt < $1.createdAt }
    }

    private func feedbackJob(for day: MiniDailyDay) -> MiniAIJob? {
        guard let attempt = day.currentAttempt else { return nil }
        return aiSnapshot?.jobs.filter { $0.dayId == day.id && $0.attemptId == attempt.id && $0.kind == .feedback }
            .max { $0.createdAt < $1.createdAt }
    }

    private func preparationKind(for day: MiniDailyDay) -> MiniAIJob.Kind? {
        if day.phase == .review, studyIntent(for: day.id) == .review { return nil }
        return MiniDailyAI.preparationKind(for: day)
    }

    private func startPreparation() {
        if isPreview {
            Task { await prepareDaily(retrying: true) }
            return
        }
        guard let day = dailyDay, !day.paused, !aiSubmitting, preparationDay != day.id,
              preparationKind(for: day) != nil else { return }
        let generation = serviceGeneration
        preparationDay = day.id
        preparationError = nil
        Task {
            defer { if generation == serviceGeneration, preparationDay == day.id { preparationDay = nil } }
            // Reconcile uncertain starts and stale running jobs before deciding which missing work to retry.
            await connectAI(generation: generation)
            guard generation == serviceGeneration, !isPreview, dailyDay?.id == day.id,
                  !showingHome, !showingPlan, !browsingWords, !showingProbe, supplement == nil, mode == .words else { return }
            if let aiError { preparationError = aiError; return }
            await prepareDaily(retrying: true)
        }
    }

    private func startBackgroundPreparationIfNeeded() {
        guard supplement == nil, !isPreview, !showingHome, !showingPlan, !showingProbe, !browsingWords, !showingReview, mode == .words,
              let day = dailyDay, !day.paused, !aiSubmitting, preparationDay == nil, pendingAIRequest == nil,
              aiSnapshot?.imported == true, aiError == nil, let kind = preparationKind(for: day),
              preparationJob(for: day, kind: kind) == nil || preparationJob(for: day, kind: kind)?.status == .completed else { return }
        Task { await prepareDaily(retrying: false) }
    }

    private func prepareDaily(retrying: Bool) async {
        if !retrying && (preparationDay != nil || supplement != nil || showingHome || showingPlan || showingProbe || browsingWords || mode != .words) { return }
        guard let day = dailyDay, !day.paused, day.writingRequired != false else { return }
        #if DEBUG
        if isPreview {
            updateDaily { $0.addSentences(MiniDevPreview.sentences(for: $0.wordsToPrepare)) }
            preparationDay = nil
            preparationError = nil
            return
        }
        #endif
        guard let kind = preparationKind(for: day), !aiSubmitting,
              pendingAIRequest == nil,
              preparationJob(for: day, kind: kind)?.status.isActive != true else { return }
        preparationError = nil
        if let previous = preparationJob(for: day, kind: kind),
           previous.status != .completed, previous.model == aiSelection.model, previous.effort == aiSelection.effort {
            guard retrying else { return }
            await controlAI(previous, retry: true)
            return
        }
        await startAI(MiniAIStart(kind: kind, dayId: day.id, model: aiSelection.model, effort: aiSelection.effort))
    }

    private func gradeDailyTranslation() async {
        guard let day = dailyDay, day.flow == nil, let attempt = day.currentAttempt, attempt.feedback == nil else { return }
        #if DEBUG
        if isPreview {
            updateDaily { $0.gradeTranslation(id: attempt.id, feedback: MiniDevPreview.sampleFeedback) }
            gradingError = nil
            return
        }
        #endif
        guard !aiSubmitting, feedbackJob(for: day)?.status.isActive != true else { return }
        gradingError = nil
        if let previous = feedbackJob(for: day), previous.status != .completed,
           previous.model == aiSelection.model, previous.effort == aiSelection.effort {
            await controlAI(previous, retry: true)
            return
        }
        await startAI(MiniAIStart(kind: .feedback, dayId: day.id, attemptId: attempt.id,
                                  model: aiSelection.model, effort: aiSelection.effort))
    }

    private var aiSelection: MiniAISelection {
        MiniAISelection(model: modelID.isEmpty ? MiniAISelection.initial.model : modelID,
                        effort: effort.isEmpty ? MiniAISelection.initial.effort : effort)
    }
    private var savedEnglishLevel: String? {
        guard let value = serviceSnapshot?.teaching?.memories.last(where: { $0.key == "english_level" })?.value.uppercased(),
              let range = value.range(of: #"\b(A1|A2|B1|B2|C1|C2)\b"#, options: .regularExpression) else { return nil }
        return String(value[range])
    }

    private var levelRequestPending: Bool {
        if pendingAIRequest?.message?.hasPrefix("请将我的英语学习水平偏好记为 ") == true { return true }
        return aiSnapshot?.jobs.contains { job in
            job.status.isActive && aiSnapshot?.messages.contains {
                $0.jobId == job.id && $0.role == .user && $0.text.hasPrefix("请将我的英语学习水平偏好记为 ")
            } == true
        } == true
    }

    private func setEnglishLevel(_ level: String) {
        guard !isPreview, !aiSubmitting, pendingAIRequest == nil else { return }
        openMode(.chat)
        advisorChat = true
        let message = "请将我的英语学习水平偏好记为 \(level)。通过工具保存后再告诉我。"
        Task { await startAI(MiniAIStart(kind: .advisor, message: message, model: aiSelection.model, effort: aiSelection.effort)) }
    }

    private func expiredLessonRequest(_ request: MiniAIStart) -> Bool {
        guard request.kind == .prepare || request.kind == .writing,
              let day = dailyLedger?.days.last(where: { $0.id == request.dayId }) else { return false }
        return day.archivedAt != nil || planContext?.includesDay(day) == false
    }

    private func connectAI(generation: UUID) async {
        guard generation == serviceGeneration, !isPreview, !aiSubmitting else { return }
        do {
            var snapshot = try await MiniDailyAI.readWithRetry { try await aiClient.snapshot() }
            guard generation == serviceGeneration, !isPreview else { return }
            if !snapshot.imported {
                let request = try chatStorage.prepareLegacyImport()
                snapshot = try await aiClient.importLegacy(request)
                try chatStorage.recordImportReceipt(snapshot)
            }
            guard generation == serviceGeneration, !isPreview else { return }
            aiSnapshot = snapshot
            chatDrafts = try chatStorage.loadDrafts()
            pendingAIRequest = try chatStorage.pendingRequest()
            if let pending = pendingAIRequest, pending.kind == .prepare || pending.kind == .writing {
                if expiredLessonRequest(pending) || snapshot.jobs.contains(where: { $0.requestId == pending.requestId }) {
                    try chatStorage.clearPending(requestId: pending.requestId)
                    pendingAIRequest = nil
                }
            }
            chatArchiveError = nil
            aiError = nil
            try await MiniDailyAI.readWithRetry { try await refreshAIStudyIfNeeded(generation: generation) }
            if let pendingAIRequest, pendingAIRequest.kind != .prepare || (!showingHome && !showingPlan) {
                await startAI(pendingAIRequest)
            }
            observeAI(generation: generation)
        } catch {
            guard generation == serviceGeneration, !isPreview else { return }
            aiError = "无法读取 AI 任务或迁移以前的聊天：\(error.localizedDescription)"
        }
    }

    private func startAI(_ request: MiniAIStart) async {
        guard !isPreview, !aiSubmitting else { return }
        guard aiSnapshot?.imported == true else {
            aiError = "聊天记录尚未连接或迁入，请先重新连接 AI 服务。"
            return
        }
        aiSubmitting = true
        aiError = nil
        let generation = serviceGeneration
        defer { if generation == serviceGeneration { aiSubmitting = false } }
        do {
            try chatStorage.savePending(request)
            pendingAIRequest = request
            _ = try await aiClient.start(request)
            try chatStorage.clearPending(requestId: request.requestId)
            guard generation == serviceGeneration, !isPreview else { return }
            pendingAIRequest = nil
            if request.kind == .advisor || (request.kind == .dialogue && request.message != nil) {
                chatDrafts[request.conversationId] = ""
                try chatStorage.saveDrafts(chatDrafts)
            }
            let snapshot = try await MiniDailyAI.readWithRetry { try await aiClient.snapshot() }
            guard generation == serviceGeneration, !isPreview else { return }
            aiSnapshot = snapshot
            try await MiniDailyAI.readWithRetry { try await refreshAIStudyIfNeeded(generation: generation) }
            observeAI(generation: generation)
        } catch {
            guard generation == serviceGeneration, !isPreview else { return }
            let expired = expiredLessonRequest(request)
            if expired || !MiniDailyAI.isConnectionFailure(error) || request.kind != .prepare {
                try? chatStorage.clearPending(requestId: request.requestId)
                pendingAIRequest = nil
            }
            guard !expired else { return }
            aiError = error.localizedDescription
            if request.kind == .prepare, dailyDay?.id == request.dayId { preparationError = aiError }
        }
    }

    private func observeAI(generation: UUID) {
        aiObservation?.cancel()
        guard !isPreview, aiSnapshot?.jobs.contains(where: { $0.status.isActive }) == true else { return }
        aiObservation = Task {
            do {
                while !Task.isCancelled {
                    try await Task.sleep(for: .milliseconds(800))
                    let snapshot = try await MiniDailyAI.readWithRetry { try await aiClient.snapshot() }
                    guard generation == serviceGeneration, !isPreview else { return }
                    aiSnapshot = snapshot
                    try await MiniDailyAI.readWithRetry { try await refreshAIStudyIfNeeded(generation: generation) }
                    guard snapshot.jobs.contains(where: { $0.status.isActive }) else { return }
                }
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled, generation == serviceGeneration, !isPreview else { return }
                aiError = "任务状态暂未刷新，已提交内容仍保留：\(error.localizedDescription)"
                if let day = dailyDay, !day.wordsToPrepare.isEmpty { preparationError = aiError }
            }
        }
    }

    private func refreshAIStudyIfNeeded(generation: UUID) async throws {
        let committedRevision = aiSnapshot?.jobs.flatMap(\.receipts).map(\.revision).max() ?? 0
        let finishedTeaching = aiSnapshot?.jobs.filter {
            ($0.kind == .prepare || $0.kind == .writing || $0.kind == .feedback) &&
                $0.status == .completed && appliedAIJobs[$0.id] != $0.updatedAt
        } ?? []
        if !serviceBusy, pendingCommand == nil,
           committedRevision > (serviceSnapshot?.revision ?? -1) || !finishedTeaching.isEmpty {
            try await refreshPlanContext(generation: generation)
            guard generation == serviceGeneration, !isPreview else { return }
            for job in finishedTeaching { appliedAIJobs[job.id] = job.updatedAt }
        }
    }

    private func controlAI(_ job: MiniAIJob, retry: Bool) async {
        guard !isPreview, !aiSubmitting else { return }
        aiSubmitting = true
        let generation = serviceGeneration
        defer { if generation == serviceGeneration { aiSubmitting = false } }
        do {
            if retry { _ = try await aiClient.retry(job.id) }
            else { _ = try await aiClient.cancel(job.id) }
            let snapshot = try await MiniDailyAI.readWithRetry { try await aiClient.snapshot() }
            guard generation == serviceGeneration, !isPreview else { return }
            aiSnapshot = snapshot
            aiError = nil
            try await refreshPlanContext(generation: generation)
            observeAI(generation: generation)
        } catch {
            guard generation == serviceGeneration, !isPreview else { return }
            aiError = error.localizedDescription
            if job.kind == .prepare, job.dayId == dailyDay?.id { preparationError = aiError }
        }
    }

    /// Only the acknowledged review and the refreshed plan determine what this click opens.
    private func continueAfterReview(_ entry: MiniStudyIntent) async {
        let generation = serviceGeneration
        if planContext == nil {
            do { try await refreshPlanContext(generation: generation) }
            catch {
                guard serviceGeneration == generation else { return }
                dailyError = "复习已完成，暂时无法读取下一项学习任务。"
                if dailyDay == nil { showingHome = true }
            }
        }
        guard let planContext, serviceGeneration == generation, !showingHome, !showingPlan, !showingProbe,
              !browsingWords, supplement == nil, mode == .words else { return }
        let active = dailyDay.flatMap { $0.paused ? nil : $0 }
        switch planContext.afterCompletingReview(activePhase: active?.phase, intent: entry) {
        case .activeReview:
            return
        case .begin:
            resumeStudy(entry)
        case .activeStudy:
            if let next = active, canIntroduceAtBoundary, next.phase == .learning, next.writingRequired != false,
               next.flow?.window.events.isEmpty == true, next.flow?.groupIndex == 1 {
                openSupplement(.patterns)
                patternsBeforeNextGroup = true
            } else { startPreparation() }
        case .home:
            showingHome = true
        }
    }

    private func continueToLearning() {
        guard let record = reviewRecord, record.session.phase == .finished else { return }
        if isPreview {
            updateReview { $0.continuedToLearning = true }
            move(to: record.nextWordIndex)
        } else {
            submitStudyAction(MiniStudyAction(type: .continueToLearning, target: .review, recordId: record.id), afterSave: {
                await continueAfterReview(localReviewIntent ?? .review)
            })
        }
    }

    private func updateReview(_ update: (inout MiniReviewRecord) -> Void) {
        guard isPreview, var record = reviewRecord else { return }
        update(&record)
        reviewRecord = record
        reviewError = nil
    }

    private func browseIndex(in deck: [MiniWord]) -> Int? {
        deck.isEmpty ? nil : min(max(0, isPreview ? previewWordIndex : storedIndex), deck.count - 1)
    }

    private var listEditor: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("自定义词表", systemImage: "square.and.pencil").font(.headline)
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
                if !customList.isEmpty {
                    Button("用内置词表") { saveList("") }
                }
                Spacer()
                Button("返回") { editingList = false }
                Button(vocabulary?.activeDeckId == nil ? "保存" : "保存并使用自定义词表") {
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

    private func chat(for word: MiniWord?) -> some View {
        let conversationId = MiniChatStorage.conversationId(for: word)
        let messages = aiSnapshot?.messages.filter { $0.conversationId == conversationId } ?? []
        let jobs = aiSnapshot?.jobs.filter { $0.conversationId == conversationId && $0.kind == .advisor } ?? []
        let draft = Binding(get: { chatDrafts[conversationId, default: ""] }, set: { value in
            chatDrafts[conversationId] = value
            guard !isPreview else { return }
            try? chatStorage.saveDrafts(chatDrafts)
        })
        let hasMessages = isPreview ? !previewChats[conversationId, default: []].isEmpty : !messages.isEmpty
        let busy = aiSubmitting || pendingAIRequest != nil || jobs.contains { $0.status.isActive }
        let title = word.map { concealChatWord ? "当前练习" : $0.spelling } ?? "学习顾问"
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Label(title, systemImage: word == nil ? "bubble.left.and.bubble.right" : "text.book.closed")
                    .font(.headline).lineLimit(1)
                Spacer(minLength: 2)
                Menu {
                    ForEach(["A1", "A2", "B1", "B2", "C1", "C2"], id: \.self) { level in
                        Button { setEnglishLevel(level) } label: {
                            if savedEnglishLevel == level { Label(level, systemImage: "checkmark") }
                            else { Text(level) }
                        }
                    }
                } label: {
                    Text(levelRequestPending ? "水平设置中" : "水平 · \(savedEnglishLevel ?? "未设置")")
                        .font(.caption).lineLimit(1)
                }
                .menuStyle(.borderlessButton).fixedSize().help("英语学习水平")
                .accessibilityLabel("英语水平，\(savedEnglishLevel ?? "未设置")")
                .disabled(isPreview || busy || levelRequestPending)
                Button { settings = .ai } label: {
                    Image(systemName: "slider.horizontal.3").frame(width: 20, height: 20)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("AI 设置，\(aiSelection.model)，\(aiSelection.effort)")
                .help("AI 设置 · \(aiSelection.model) · \(aiSelection.effort)")
                Menu {
                    if hasMessages {
                        chatShortcuts(word: word)
                            .disabled(busy)
                        Divider()
                    }
                    Button("刷新任务") { Task { await connectAI(generation: serviceGeneration) } }
                        .disabled(isPreview || aiSubmitting)
                    Button("清除此处聊天", role: .destructive) { clearChat(conversationId) }
                        .disabled(isPreview || aiSubmitting || !hasMessages)
                } label: { Image(systemName: "ellipsis.circle") }
                .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                .help("聊天选项").accessibilityLabel("聊天选项")
            }
            if !hasMessages {
                HStack(spacing: 8) {
                    chatShortcuts(word: word)
                }
                .font(.caption).controlSize(.small).disabled(busy)
            }
            if let chatArchiveError { Text(chatArchiveError).font(.caption2).foregroundStyle(.secondary) }
            if let aiError {
                Text(aiError).font(.caption).foregroundStyle(.secondary)
                Button(pendingAIRequest == nil ? "重新连接 AI 服务" : "重试发送") {
                    Task {
                        if let pendingAIRequest { await startAI(pendingAIRequest) }
                        else { await connectAI(generation: serviceGeneration) }
                    }
                }.font(.caption).disabled(aiSubmitting || isPreview)
            }
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 9) {
                        if isPreview {
                            Text("开发预览 · 聊天与工具回执不写入学习记录").font(.caption2).foregroundStyle(.secondary)
                            ForEach(previewChats[conversationId, default: []]) { message in
                                chatMessage(role: message.role, text: message.text)
                            }
                        } else {
                            ForEach(messages) { message in
                                chatMessage(role: message.role, text: message.text)
                                if message.role == .assistant, let job = jobs.first(where: { $0.id == message.jobId }),
                                   job.status == .completed {
                                    chatReceipts(job)
                                }
                            }
                            ForEach(jobs.suffix(3).filter { $0.status != .completed }) { job in aiJobStatus(job) }
                            if aiSubmitting { ProgressView("正在提交…").controlSize(.small) }
                        }
                        Color.clear.frame(height: 1).id("endOfChat")
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }
                .defaultScrollAnchor(.bottom)
                .onChange(of: messages.count) { _, _ in proxy.scrollTo("endOfChat", anchor: .bottom) }
            }
            HStack {
                TextField(word == nil ? "问学习进度，或调整计划…" : "问这个词的用法…", text: draft)
                    .textFieldStyle(.roundedBorder).focused($chatFocused)
                    .onSubmit { send(draft.wrappedValue, about: word) }
                Button("发送", systemImage: "arrow.up") { send(draft.wrappedValue, about: word) }
                    .labelStyle(.iconOnly)
                    .disabled(aiSubmitting || pendingAIRequest != nil || jobs.contains { $0.status.isActive }
                              || draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .help("发送")
            }
        }
    }

    @ViewBuilder
    private func chatShortcuts(word: MiniWord?) -> some View {
        Button("查看重点", systemImage: "bookmark") { send("请查询并列出当前单词已有的重点；没有当前单词时列出近期重点。先不要新增。", about: word) }
        Button("查看记忆", systemImage: "brain") { send("请查询并列出已保存的稳定偏好与记忆，说明可以怎样修改或删除。", about: word) }
    }

    @ViewBuilder
    private func chatMessage(role: MiniChatMessage.Role, text: String) -> some View {
        if role == .user {
            Text(text).font(.callout).textSelection(.enabled)
                .padding(.horizontal, 9).padding(.vertical, 5)
                .background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
                .padding(.leading, 18)
                .frame(maxWidth: .infinity, alignment: .trailing)
                .accessibilityLabel("你：\(text)")
        } else {
            Text(text).font(.callout).textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityLabel("AI：\(text)")
        }
    }

    private func chatReceipts(_ job: MiniAIJob) -> some View {
        ForEach(job.receipts) { receipt in
            Label(receipt.summary, systemImage: "checkmark.circle")
                .font(.caption2).foregroundStyle(.secondary).textSelection(.enabled)
        }
    }

    private func aiJobStatus(_ job: MiniAIJob) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                if job.status.isActive { ProgressView().controlSize(.mini) }
                Text(job.status.label + (job.progress.isEmpty ? "" : " · " + job.progress))
                    .font(.caption).foregroundStyle(.secondary)
                Spacer(minLength: 4)
                if job.status.isActive {
                    Button("停止") { Task { await controlAI(job, retry: false) } }
                } else if job.status != .completed {
                    Button("重试") { Task { await controlAI(job, retry: true) } }
                }
            }
            if job.status.isActive, !job.text.isEmpty { Text(job.text).font(.callout).textSelection(.enabled) }
            chatReceipts(job)
            if let error = job.error { Text(error).font(.caption).foregroundStyle(.secondary) }
        }.disabled(aiSubmitting)
    }

    private func clearChat(_ conversationId: String) {
        guard !isPreview, !aiSubmitting else { return }
        aiSubmitting = true
        let generation = serviceGeneration
        Task {
            defer { if generation == serviceGeneration { aiSubmitting = false } }
            do {
                let snapshot = try await aiClient.clear(conversationId: conversationId)
                guard generation == serviceGeneration, !isPreview else { return }
                aiSnapshot = snapshot
                observeAI(generation: generation)
            } catch { if generation == serviceGeneration { aiError = error.localizedDescription } }
        }
    }

    private func move(to index: Int) {
        if isPreview { previewWordIndex = index } else { storedIndex = index }
    }

    private func saveList(_ text: String) {
        move(to: 0)
        editingList = false
        if isPreview { previewWordList = text; return }
        customWordList = text
        if vocabulary?.activeDeckId != nil { activateVocabulary(nil) }
        else { beginDaily() }
    }

    #if DEBUG
    private func selectDevStage(_ stage: MiniDevStage) {
        browseViewportChanged([])
        browseIdle?.cancel()
        browseDrain?.cancel()
        browseDrain = nil
        browseOutboxLoaded = false
        browseOutbox = []
        browseViewport = MiniBrowseViewport()
        audio.disconnect()
        resetSupplement()
        previewDictation = nil
        previewDictationDraft = ""
        previewTranslationDrafts = [:]
        selectedTranslationTaskId = nil
        previewAudioMuted = false
        previewWordList = ""
        previewWordIndex = 0
        devGeneration = UUID()
        serviceGeneration = UUID()
        refreshingPlanDate = false
        serviceBusy = false
        vocabularyBusy = false
        pendingVocabulary = nil
        vocabularyError = nil
        viewedCardIdentity = nil
        viewedCardSaved = false
        viewedCardVisit = UUID()
        cardViewRequests = [:]
        cardViewFailed = false
        cardNeedsRefresh = false
        cardHides = []
        cardHidesLoaded = false
        lastHiddenWord = nil
        serviceSnapshot = nil
        planContext = nil
        planNotice = nil
        pendingCommand = nil
        reviewInputs = []
        devStage = stage
        reviewRecord = nil
        reviewError = nil
        dailyLedger = nil
        activeDailyID = nil
        dailyError = nil
        preparationDay = nil
        aiObservation?.cancel()
        aiObservation = nil
        aiSnapshot = nil
        appliedAIJobs = [:]
        aiError = nil
        aiSubmitting = false
        pendingAIRequest = nil
        chatDrafts = [:]
        previewChats = [:]
        preparationError = nil
        gradingAttempt = nil
        gradingError = nil
        browsingWords = false
        editingList = false
        chatFocused = false
        mode = .words
        advisorChat = false
        showingHome = stage == .home || stage == .live
        showingPlan = false
        showingProbe = false
        preferLegacyReview = false

        localReviewIntent = nil
        guard stage.isPreview else {
            beginDaily()
            return
        }
        let preview = MiniDevPreview.make(stage)
        dailyLedger = preview.ledger
        activeDailyID = preview.day.id
        switch stage {
        case .learningPreparing:
            preparationDay = preview.day.id
        case .learningError:
            preparationError = "开发示例：备课连接中断，可重试查看恢复后的界面。"
        case .translationGrading, .translationError, .translationFeedback:
            showingHome = true
        case .browsing, .editing, .chat:
            browsingWords = true
            if stage == .editing {
                listDraft = editableListText
                listError = nil
                editingList = true
            }
            if stage == .chat { mode = .chat }
        default:
            break
        }
    }
    #endif

    private func send(_ raw: String, about word: MiniWord?) {
        let question = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !aiSubmitting, pendingAIRequest == nil, !question.isEmpty else { return }
        guard question.count <= 8_000 else { aiError = "问题最多 8,000 字符。"; return }
        let conversationId = MiniChatStorage.conversationId(for: word)
        if isPreview {
            previewChats[conversationId, default: []].append(MiniChatMessage(role: .user, text: question))
            previewChats[conversationId, default: []].append(MiniChatMessage(role: .assistant, text: "开发预览：这里会显示学习顾问的回答与已保存的工具回执。"))
            chatDrafts[conversationId] = ""
            return
        }
        guard aiSnapshot?.jobs.contains(where: { $0.conversationId == conversationId && $0.status.isActive }) != true else { return }
        let dayId = dailyDay?.id
        let attemptId = dailyDay.flatMap { day -> UUID? in
            guard let word, !browsingWords, !showingReview, !advisorChat,
                  let task = displayedTranslation(day), task.sentence.word == word else { return nil }
            return day.translation.last { $0.taskID == task.id }?.id
        }
        Task {
            await startAI(MiniAIStart(kind: .advisor, dayId: dayId, attemptId: attemptId,
                                      word: word, conversationId: conversationId, message: question,
                                      model: aiSelection.model, effort: aiSelection.effort))
        }
    }
}

@available(macOS 14.4, *)
private struct MiniStageMenuButton<Content: View>: NSViewRepresentable {
    let title: String
    let accessibilityLabel: String
    let content: Content
    @Environment(\.isEnabled) private var isEnabled

    init(title: String, accessibilityLabel: String, content: Content) {
        self.title = title
        self.accessibilityLabel = accessibilityLabel
        self.content = content
    }

    func makeCoordinator() -> Coordinator { Coordinator(content: content) }

    func makeNSView(context: Context) -> NSButton {
        let button = NSButton(title: title, target: context.coordinator, action: #selector(Coordinator.showMenu(_:)))
        button.isBordered = false
        button.bezelStyle = .inline
        button.font = .systemFont(ofSize: 10, weight: .medium)
        button.image = NSImage(systemSymbolName: "chevron.down", accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 8, weight: .semibold))
        button.imagePosition = .imageRight
        button.setContentHuggingPriority(.required, for: .horizontal)
        button.setAccessibilityRole(.menuButton)
        return button
    }

    func updateNSView(_ button: NSButton, context: Context) {
        button.title = title
        button.isEnabled = isEnabled
        button.setAccessibilityLabel(accessibilityLabel)
        context.coordinator.content = content
    }

    @MainActor
    final class Coordinator: NSObject, NSMenuDelegate {
        var content: Content
        init(content: Content) { self.content = content }

        @objc func showMenu(_ sender: NSButton) {
            NSApp.activate()
            sender.window?.makeKeyAndOrderFront(nil)
            DispatchQueue.main.async { [weak self, weak sender] in
                guard let self, let sender else { return }
                let source = NSHostingMenu(rootView: content)
                let menu = screenMenu(from: source, sourceRoot: source)
                menu.appearance = sender.effectiveAppearance
                sender.menu = menu
                defer { sender.menu = nil }
                let bottom = sender.isFlipped ? sender.bounds.maxY + 4 : sender.bounds.minY - 4
                _ = menu.popUp(positioning: nil, at: NSPoint(x: 0, y: bottom), in: sender)
            }
        }

        func confinementRect(for menu: NSMenu, on screen: NSScreen?) -> NSRect {
            screen?.visibleFrame ?? .zero
        }

        private func screenMenu(from source: NSMenu, sourceRoot: NSMenu) -> NSMenu {
            source.update()
            let menu = NSMenu(title: source.title)
            menu.autoenablesItems = false
            menu.font = .menuFont(ofSize: 0)
            menu.delegate = self
            for original in source.items {
                if original.isSeparatorItem {
                    menu.addItem(.separator())
                    continue
                }
                let item = MiniStageMenuItem(sourceItem: original, sourceRoot: sourceRoot)
                if let submenu = original.submenu {
                    item.action = nil
                    item.target = nil
                    item.submenu = screenMenu(from: submenu, sourceRoot: sourceRoot)
                }
                menu.addItem(item)
            }
            return menu
        }
    }
}

@available(macOS 14.4, *)
@MainActor
private final class MiniStageMenuItem: NSMenuItem {
    private let sourceItem: NSMenuItem
    private let sourceRoot: NSMenu

    init(sourceItem: NSMenuItem, sourceRoot: NSMenu) {
        self.sourceItem = sourceItem
        self.sourceRoot = sourceRoot
        super.init(title: sourceItem.title, action: #selector(invoke), keyEquivalent: sourceItem.keyEquivalent)
        target = self
        isEnabled = sourceItem.isEnabled
        isHidden = sourceItem.isHidden
        state = sourceItem.state
        image = sourceItem.image
        indentationLevel = sourceItem.indentationLevel
        keyEquivalentModifierMask = sourceItem.keyEquivalentModifierMask
        toolTip = sourceItem.toolTip
    }

    @available(*, unavailable)
    required init(coder: NSCoder) { fatalError("Menu items are constructed from current actions") }

    @objc private func invoke() {
        // Retain the SwiftUI action owner and send its original item to the original target.
        withExtendedLifetime(sourceRoot) {
            guard let action = sourceItem.action else { return }
            _ = NSApp.sendAction(action, to: sourceItem.target, from: sourceItem)
        }
    }
}
