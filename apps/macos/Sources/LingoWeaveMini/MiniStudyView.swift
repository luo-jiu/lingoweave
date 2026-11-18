import AppKit
import SwiftUI

struct MiniStudyView: View {
    @Binding var isPinned: Bool
    @AppStorage("wordIndex") private var storedIndex = 0
    @AppStorage("customWordList") private var customWordList = ""
    @AppStorage("chatModel") private var modelID = "gpt-6.1-sol"
    @AppStorage("chatEffort") private var effort = "xhigh"
    @AppStorage("audioMuted") private var audioMuted = false
    @State private var previewAudioMuted = false
    @State private var textOnlyPreparationScope: String?
    @StateObject private var audio = MiniAudioController()
    @State private var audioWindowVisible = true
    @State private var showingHome = true
    @State private var showingPlan = false
    @State private var showingProbe = false
    @State private var preferLegacyReview = false
    @State private var mode: Mode = .words
    @State private var advisorChat = false
    @State private var tabWidth: CGFloat = 90
    @State private var titleActionsWidth: CGFloat = 110
    @State private var revealed = false
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
    @State private var models: [MiniChatModel] = []
    @State private var loadingModels = false
    @State private var modelsError: String?
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
    @State private var pendingCommand: MiniStudyCommand?
    @State private var inputDrafts: [String: String] = [:]
    @State private var inputDraftsLoaded = false
    @State private var serviceGeneration = UUID()
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
    @State private var cardHides: [MiniStudyCommand] = []
    @State private var cardHidesLoaded = false
    @State private var lastHiddenWord: MiniWord?
    @FocusState private var chatFocused: Bool
    #if DEBUG
    @State private var devStage: MiniDevStage = .live
    @State private var devGeneration = UUID()
    #endif
    private let studyClient = MiniStudyClient()
    private let aiClient = MiniAIClient()
    private let chatStorage = MiniChatStorage()
    private let vocabularyClient = MiniVocabularyClient()

    private enum Mode: String, CaseIterable {
        case words = "词卡"
        case chat = "AI 聊天"
    }

    private var words: [MiniWord] {
        if !isPreview, let vocabulary, vocabulary.activeDeckId != nil { return vocabulary.activeWords }
        let custom = MiniWord.parseList(customWordList)
        let customWords = custom.isEmpty ? MiniWord.starter : custom
        return !isPreview ? (vocabulary?.orderedCustomWords(customWords) ?? customWords) : customWords
    }

    private var chosenModel: MiniChatModel? { models.first { $0.id == modelID } }
    private var dailyDay: MiniDailyDay? { dailyLedger?.days.last { $0.id == activeDailyID } }

    private var isPreview: Bool {
        #if DEBUG
        devStage.isPreview
        #else
        false
        #endif
    }

    private var savingStudy: Bool { !isPreview && (serviceBusy || vocabularyBusy || pendingVocabulary != nil || pendingCommand != nil || audio.authorizing) }
    private var savingStudyControls: Bool {
        !isPreview && (serviceBusy || vocabularyBusy || pendingVocabulary != nil || pendingCommand != nil)
    }
    private var effectiveAudioMuted: Bool { isPreview ? previewAudioMuted : audioMuted }
    private var activeDictation: MiniDictation? {
        isPreview ? previewDictation : serviceSnapshot?.practice?.activeDictation
    }

    private var showingReview: Bool {
        guard let reviewRecord, !reviewRecord.continuedToLearning else { return false }
        return preferLegacyReview || serviceSnapshot?.planning.activeDayId == nil
    }

    private var stageLabel: String {
        if showingProbe { return "独立检验" }
        if showingPlan { return "学习计划" }
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
        if day.paused && day.phase != .finished { return "已暂停" }
        switch day.phase {
        case .review:
            if day.memoryWindow != nil { return "复习 · 重新记忆" }
            switch day.review?.phase {
            case .spelling: return "复习 · 拼写"
            case .finished: return "复习 · 完成"
            default: return "复习 · 判断"
            }
        case .learning:
            if day.retainedLearningWord != nil || day.nextUnstudiedWord != nil { return "学习 · 新词" }
            return day.learning?.phase == .finished ? "学习 · 完成" : "学习 · 拼写"
        case .translation: return "语句 · 翻译"
        case .finished: return Calendar.current.isDateInToday(day.startedAt) ? "今日完成" : "已完成"
        }
    }

    private var studyingWord: MiniWord? {
        guard !browsingWords, !showingReview, let day = dailyDay else { return nil }
        switch day.phase {
        case .review: return day.memoryWindow?.visit?.word ?? day.review?.currentWord
        case .learning: return day.retainedLearningWord ?? day.nextUnstudiedWord ?? day.learning?.currentWord
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
                if showingProbe {
                    probeContent
                } else if showingPlan {
                    planContent
                } else if showingHome {
                    MiniHomeView(day: dailyDay, ledger: dailyLedger, start: { resumeStudy() },
                                 error: dailyError, hasLegacyReview: showingReview,
                                 context: planContext, saving: savingStudy,
                                 startRecovery: { resumeStudy(recovery: true) },
                                 overrideRest: { resumeStudy(overrideRest: true) }, openPlan: openLearningPlan,
                                 continueGroup: { resumeStudy(dayId: $0) },
                                 deckName: isPreview ? "示例词表" : (vocabulary?.activeSelectionName ?? "自定义词表"),
                                 assessmentClient: isPreview ? nil : MiniAssessmentClient(study: studyClient),
                                 assessmentUpdated: { try? await refreshPlanContext(generation: serviceGeneration) },
                                 assessmentPreview: previewAssessment?.snapshot,
                                 assessmentPreviewDetail: previewAssessment?.detail)
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
        .onAppear {
            #if DEBUG
            selectDevStage(devStage)
            #else
            beginDaily()
            #endif
        }
        .onDisappear {
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
        .onChange(of: serviceBusy) { recordVisibleCardIfNeeded() }
        .onChange(of: vocabularyBusy) { recordVisibleCardIfNeeded() }
        .onChange(of: audioPrefetchTargets) { prefetchAudio() }
        .onChange(of: dailyDay) { startBackgroundPreparationIfNeeded() }
        .onChange(of: aiSubmitting) { startBackgroundPreparationIfNeeded() }
        .onChange(of: aiSnapshot?.imported) { startBackgroundPreparationIfNeeded() }
        .onChange(of: effectiveAudioMuted) { synchronizeAudio() }
        .onReceive(NotificationCenter.default.publisher(for: .miniWindowVisibilityChanged)) { event in
            guard let visible = event.object as? Bool else { return }
            if visible, !audioWindowVisible { cardNeedsRefresh = true }
            if visible { lastHiddenWord = nil }
            if !visible, audioWindowVisible, let word = visibleEnglishWord { queueCardHide(word) }
            audioWindowVisible = visible
            recordVisibleCardIfNeeded()
            synchronizeAudio()
        }
        .onReceive(NotificationCenter.default.publisher(for: .NSCalendarDayChanged)) { _ in beginDaily() }
    }

    private var audioPresentation: MiniAudioPresentation? {
        if !isPreview, let card = visibleAnswerCard,
           viewedCardIdentity != card.id || !viewedCardSaved { return nil }
        return cardAudioPresentation
    }

    private var visibleAnswerCard: MiniAudioPresentation? {
        guard activeDictation == nil else { return nil }
        guard let card = cardAudioPresentation else { return nil }
        if browsingWords { return card }
        if let record = reviewRecord, showingReview {
            return record.session.phase == .judgment ? card : nil
        }
        guard let day = dailyDay else { return nil }
        switch day.phase {
        case .review: return day.review?.phase == .judgment ? card : nil
        case .learning:
            return day.retainedLearningWord != nil || day.nextUnstudiedWord != nil ? card : nil
        case .translation:
            return day.currentTranslation?.direction == .englishToChinese || day.currentAttempt?.feedback?.referenceTranslation != nil ? card : nil
        case .finished: return nil
        }
    }

    private var visibleEnglishWord: MiniWord? {
        guard !showingHome, !showingPlan else { return nil }
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

    private func recordVisibleCardIfNeeded() {
        let card = visibleAnswerCard
        if viewedCardIdentity != card?.id {
            viewedCardIdentity = card?.id
            viewedCardSaved = false
            viewedCardVisit = UUID()
            cardViewFailed = false
            cardNeedsRefresh = false
        }
        guard !isPreview, !cardViewFailed, !savingStudy, serviceSnapshot != nil else { return }
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
        do { try studyClient.saveCardHides(cardHides) }
        catch { cardViewFailed = true; return }
        serviceBusy = true
        let generation = serviceGeneration
        Task {
            let saved = await transmitStudyCommand(command, generation: generation)
            guard generation == serviceGeneration else { return }
            serviceBusy = false
            if !saved { cardViewFailed = true }
        }
    }

    private func cardViewAction(_ card: MiniAudioPresentation) -> MiniStudyAction {
        var action = MiniStudyAction(type: .recordCardView, target: .daily)
        action.word = card.word
        if let context = card.context, showingReview || dailyDay?.phase != .translation {
            switch context {
            case .daily(let dayId, let session): action.dayId = dayId; action.session = session
            case .review(let recordId): action = MiniStudyAction(type: .recordCardView, target: .review, recordId: recordId, word: card.word)
            }
        }
        return action
    }

    private var cardAudioPresentation: MiniAudioPresentation? {
        guard !showingHome, !showingPlan, !showingProbe, mode == .words, !editingList else { return nil }
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
        if let record = reviewRecord, showingReview, let word = record.session.currentWord {
            return reviewAudioPresentation(record.session, word: word, id: "review:" + record.id.uuidString.lowercased(),
                                           context: .review(recordId: record.id), paused: record.paused)
        }
        if browsingWords {
            let word = words[min(max(0, storedIndex), words.count - 1)]
            return MiniAudioPresentation(id: "browse:" + MiniAudioTarget.word(word).requestKey, word: word,
                                         context: nil, automatic: false, enabled: true, preview: isPreview)
        }
        guard let day = dailyDay else { return nil }
        switch day.phase {
        case .review:
            if let visit = day.memoryWindow?.visit { return windowAudioPresentation(visit, day: day, session: .review) }
            guard let session = day.review, let word = session.currentWord else { return nil }
            return reviewAudioPresentation(session, word: word, id: "daily:" + day.id + ":review",
                                           context: .daily(dayId: day.id, session: .review), paused: day.paused)
        case .learning:
            if let word = day.retainedLearningWord ?? day.nextUnstudiedWord {
                guard day.sentences.contains(where: { $0.word == word }) else { return nil }
                guard lessonPreparation(for: day)?.isReady != false else { return nil }
                if let visit = day.memoryWindow?.visit { return windowAudioPresentation(visit, day: day, session: .learning) }
                let revealed = day.memoryShowsFullCard
                let memoryIdentity = day.memory.map { ":round:\($0.round):\($0.events.count):\($0.reveals.count):\($0.revealed)" } ?? ""
                let automatic = revealed && textOnlyPreparationScope != audioPreparationScope
                return MiniAudioPresentation(id: "daily:" + day.id + ":new:" + MiniAudioTarget.word(word).requestKey + memoryIdentity,
                                             word: word, context: .daily(dayId: day.id, session: .learning),
                                             automatic: automatic,
                                             enabled: !day.paused, preview: isPreview,
                                             automaticSentence: automatic ? day.sentences.first { $0.word == word } : nil)
            }
            guard let session = day.learning, let word = session.currentWord else { return nil }
            return reviewAudioPresentation(session, word: word, id: "daily:" + day.id + ":learning-spelling",
                                           context: .daily(dayId: day.id, session: .learning), paused: day.paused)
        case .translation:
            guard let task = day.currentTranslation else { return nil }
            return MiniAudioPresentation(id: "writing:" + task.id, word: task.sentence.word,
                                         context: .daily(dayId: day.id, session: nil), automatic: false,
                                         enabled: !day.paused, preview: isPreview)
        case .finished: return nil
        }
    }

    private func windowAudioPresentation(_ visit: MiniMemoryWindow.Visit, day: MiniDailyDay,
                                         session: MiniStudyAction.Session) -> MiniAudioPresentation {
        let automatic = textOnlyPreparationScope != audioPreparationScope
        let sequence: MiniAudioPresentation.Sequence = visit.showsFullCard ? .wordThenSentence
            : (visit.stage == 1 ? .sentence : .word)
        return MiniAudioPresentation(id: "window:" + visit.id.uuidString.lowercased() + (visit.showsFullCard ? ":revealed" : ":hidden"),
                                     word: visit.word, context: .daily(dayId: day.id, session: session),
                                     automatic: automatic, enabled: !day.paused, preview: isPreview,
                                     automaticSentence: automatic ? savedSentence(for: visit.word) : nil,
                                     sequence: sequence)
    }

    private func reviewAudioPresentation(_ session: MiniReviewSession, word: MiniWord, id: String,
                                         context: MiniAudioContext, paused: Bool) -> MiniAudioPresentation {
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
        if let day = dailyDay, !showingReview {
            if day.phase == .translation { return day.currentTranslation?.sentence }
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
        return current + (day.reviewWords + (day.flow?.candidates ?? day.learningWords)).map { .word($0) }
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
        audio.play(.word(word), automatic: true)
    }

    private func lessonPreparation(for day: MiniDailyDay) -> MiniLessonPreparation? {
        guard !day.learningWords.isEmpty, textOnlyPreparationScope != audioPreparationScope else { return nil }
        let requiredWords = day.flow == nil ? day.learningWords : day.flow?.window.visit.map { [$0.word] } ?? []
        guard !requiredWords.isEmpty else { return nil }
        let total = requiredWords.count
        let sentences = requiredWords.compactMap { word in day.sentences.first { $0.word == word } }
        let wordAudio = audio.preparationProgress(for: requiredWords.map { .word($0) }, scope: audioPreparationScope)
        let sentenceAudio = audio.preparationProgress(for: sentences.map { .sentence($0) }, scope: audioPreparationScope)
        let job = preparationJob(for: day, kind: .prepare)
        let preparingExamples = preparationDay == day.id || job?.status.isActive == true
            || (pendingAIRequest?.kind == .prepare && pendingAIRequest?.dayId == day.id)
        let examplesError = preparationError ?? job?.error
            ?? (aiSnapshot?.imported != true && !isPreview ? aiError : nil)
        let examplesStatus: MiniLessonPreparation.Step.Status
        if sentences.count == total { examplesStatus = .complete }
        else if preparingExamples { examplesStatus = .running }
        else if examplesError != nil || job?.status == .cancelled || job?.status == .interrupted || job?.status == .failed {
            examplesStatus = .failed
        } else { examplesStatus = .waiting }
        func audioStep(_ id: MiniLessonPreparation.Step.ID, title: String,
                       progress: MiniAudioPreparationProgress) -> MiniLessonPreparation.Step {
            let status: MiniLessonPreparation.Step.Status
            if progress.ready == total { status = .complete }
            else if progress.failed > 0 { status = .failed }
            else if progress.inProgress > 0 { status = .running }
            else { status = .waiting }
            return .init(id: id, title: title, status: status, completed: progress.ready,
                         total: total, detail: progress.error)
        }
        return MiniLessonPreparation(steps: [
            .init(id: .words, title: "准备单词", status: .complete, completed: total, total: total),
            .init(id: .examples, title: "生成例句", status: examplesStatus, completed: sentences.count,
                  total: total, detail: examplesError ?? (examplesStatus == .failed ? "例句准备已停止，可以重试。" : nil)),
            audioStep(.wordAudio, title: "单词音频", progress: wordAudio),
            audioStep(.sentenceAudio, title: "例句音频", progress: sentenceAudio),
        ])
    }

    private func retryLessonPreparation() {
        guard let day = dailyDay else { return }
        let sentences = day.learningWords.compactMap { word in day.sentences.first { $0.word == word } }
        audio.retryPreparation(day.learningWords.map { .word($0) } + sentences.map { .sentence($0) },
                               scope: audioPreparationScope)
        if !day.wordsToPrepare.isEmpty { startPreparation() }
    }

    @ViewBuilder
    private var audioControls: some View {
        if let card = cardAudioPresentation, activeDictation == nil {
            let showsWord = card.automatic || browsingWords || dailyDay?.memory?.currentWord != nil
                || (dailyDay?.phase == .learning && dailyDay?.nextUnstudiedWord != nil)
            HStack(spacing: 10) {
                audioPlayButton(.word(card.word), label: showsWord ? "读词" : "听词提示")
                if let sentence = audioSentence { audioPlayButton(.sentence(sentence), label: showsWord ? "例句" : "英文提示") }
                Spacer(minLength: 0)
                if canOpenScratchpad {
                    Button { openScratchpad(card) } label: { Image(systemName: "pencil.and.outline") }
                        .help("草稿拼写").accessibilityLabel("草稿拼写")
                        .accessibilityIdentifier("openScratchpad")
                }
                Menu {
                    Button("停止播放") { audio.stop() }
                    Button("重新生成单词音频") { audio.regenerate(.word(card.word)) }
                    if let sentence = audioSentence {
                        Button("重新生成例句音频") { audio.regenerate(.sentence(sentence)) }
                    }
                    Menu("指定单词音色重新生成") {
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
                Image(systemName: "speaker.wave.2").frame(width: 14)
                Text(label)
            }
        }
        .help(label.contains("提示") ? "播放英文，记录本题使用了听音帮助" : "播放已保存音频，未准备时自动生成")
        .accessibilityLabel(label)
    }

    @ViewBuilder
    private var activeContent: some View {
        let deck = words
        let index = min(max(0, storedIndex), deck.count - 1)
        if mode == .words, let practice = activeDictation {
            dictationContent(practice)
        } else if mode == .chat {
            chat(for: advisorChat ? nil : (browsingWords ? deck[index] : studyingWord))
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
                    onFinish: continueToLearning,
                    sentenceForWord: savedSentence,
                    playWord: { audio.play(.word($0)) },
                    playSentence: { audio.play(.sentence($0)) },
                    playSpellingResult: playSpellingResult,
                    commands: isPreview ? nil : reviewCommands(target: .review, session: nil),
                    saving: savingStudyControls
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
        let continueToday: (() -> Void)? = isPreview
            ? (Calendar.current.isDateInToday(day.startedAt) ? nil : { resumeStudy() })
            : (planContext?.canStart == true ? { resumeStudy() } : nil)
        let planOpener: (() -> Void)? = isPreview ? nil : { openLearningPlan() }
        let dayJob = aiSnapshot?.jobs.filter { $0.dayId == day.id && $0.kind != .advisor }
            .max { $0.createdAt < $1.createdAt }
        let cancel: (() -> Void)? = dayJob?.status.isActive == true
            ? { if let dayJob { Task { await controlAI(dayJob, retry: false) } } } : nil
        let lesson = lessonPreparation(for: day)
        let requiredExampleReady = day.flow?.window.visit.map { visit in day.sentences.contains { $0.word == visit.word } }
            ?? day.wordsToPrepare.isEmpty
        let textOnly: (() -> Void)? = requiredExampleReady && lesson?.hasFailure == true
            ? { textOnlyPreparationScope = audioPreparationScope } : nil
        return MiniDailyView(
            day: Binding(
                get: { dailyDay ?? day },
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
            commands: isPreview ? nil : dailyCommands(day),
            saving: savingStudyControls,
            pauseMessage: isPreview ? nil : pauseMessage(for: day),
            resumeLabel: "继续学习",
            canResume: isPreview || planContext?.pendingGroups.first(where: { $0.dayId == day.id })?.canContinue == true,
            openPlan: planOpener,
            aiProgress: dayJob.map { $0.status.label + ($0.progress.isEmpty ? "" : " · " + $0.progress) },
            aiReceipt: dayJob?.receipts.last?.summary,
            cancelAI: cancel,
            lessonPreparation: lesson,
            retryLessonPreparation: retryLessonPreparation,
            continueWithText: textOnly,
            playWord: { audio.play(.word($0)) },
            playSentence: { audio.play(.sentence($0)) },
            playSpellingResult: playSpellingResult,
            savedSentence: savedSentence,
            previewWindow: previewWindowCommands,
            previewLearningSpelling: previewSpellingCommands,
            previewAdvanceTranslation: previewTranslationAdvance
        )
        .id(day.id)
        #if DEBUG
        .safeAreaInset(edge: .bottom, spacing: 4) {
            if devStage == .learningPreparing, !day.wordsToPrepare.isEmpty {
                Button("完成预览备课", action: startPreparation)
                    .font(.caption)
                    .accessibilityIdentifier("completePreviewPreparation")
            }
        }
        #endif
    }

    private func pauseMessage(for day: MiniDailyDay) -> String? {
        if let blocked = planContext?.pendingGroups.first(where: { $0.dayId == day.id })?.blockedReason { return blocked }
        switch serviceSnapshot?.planning.sessions.last(where: { $0.dayId == day.id })?.pauseReason {
        case "budget": return day.flow?.goalReached == true ? "今日新词目标已完成。" : "当前学习位置已保留。"
        case "ended": return "本次已结束，未完成的位置和输入保留。"
        default: return "未完成的位置和输入已保留。"
        }
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
                if showingProbe { closeIndependentProbe(); return }
                showingHome = true
                showingPlan = false
                chatFocused = false
            } label: {
                Image(systemName: showingHome ? "house.fill" : "house")
                    .frame(width: 20, height: 24)
            }
            .accessibilityLabel(showingHome ? "首页" : "返回首页")
            .help("返回首页")
            .disabled(showingHome)

            reviewMenu(compact: compact).disabled(showingProbe && serviceSnapshot?.scheduling?.activeProbe != nil)

            Button {
                if isPreview { previewAudioMuted.toggle() } else { audioMuted.toggle() }
            } label: {
                Image(systemName: effectiveAudioMuted ? "speaker.slash.fill" : "speaker.wave.2")
                    .frame(width: 20, height: 24)
            }
            .accessibilityLabel(effectiveAudioMuted ? "打开声音" : "静音")
            .help(effectiveAudioMuted ? "打开声音；当前词可手动重播" : "静音并停止播放")

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
                let selected = !showingHome && !showingPlan && mode == item
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
                .disabled(showingProbe || (item == .chat && inJudgmentReview))
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
        advisorChat = false
        showingHome = false
        showingPlan = false
        showingProbe = false
        chatFocused = item == .chat
    }

    private func resumeStudy(dayId: String? = nil, recovery: Bool = false, overrideRest: Bool = false, newGroup: Bool = false) {
        if isPreview {
            browsingWords = false
            openMode(.words)
            return
        }
        guard serviceSnapshot != nil else {
            beginDaily()
            return
        }
        guard !savingStudy else { return }
        if let probe = serviceSnapshot?.scheduling?.activeProbe {
            submitStudyAction(probeAction(.endProbe, probe: probe), afterSave: {
                resumeStudy(dayId: dayId, recovery: recovery, overrideRest: overrideRest, newGroup: newGroup)
            })
            return
        }
        if !newGroup, dayId == nil, let record = reviewRecord, showingReview {
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
        var action = MiniStudyAction(type: .begin, target: .daily)
        action.deck = words
        action.flowVersion = "sliding-window-v2"
        action.timezone = TimeZone.current.identifier
        action.dayId = dayId
        if newGroup { action.newGroup = true }
        if recovery { action.recovery = true }
        if overrideRest { action.overrideRest = true }
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
    private func reviewMenu(compact: Bool) -> some View {
        let title = compact ? stageLabel.components(separatedBy: " · ").last ?? stageLabel : stageLabel
        if #available(macOS 14.4, *) {
            MiniStageMenuButton(title: title, accessibilityLabel: "当前阶段：\(stageLabel)", content: reviewMenuItems)
                .fixedSize()
        } else {
            Menu { reviewMenuItems } label: {
                Text(title).font(.system(size: 10, weight: .medium)).lineLimit(1)
            }
            .font(.system(size: NSFont.menuFont(ofSize: 0).pointSize))
            .controlSize(.regular)
            .menuStyle(.borderlessButton)
            .fixedSize()
            .accessibilityLabel("当前阶段：\(stageLabel)")
        }
    }

    @ViewBuilder
    private var reviewMenuItems: some View {
        if showingReview {
            if let record = reviewRecord, record.session.phase != .finished {
                Button(record.paused ? "继续复习" : "暂停复习") {
                    pauseLegacyReview(!record.paused)
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
            Button("返回每日学习") { resumeStudy() }
        } else {
            if let day = dailyDay, day.phase != .finished {
                Button(day.paused ? "继续学习" : "暂停学习") {
                    if day.paused { resumeStudy(dayId: day.id) } else { pauseDaily(true) }
                }
            } else {
                Button("检查今日任务", action: beginDaily)
            }
            Menu(levelRequestPending ? "英语水平 · 设置中" : "英语水平 · \(savedEnglishLevel ?? "未设置")") {
                if let savedEnglishLevel { Text("当前水平 · \(savedEnglishLevel)") }
                else { Text("尚未设置英语水平") }
                ForEach(["A1", "A2", "B1", "B2", "C1", "C2"], id: \.self) { level in
                    Button(level) { setEnglishLevel(level) }
                }
            }
            .disabled(isPreview || aiSubmitting || pendingAIRequest != nil || levelRequestPending)
            Divider()
            Button("浏览词表") {
                browsingWords = true
                openMode(.words)
            }
        }
        Divider()
        Button("学习计划", action: openLearningPlan)
            .disabled(isPreview)
        Button("记忆曲线…") {
            NotificationCenter.default.post(name: .miniOpenMemoryWindow, object: nil)
        }
        Button(serviceSnapshot?.scheduling?.activeProbe == nil ? "独立拼写检验" : "继续独立拼写检验", action: openIndependentProbe)
            .disabled(isPreview || savingStudy)
        if let record = reviewRecord, !record.continuedToLearning, !showingReview {
            Button("继续旧复习") { preferLegacyReview = true; resumeStudy() }
                .disabled(savingStudy)
        }
        if let groups = planContext?.pendingGroups, !groups.isEmpty {
            Menu("保留的任务") {
                ForEach(groups) { group in
                    Button("继续 \(group.label)") { resumeStudy(dayId: group.dayId) }
                        .disabled(!group.canContinue || savingStudy)
                }
            }
        }
        #if DEBUG
        Divider()
        MiniDevMenu(stage: devStage, select: selectDevStage)
        #endif
    }

    private var reviewPaused: some View {
        VStack(spacing: 12) {
            Text("复习已暂停").font(.headline)
            Button("继续复习") { pauseLegacyReview(false) }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func dictationContent(_ practice: MiniDictation) -> some View {
        MiniDictationPracticeView(practice: practice,
                                  draft: isPreview ? $previewDictationDraft
                                    : draftBinding(key: "dictation/" + practice.id.uuidString.lowercased(),
                                                   fallback: practice.attempts.last?.answer ?? ""),
                                  saving: savingStudyControls,
                                  submit: { answer in
            if isPreview {
                previewDictation = MiniDictation(id: practice.id, target: practice.target, dayId: practice.dayId,
                    recordId: practice.recordId, session: practice.session, word: practice.word,
                    openedAt: practice.openedAt, closedAt: nil, revealedAt: .now,
                    attempts: practice.attempts + [MiniDictationAttempt(id: UUID(), answer: answer,
                        correct: answer.trimmingCharacters(in: .whitespacesAndNewlines)
                            .caseInsensitiveCompare(practice.word.spelling.trimmingCharacters(in: .whitespacesAndNewlines)) == .orderedSame,
                        submittedAt: .now)])
                return
            }
            var action = dictationAction(.submitDictation, practice: practice)
            action.answer = answer
            submitStudyAction(action)
        }, reveal: {
            if isPreview {
                previewDictation = MiniDictation(id: practice.id, target: practice.target, dayId: practice.dayId,
                    recordId: practice.recordId, session: practice.session, word: practice.word,
                    openedAt: practice.openedAt, closedAt: nil, revealedAt: .now, attempts: practice.attempts)
                return
            }
            submitStudyAction(dictationAction(.revealDictation, practice: practice))
        }, close: {
            if isPreview { previewDictation = nil; return }
            submitStudyAction(dictationAction(.closeDictation, practice: practice))
        }, playWord: { audio.play(.word($0), automatic: true) })
        .id(practice.id)
    }

    private var canOpenScratchpad: Bool {
        guard mode == .words, !browsingWords, activeDictation == nil else { return false }
        if showingReview { return reviewRecord?.session.currentJudgment != nil }
        guard let day = dailyDay, !day.paused else { return false }
        if let visit = day.memoryWindow?.visit { return visit.showsFullCard }
        if day.phase == .review { return day.review?.currentJudgment != nil }
        return day.phase == .learning && day.memoryShowsFullCard
            && (day.memory != nil || day.retainedLearningWord != nil)
    }

    private func openScratchpad(_ card: MiniAudioPresentation) {
        guard canOpenScratchpad, !savingStudy, let context = card.context else { return }
        let action: MiniStudyAction
        switch context {
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
        } else { submitStudyAction(action) }
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
        audio.stop()
        if let card = visibleAnswerCard, audioWindowVisible {
            submitStudyAction(cardViewAction(card), afterSave: { showIndependentProbe() })
        } else { showIndependentProbe() }
    }

    private func showIndependentProbe() {
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
                         startCourse: { resumeStudy(newGroup: true) })
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

    private func refreshPlanContext(generation: UUID) async throws {
        let deckRevision = vocabulary?.revision
        let snapshot = try await studyClient.planPreview(deck: words)
        guard generation == serviceGeneration, !isPreview, vocabulary?.revision == deckRevision else { return }
        applySnapshot(snapshot)
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
        let day = selectedID.flatMap { id in snapshot.ledger.days.last { $0.id == id } }
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
                inputDrafts = try studyClient.loadDrafts()
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
            pendingCommand = try studyClient.pendingCommand()
            if let pendingCommand {
                guard await transmitStudyCommand(pendingCommand, generation: generation, allowRebase: false) else { return }
            }
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

    private func transmitStudyCommand(_ command: MiniStudyCommand, generation: UUID, allowRebase: Bool = true,
                                      conflictSnapshot: MiniStudySnapshot? = nil) async -> Bool {
        let before = conflictSnapshot ?? serviceSnapshot
        do {
            try studyClient.savePending(command)
            pendingCommand = command
            let snapshot = try await studyClient.perform(command)
            try studyClient.clearPending(requestId: command.requestId)
            guard generation == serviceGeneration, !isPreview else { return true }
            pendingCommand = nil
            applySnapshot(snapshot)
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
            do { try await refreshPlanContext(generation: generation) }
            catch {
                guard generation == serviceGeneration else { return true }
                planContext = nil
            }
            return true
        } catch MiniStudyClientError.conflict {
            do {
                let snapshot = try await studyClient.planPreview(deck: words)
                guard generation == serviceGeneration, !isPreview else { return false }
                if allowRebase, let before, let occurredAt = command.occurredAt,
                   MiniStudyClient.eligibleRebase(command: command, before: before, after: snapshot) {
                    applySnapshot(snapshot)
                    let retry = MiniStudyCommand(expectedRevision: snapshot.revision, action: command.action,
                                                 occurredAt: occurredAt)
                    if let visit = cardViewRequests.removeValue(forKey: command.requestId) { cardViewRequests[retry.requestId] = visit }
                    if command.action.type == .hideCard, let index = cardHides.firstIndex(where: { $0.requestId == command.requestId }) {
                        cardHides[index] = retry
                        try studyClient.saveCardHides(cardHides)
                    }
                    return await transmitStudyCommand(retry, generation: generation, allowRebase: false)
                }
                try studyClient.clearPending(requestId: command.requestId)
                pendingCommand = nil
                applySnapshot(snapshot)
                dailyError = MiniStudyClientError.conflict.localizedDescription
            } catch {
                if generation == serviceGeneration { dailyError = "状态已变化，但重新读取失败。请重试。" }
            }
            return false
        } catch MiniStudyClientError.rejected {
            do { try studyClient.clearPending(requestId: command.requestId) } catch { }
            guard generation == serviceGeneration else { return false }
            pendingCommand = nil
            dailyError = MiniStudyClientError.rejected.localizedDescription
            return false
        } catch {
            guard generation == serviceGeneration else { return false }
            try? studyClient.clearPending(requestId: command.requestId)
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
            try? studyClient.saveDrafts(inputDrafts)
        })
    }

    private func clearSubmittedDraft(_ action: MiniStudyAction) {
        if action.type == .submitSpelling, let word = action.word {
            let identity = action.target == .daily ? action.dayId : action.recordId?.uuidString
            inputDrafts.removeValue(forKey: draftKey(target: action.target, session: action.session, word: word, identity: identity))
        } else if action.type == .windowAdvance, let visitId = action.visitId {
            inputDrafts.removeValue(forKey: "window/" + visitId.uuidString.lowercased())
        } else if action.type == .submitTranslation, let taskId = action.taskId {
            inputDrafts.removeValue(forKey: "translation/" + taskId)
        } else if action.type == .submitDictation, let id = action.dictationId {
            inputDrafts.removeValue(forKey: "dictation/" + id.uuidString.lowercased())
        } else if action.type == .submitProbe, let id = action.probeId {
            inputDrafts.removeValue(forKey: "probe/" + id.uuidString.lowercased())
        } else { return }
        try? studyClient.saveDrafts(inputDrafts)
    }

    private func reviewCommands(target: MiniStudyAction.Target, session: MiniStudyAction.Session?) -> MiniReviewCommands {
        let current: MiniReviewSession?
        if target == .review { current = reviewRecord?.session }
        else { current = session == .learning ? dailyDay?.learning : dailyDay?.review }
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
            submitStudyAction(command)
        }, advanceJudgment: { markWrong in
            guard word != nil else { return }
            var command = action(.advanceJudgment)
            command.markWrong = markWrong
            submitStudyAction(command)
        }, submitSpelling: { answer in
            guard word != nil, !answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
            var command = action(.submitSpelling)
            command.answer = answer
            command.advanceOnCorrect = false
            submitStudyAction(command)
        }, advanceSpelling: {
            guard word != nil else { return }
            submitStudyAction(action(.advanceSpelling))
        }, openDictation: {
            guard word != nil else { return }
            submitStudyAction(action(.openDictation))
        }, clearJudgment: {
            guard word != nil else { return }
            submitStudyAction(action(.clearJudgment))
        })
    }

    private func dailyCommands(_ day: MiniDailyDay) -> MiniDailyCommands {
        let task = day.currentTranslation
        let draft = task.map { draftBinding(key: "translation/" + $0.id, fallback: day.translationDraft) } ?? .constant("")
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
            submitStudyAction(dailyAction(.completeReview, dayId: day.id), afterSave: { startPreparation() })
        }, completeLearning: {
            submitStudyAction(dailyAction(.completeLearning, dayId: day.id), afterSave: { startPreparation() })
        }, submitTranslation: { answer in
            guard let task else { return }
            var action = dailyAction(.submitTranslation, dayId: day.id)
            action.taskId = task.id
            action.answer = answer
            submitStudyAction(action, afterSave: { if day.flow == nil { await gradeDailyTranslation() } })
        }, advanceTranslation: {
            guard let task else { return }
            var action = dailyAction(.advanceTranslation, dayId: day.id)
            action.taskId = task.id
            submitStudyAction(action, afterSave: {
                if dailyDay?.flow?.goalReached == true { showingHome = true }
            })
        }, memory: memoryCommands, window: windowCommands(day), openDictation: { word in
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
            updateDaily { MiniDevPreview.editVisit(&$0, corrected: true) }
        }, advance: { remembered in
            let passed = remembered ?? dailyDay?.memoryWindow?.visit?.willRemember ?? false
            selectDevStage(!passed ? .learning : (visit.stage == 0 ? .learningContext : (visit.stage == 1 ? .learningMeaning : .learningSpelling)))
        }, saveDraft: {})
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
            updateDaily { $0.learning?.submitSpelling(answer) ?? false }
        }, advanceSpelling: { selectDevStage(.learningFinished) })
        #else
        return nil
        #endif
    }

    private var previewTranslationAdvance: (() -> Void)? {
        #if DEBUG
        guard isPreview, dailyDay?.phase == .translation else { return nil }
        return { selectDevStage(devStage == .englishToChinese ? .chineseToEnglish : .learning) }
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
        return MiniWindowCommands(draft: draft, choose: { remembered in
            var command = action(.windowChoose)
            command.remembered = remembered
            submitStudyAction(command)
        }, correct: {
            submitStudyAction(action(.windowCorrect))
        }, advance: { remembered in
            var command = action(.windowAdvance)
            command.remembered = remembered
            submitStudyAction(command)
        }, saveDraft: {
            submitStudyAction(action(.windowDraft))
        })
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

    private func startPreparation() {
        Task {
            if !isPreview, aiSnapshot?.imported != true { await connectAI(generation: serviceGeneration) }
            await prepareDaily(retrying: true)
        }
    }

    private func startBackgroundPreparationIfNeeded() {
        guard !isPreview, !showingHome, !showingPlan, !showingProbe, !browsingWords, !showingReview, mode == .words,
              let day = dailyDay, !day.paused, !aiSubmitting, pendingAIRequest == nil,
              aiSnapshot?.imported == true, aiError == nil, let kind = MiniDailyAI.preparationKind(for: day),
              preparationJob(for: day, kind: kind) == nil || preparationJob(for: day, kind: kind)?.status == .completed else { return }
        Task { await prepareDaily(retrying: false) }
    }

    private func prepareDaily(retrying: Bool) async {
        if !retrying && (showingHome || showingPlan || showingProbe || browsingWords || mode != .words) { return }
        guard let day = dailyDay, !day.paused, day.writingRequired != false else { return }
        #if DEBUG
        if isPreview {
            updateDaily { $0.addSentences(MiniDevPreview.sentences(for: $0.wordsToPrepare)) }
            preparationDay = nil
            preparationError = nil
            return
        }
        #endif
        guard let kind = MiniDailyAI.preparationKind(for: day), !aiSubmitting,
              pendingAIRequest == nil,
              preparationJob(for: day, kind: kind)?.status.isActive != true else { return }
        preparationError = nil
        if let previous = preparationJob(for: day, kind: kind),
           previous.status != .completed, previous.model == selectedModel, previous.effort == selectedEffort {
            guard retrying else { return }
            await controlAI(previous, retry: true)
            return
        }
        await startAI(MiniAIStart(kind: kind, dayId: day.id, model: selectedModel, effort: selectedEffort))
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
           previous.model == selectedModel, previous.effort == selectedEffort {
            await controlAI(previous, retry: true)
            return
        }
        await startAI(MiniAIStart(kind: .feedback, dayId: day.id, attemptId: attempt.id,
                                  model: selectedModel, effort: selectedEffort))
    }

    private var selectedModel: String { modelID.isEmpty ? "gpt-6.1-sol" : modelID }
    private var selectedEffort: String { effort.isEmpty ? "xhigh" : effort }
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
        Task { await startAI(MiniAIStart(kind: .advisor, message: message, model: selectedModel, effort: selectedEffort)) }
    }

    private func connectAI(generation: UUID) async {
        guard generation == serviceGeneration, !isPreview, !aiSubmitting else { return }
        do {
            var snapshot = try await aiClient.snapshot()
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
            chatArchiveError = nil
            aiError = nil
            try await refreshAIStudyIfNeeded(generation: generation)
            if let pendingAIRequest { await startAI(pendingAIRequest) }
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
            if request.kind == .advisor {
                chatDrafts[request.conversationId] = ""
                try chatStorage.saveDrafts(chatDrafts)
            }
            aiSnapshot = try await aiClient.snapshot()
            try await refreshAIStudyIfNeeded(generation: generation)
            observeAI(generation: generation)
        } catch {
            guard generation == serviceGeneration, !isPreview else { return }
            try? chatStorage.clearPending(requestId: request.requestId)
            pendingAIRequest = nil
            aiError = error.localizedDescription
        }
    }

    private func observeAI(generation: UUID) {
        aiObservation?.cancel()
        guard !isPreview, aiSnapshot?.jobs.contains(where: { $0.status.isActive }) == true else { return }
        aiObservation = Task {
            do {
                while !Task.isCancelled {
                    try await Task.sleep(for: .milliseconds(800))
                    let snapshot = try await aiClient.snapshot()
                    guard generation == serviceGeneration, !isPreview else { return }
                    aiSnapshot = snapshot
                    try await refreshAIStudyIfNeeded(generation: generation)
                    guard snapshot.jobs.contains(where: { $0.status.isActive }) else { return }
                }
            } catch is CancellationError {
                return
            } catch {
                guard generation == serviceGeneration, !isPreview else { return }
                aiError = "任务状态暂未刷新，已提交内容仍保留：\(error.localizedDescription)"
            }
        }
    }

    private func refreshAIStudyIfNeeded(generation: UUID) async throws {
        let committedRevision = aiSnapshot?.jobs.flatMap(\.receipts).map(\.revision).max() ?? 0
        let finishedTeaching = aiSnapshot?.jobs.filter {
            $0.kind != .advisor && $0.status == .completed && appliedAIJobs[$0.id] != $0.updatedAt
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
            let snapshot = try await aiClient.snapshot()
            guard generation == serviceGeneration, !isPreview else { return }
            aiSnapshot = snapshot
            aiError = nil
            try await refreshPlanContext(generation: generation)
            observeAI(generation: generation)
        } catch {
            guard generation == serviceGeneration, !isPreview else { return }
            aiError = error.localizedDescription
        }
    }

    private func continueToLearning() {
        guard let record = reviewRecord, record.session.phase == .finished else { return }
        if isPreview {
            updateReview { $0.continuedToLearning = true }
            move(to: record.nextWordIndex)
        } else {
            submitStudyAction(MiniStudyAction(type: .continueToLearning, target: .review, recordId: record.id))
        }
    }

    private func updateReview(_ update: (inout MiniReviewRecord) -> Void) {
        guard isPreview, var record = reviewRecord else { return }
        update(&record)
        reviewRecord = record
        reviewError = nil
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

    private func chat(for word: MiniWord?) -> some View {
        let conversationId = MiniChatStorage.conversationId(for: word)
        let messages = aiSnapshot?.messages.filter { $0.conversationId == conversationId } ?? []
        let jobs = aiSnapshot?.jobs.filter { $0.conversationId == conversationId && $0.kind == .advisor } ?? []
        let draft = Binding(get: { chatDrafts[conversationId, default: ""] }, set: { value in
            chatDrafts[conversationId] = value
            guard !isPreview else { return }
            try? chatStorage.saveDrafts(chatDrafts)
        })
        return VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(concealChatWord ? "当前练习" : (word?.spelling ?? "学习顾问"))
                    .font(.headline).lineLimit(1)
                Spacer(minLength: 8)
                modelMenu
            }
            HStack(spacing: 10) {
                Button("查看重点") { send("请查询并列出当前单词已有的重点；没有当前单词时列出近期重点。先不要新增。", about: word) }
                Button("查看记忆") { send("请查询并列出已保存的稳定偏好与记忆，说明可以怎样修改或删除。", about: word) }
                Spacer(minLength: 0)
                Menu {
                    Button("刷新任务") { Task { await connectAI(generation: serviceGeneration) } }
                        .disabled(isPreview || aiSubmitting)
                    Button("清除此处聊天", role: .destructive) { clearChat(conversationId) }
                        .disabled(isPreview || aiSubmitting)
                } label: { Image(systemName: "ellipsis") }
                .menuStyle(.borderlessButton).fixedSize()
            }
            .font(.caption).disabled(aiSubmitting || pendingAIRequest != nil)
            if let modelsError { Text(modelsError).font(.caption2).foregroundStyle(.secondary) }
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
                            if messages.isEmpty { Text("可以问用法、学习进度，或调整今天的学习计划。").font(.caption).foregroundStyle(.secondary) }
                            ForEach(messages) { message in chatMessage(role: message.role, text: message.text) }
                            ForEach(jobs.suffix(3)) { job in aiJobStatus(job) }
                            if aiSubmitting { ProgressView("正在提交…").controlSize(.small) }
                        }
                        Color.clear.frame(height: 1).id("endOfChat")
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }
                .defaultScrollAnchor(.bottom)
                .onChange(of: messages.count) { _, _ in proxy.scrollTo("endOfChat", anchor: .bottom) }
            }
            HStack {
                TextField("问问 AI…", text: draft)
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

    private func chatMessage(role: MiniChatMessage.Role, text: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(role == .user ? "你" : "AI").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
            Text(text).font(.callout).textSelection(.enabled)
        }.frame(maxWidth: .infinity, alignment: .leading)
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
            ForEach(job.receipts) { receipt in
                Label(receipt.summary, systemImage: "checkmark.circle")
                    .font(.caption2).foregroundStyle(.secondary).textSelection(.enabled)
            }
            if let error = job.error { Text(error).font(.caption).foregroundStyle(.secondary) }
        }.disabled(aiSubmitting)
    }

    private var modelMenu: some View {
        Menu {
            Picker("模型", selection: Binding(get: { selectedModel }, set: { modelID = $0 })) {
                Text("gpt-6.1-sol").tag("gpt-6.1-sol")
                ForEach(models.filter { $0.id != "gpt-6.1-sol" }) { model in Text(model.name).tag(model.id) }
                if !selectedModel.isEmpty, selectedModel != "gpt-6.1-sol", chosenModel == nil {
                    Text(selectedModel + "（当前不可用）").tag(selectedModel)
                }
            }
            Picker("推理强度", selection: Binding(get: { selectedEffort }, set: { effort = $0 })) {
                ForEach(Array(Set((chosenModel?.efforts ?? []) + ["xhigh", selectedEffort])).sorted(), id: \.self) { value in
                    Text(value == "xhigh" ? "XHigh" : value.capitalized).tag(value)
                }
            }
            Divider()
            Button("刷新模型列表") { Task { await refreshModels() } }.disabled(loadingModels || isPreview)
        } label: {
            Text(loadingModels ? "读取模型…" : "\(selectedModel) · \(selectedEffort)")
                .font(.caption).lineLimit(1)
        }
        .menuStyle(.borderlessButton).fixedSize().disabled(aiSubmitting)
        .accessibilityLabel("模型和推理强度")
    }

    private func refreshModels() async {
        guard !isPreview, !loadingModels else { return }
        loadingModels = true
        modelsError = nil
        defer { loadingModels = false }
        do {
            let runtime = try await MiniChatService(client: aiClient).runtime()
            guard !isPreview else { return }
            models = runtime.models
            if !runtime.available || !runtime.authenticated { modelsError = runtime.error ?? "Codex 尚未就绪，请检查登录。" }
            else if chosenModel == nil { modelsError = "已选模型当前不可用，请重新选择；已有选择保留。" }
            else if let model = chosenModel, !model.efforts.isEmpty, !model.efforts.contains(selectedEffort) {
                modelsError = "当前模型不支持已选推理强度，请重新选择。"
            }
        } catch is CancellationError {
            return
        } catch { modelsError = error.localizedDescription }
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
        storedIndex = index
        revealed = false
    }

    private func saveList(_ text: String) {
        customWordList = text
        move(to: 0)
        editingList = false
        if !isPreview, vocabulary?.activeDeckId != nil { activateVocabulary(nil) }
        else { beginDaily() }
    }

    #if DEBUG
    private func selectDevStage(_ stage: MiniDevStage) {
        audio.disconnect()
        previewDictation = nil
        previewDictationDraft = ""
        previewAudioMuted = false
        devGeneration = UUID()
        serviceGeneration = UUID()
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
        revealed = false
        chatFocused = false
        mode = .words
        advisorChat = false
        showingHome = stage == .home || stage == .live
        showingPlan = false
        showingProbe = false
        preferLegacyReview = false

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
                listDraft = customWordList.isEmpty ? words.map { "\($0.spelling)\t\($0.meaning)" }.joined(separator: "\n") : customWordList
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
        Task {
            await startAI(MiniAIStart(kind: .advisor, dayId: dailyDay?.id, attemptId: dailyDay?.currentAttempt?.id,
                                      word: word, conversationId: conversationId, message: question,
                                      model: selectedModel, effort: selectedEffort))
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
