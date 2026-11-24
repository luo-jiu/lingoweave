import AVFoundation
import Foundation

private actor AudioTestService: MiniAudioServing {
    var requests: [MiniAudioRequest] = []
    var authorizations: [MiniAudioPlaybackRequest] = []
    var starts: [MiniAudioPlaybackStart] = []
    var events: [String] = []
    var delayRequests = false
    var failStarts = 0
    var delayStarts = false
    var delayAuthorizations = false
    var authorizationError: MiniStudyClientError?
    var failedRequests = 0
    private var waiting: [CheckedContinuation<Void, Never>] = []
    private var waitingStarts: [CheckedContinuation<Void, Never>] = []
    private var waitingAuthorizations: [CheckedContinuation<Void, Never>] = []

    func setDelayed(_ value: Bool) { delayRequests = value }
    func setStartsDelayed(_ value: Bool) { delayStarts = value }
    func setAuthorizationsDelayed(_ value: Bool) { delayAuthorizations = value }
    func setAuthorizationError(_ error: MiniStudyClientError?) { authorizationError = error }
    func setFailures(requests: Int = 0, starts: Int = 0) { failedRequests = requests; failStarts = starts }
    func releaseRequests() { let previous = waiting; waiting = []; for item in previous { item.resume() } }
    func releaseStarts() { delayStarts = false; let previous = waitingStarts; waitingStarts = []; for item in previous { item.resume() } }
    func releaseAuthorizations() { delayAuthorizations = false; let previous = waitingAuthorizations; waitingAuthorizations = []; for item in previous { item.resume() } }
    func counts() -> (Int, Int, Int) { (requests.count, authorizations.count, starts.count) }
    func savedStarts() -> [MiniAudioPlaybackStart] { starts }
    func savedAuthorizations() -> [MiniAudioPlaybackRequest] { authorizations }
    func savedRequests() -> [MiniAudioRequest] { requests }
    func request(_ input: MiniAudioRequest, retryTransport: Bool) async throws -> MiniAudioResult {
        requests.append(input); events.append("request")
        if delayRequests { await withCheckedContinuation { waiting.append($0) } }
        if failedRequests > 0 { failedRequests -= 1; throw MiniStudyClientError.unavailable }
        return MiniAudioResult(targetKey: input.target.requestKey,
                               asset: MiniAudioAsset(id: UUID(), targetKey: input.target.requestKey,
                                                     target: input.target, text: input.target.word.spelling,
                                                     voice: "ryan", durationSeconds: 0.1), job: nil, reused: true)
    }
    func job(_ id: UUID) async throws -> MiniAudioJob { throw MiniStudyClientError.invalidResponse }
    func snapshot() async throws -> MiniAudioSnapshot { throw MiniStudyClientError.invalidResponse }
    func file(_ id: UUID) async throws -> Data { events.append("file"); return Data([1, 2, 3]) }
    func authorize(_ input: MiniAudioPlaybackRequest) async throws -> MiniAudioPlaybackReceipt {
        authorizations.append(input); events.append("authorize")
        if delayAuthorizations { await withCheckedContinuation { waitingAuthorizations.append($0) } }
        if let authorizationError { throw authorizationError }
        return MiniAudioPlaybackReceipt(id: UUID(), requestId: input.requestId, assetId: input.assetId,
                                        visitId: input.visitId, status: .authorized, authorizedAt: .now,
                                        startedAt: nil, learningRevision: 7)
    }
    func started(_ input: MiniAudioPlaybackStart) async throws -> MiniAudioPlaybackReceipt {
        starts.append(input); events.append("started")
        if delayStarts { await withCheckedContinuation { waitingStarts.append($0) } }
        if failStarts > 0 { failStarts -= 1; throw MiniStudyClientError.unavailable }
        return MiniAudioPlaybackReceipt(id: input.playbackId, requestId: input.requestId, assetId: UUID(),
                                        visitId: UUID(), status: .started, authorizedAt: input.occurredAt,
                                        startedAt: input.occurredAt, learningRevision: 7)
    }
}

private actor PreparationTestService: MiniAudioServing {
    private var requests: [MiniAudioRequest] = []
    private var jobs: [String: MiniAudioJob] = [:]
    private var assets: [MiniAudioAsset] = []
    private var cached: [String: MiniAudioAsset] = [:]
    private var delayed = Set<String>()
    private var waiting: [String: [CheckedContinuation<Void, Never>]] = [:]
    private var lostResponses = Set<String>()

    func delay(_ target: MiniAudioTarget) { delayed.insert(target.requestKey) }
    func release(_ target: MiniAudioTarget) {
        delayed.remove(target.requestKey)
        let previous = waiting.removeValue(forKey: target.requestKey) ?? []
        for continuation in previous { continuation.resume() }
    }
    func loseNextResponse(_ target: MiniAudioTarget) { lostResponses.insert(target.requestKey) }
    func count(_ target: MiniAudioTarget) -> Int { requests.filter { $0.target.requestKey == target.requestKey }.count }
    func requestIDs(_ target: MiniAudioTarget) -> [UUID] { requests.filter { $0.target == target }.map(\.requestId) }
    func cache(_ target: MiniAudioTarget, historicalOnly: Bool = false) {
        let asset = MiniAudioAsset(id: UUID(), targetKey: "profile:" + target.requestKey, target: target,
                                   text: target.word.spelling, voice: "ryan", durationSeconds: 0.1)
        assets.append(asset)
        if !historicalOnly { cached[target.requestKey] = asset }
    }
    func advance(_ target: MiniAudioTarget, to status: MiniAudioJob.Status, error: String? = nil) {
        guard let previous = jobs[target.requestKey] else { preconditionFailure("Missing controlled preparation job") }
        var assetId: UUID?
        if status == .completed {
            cache(target)
            assetId = cached[target.requestKey]?.id
        }
        jobs[target.requestKey] = MiniAudioJob(id: previous.id, target: target, status: status,
                                              progress: status.rawValue, error: error, assetId: assetId)
    }
    func request(_ input: MiniAudioRequest, retryTransport: Bool) async throws -> MiniAudioResult {
        precondition(!retryTransport, "Background retries share a single transport and generation retry budget")
        requests.append(input)
        let key = input.target.requestKey
        if delayed.contains(key) { await withCheckedContinuation { waiting[key, default: []].append($0) } }
        if let asset = cached[key] { return MiniAudioResult(targetKey: asset.targetKey, asset: asset, job: nil, reused: true) }
        if jobs[key]?.status.isActive != true {
            jobs[key] = MiniAudioJob(id: UUID(), target: input.target, status: .queued, progress: "queued", error: nil, assetId: nil)
        }
        if lostResponses.remove(key) != nil { throw MiniStudyClientError.unavailable }
        return MiniAudioResult(targetKey: "profile:" + key, asset: nil, job: jobs[key], reused: true)
    }
    func job(_ id: UUID) async throws -> MiniAudioJob {
        guard let job = jobs.values.first(where: { $0.id == id }) else { throw MiniStudyClientError.invalidResponse }
        return job
    }
    func snapshot() async throws -> MiniAudioSnapshot {
        MiniAudioSnapshot(schemaVersion: 1, revision: 0, assets: assets, jobs: Array(jobs.values), playbacks: [])
    }
    func file(_ id: UUID) async throws -> Data { preconditionFailure("Background preparation never downloads playback data") }
    func authorize(_ input: MiniAudioPlaybackRequest) async throws -> MiniAudioPlaybackReceipt { preconditionFailure("Background preparation never authorizes playback") }
    func started(_ input: MiniAudioPlaybackStart) async throws -> MiniAudioPlaybackReceipt { preconditionFailure("Background preparation never reports playback") }
}

@MainActor
private final class AudioTestPlayer: MiniAudioPlaying {
    var onFinish: ((Bool) -> Void)?
    var volume: Double = 1
    func setVolume(_ volume: Double) { self.volume = volume }
    var plays = 0
    var stops = 0
    var canPlay = true
    var beforePlay: (() -> Void)?
    func play(_ data: Data) throws -> Bool { beforePlay?(); plays += 1; return canPlay }
    func stop() { stops += 1 }
}

@main
struct MiniAudioClientTests {
    private let apple = MiniWord(spelling: "apple", meaning: "苹果")
    private let book = MiniWord(spelling: "book", meaning: "书")

    @MainActor
    static func main() async throws {
        let tests = Self()
        try tests.testRenderedVolumeAndPeakProtection()
        try tests.testCanonicalRequestsAndStartedRecovery()
        try await tests.testOneAutomaticPlayPerVisit()
        try await tests.testRecallPagesPlayOnlyTheirDisplayedContent()
        try await tests.testAutomaticWordThenSentenceWaitsForCompletion()
        try await tests.testAutomaticSentenceStartsAfterTheDefaultGap()
        try await tests.testCancellingDuringTheSentenceGapNeverStartsPlayback()
        try await tests.testRevealCreatesASequenceWithANewVisit()
        try await tests.testChangingWordsCancelsPendingSequencePlayback()
        try await tests.testManualReplayCancelsRemainingAutomaticAudio()
        try await tests.testUnavailableCardsCancelTheAutomaticSequence()
        try await tests.testAutomaticSequenceFailuresStayVisible()
        try await tests.testStalePlaybackAuthorization()
        try await tests.testPreviewSequencePreservesLearningRecovery()
        try await tests.testLateGenerationNeverPlaysAfterLeaving()
        try await tests.testPauseHideAndMuteNeverReplayTheSameVisit()
        try await tests.testSpellingIsManualAndAuthorizationPrecedesPlayback()
        try await tests.testAutomaticAdvancePronouncesTheSavedResult()
        try await tests.testPreviewAuditionsWithoutLearningOrRecovery()
        try await tests.testSameIDModeChangesInvalidateGeneration()
        try await tests.testLateAuthorizationCannotRefreshPreview()
        try await tests.testFailedActualStartAndReceiptRecovery()
        try await tests.testPrefetchAndFailuresDoNotLoop()
        try await tests.testPreviewStopsPendingReceiptDrain()
        try await tests.testPreparationUsesRealJobsAndIndependentEnqueue()
        try await tests.testPreparationRetriesOnlyFailedTargets()
        try await tests.testPreparationExhaustionAndManualRetry()
        try await tests.testLeavingDuringPreparationRetry()
        try await tests.testPreparationScopeAndReconnection()
        try await tests.testCardPlaybackEnqueuesBeforeBackgroundPreparation()
        try tests.testWindowPreparationWaitsForTheEntirePool()
        tests.testLegacyPreparationRequiresAllCards()
        tests.testSingletonPreparationAndWindowWithoutVisit()
        print("33 mini audio visit, sequence, preparation and recovery tests passed.")
        let environment = ProcessInfo.processInfo.environment
        if let address = environment["MINI_TEST_AUDIO_SERVICE_URL"], let url = URL(string: address),
           let token = environment["MINI_TEST_AUDIO_TOKEN_PATH"] {
            try await tests.testHTTPAudio(baseURL: url, tokenFile: URL(fileURLWithPath: token))
            print("Swift → HTTP audio cache, playback receipt and support integration passed (controlled player; no speaker output).")
        }
    }

    @MainActor
    private func testRenderedVolumeAndPeakProtection() throws {
        var pcm = Data()
        let block = 8192
        for frame in 0..<(block * 7) {
            let amplitude: Double = ((block * 3)..<(block * 5)).contains(frame) ? 0.94 : 0.125
            var sample = Int16(sin(Double(frame % 24) * .pi / 12) * amplitude * 32768).littleEndian
            withUnsafeBytes(of: &sample) { pcm.append(contentsOf: $0) }
        }
        var wav = Data("RIFF".utf8)
        func append32(_ number: Int) {
            var value = UInt32(number).littleEndian
            withUnsafeBytes(of: &value) { wav.append(contentsOf: $0) }
        }
        append32(48 + pcm.count)
        wav.append(contentsOf: "WAVEJUNK".utf8)
        append32(3)
        wav.append(contentsOf: [0, 0, 0, 0]) // Odd-length metadata and its pad byte.
        wav.append(contentsOf: "fmt ".utf8)
        append32(16)
        wav.append(contentsOf: [1, 0, 1, 0]); append32(24_000); append32(48_000)
        wav.append(contentsOf: [2, 0, 16, 0])
        wav.append(contentsOf: "data".utf8)
        append32(pcm.count)
        wav.append(pcm)
        guard let format = AVAudioFormat(standardFormatWithSampleRate: 24_000, channels: 1) else { throw MiniAudioFailure.playback }
        let engine = AVAudioEngine()
        try engine.enableManualRenderingMode(.offline, format: format, maximumFrameCount: AVAudioFrameCount(block))
        let player = MiniAudioPlayer(engine: engine)
        guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(block)) else { throw MiniAudioFailure.playback }
        func peak(_ gain: Double? = nil) throws -> Float {
            if let gain { player.setVolume(gain) }
            let frames = AVAudioFrameCount(block)
            guard try engine.renderOffline(frames, to: output) == .success, output.frameLength == frames,
                  let channel = output.floatChannelData?[0] else { throw MiniAudioFailure.playback }
            // Allow time for the native mixer's parameter ramp and limiter lookahead.
            return UnsafeBufferPointer(start: channel + block / 2, count: block / 2).map(abs).max() ?? 0
        }
        let started = try player.play(wav)
        expect(started, "A cached RIFF clip with metadata can play through the volume control")
        func near(_ value: Float, _ target: Float) -> Bool { abs(value - target) < 0.001 }
        expect(near(try peak(1), 0.125), "100 percent reproduces the source")
        expect(near(try peak(0.5), 0.0625), "Moving the slider attenuates the current clip")
        expect(near(try peak(2), 0.25), "A quiet clip measures twice as loud in amplitude at 200 percent")
        let limited = try peak(2)
        expect(limited > 0.6 && limited <= 1, "An amplified loud passage stays within digital full scale")
        expect(near(try peak(1), 0.94), "At unity even loud original recordings bypass the limiter")
        expect(try peak(0) == 0, "Zero is silent during playback")
        player.setVolume(1.5)
        player.stop()
        _ = try player.play(wav)
        expect(near(try peak(), 0.1875), "A later clip starts at the saved adjustment")
        player.stop()
    }

    private func windowDay(_ candidates: [MiniWord], groupTarget: Int, current: MiniWord?) -> MiniDailyDay {
        var ledger = MiniDailyLedger()
        let members = Array(candidates.prefix(5))
        var day = ledger.beginOrResume(deck: members)
        let visit = current.map {
            MiniMemoryWindow.Visit(id: UUID(), word: $0, stage: 0, openedAt: day.startedAt,
                                   initial: nil, selectedAt: nil, revealedAt: nil, correctedAt: nil, draft: "")
        }
        let window = MiniMemoryWindow(version: "interleaved-v2", size: 5, gap: 3,
                                      members: members.map { .init(word: $0, stage: 0, admittedAt: day.startedAt, lastVisit: nil) },
                                      visit: visit, events: [], sequence: 0, forceUnseen: false)
        day.flow = MiniLearningFlow(version: "sliding-window-v2", targetDate: day.id, dailyNewGoal: groupTarget,
                                    completedBeforeRun: 0, groupSize: groupTarget, candidates: candidates,
                                    candidateIndex: members.count, window: window, groupId: UUID(), groupIndex: 1,
                                    groupStartedAt: day.startedAt, groupTarget: groupTarget, groupWords: [],
                                    translationWords: [], groups: [], completed: [], goalReached: false)
        return day
    }

    private func testWindowPreparationWaitsForTheEntirePool() throws {
        let pool = Array(MiniWord.starter.prefix(8))
        let current = pool[1], reserve = pool[7], review = MiniWord.starter[8]
        let currentSentence = MiniStudySentence(word: current, english: "I have a book.", chinese: "我有一本书。")
        let reserveSentence = MiniStudySentence(word: reserve, english: "Open the door.", chinese: "打开门。")
        let reviewSentence = MiniStudySentence(word: review, english: "Take a chair.", chinese: "搬把椅子。")
        let day = windowDay(pool, groupTarget: 3, current: current)
        // A service snapshot may already contain sentences inherited from review.
        let encoder = JSONEncoder()
        guard var snapshot = try JSONSerialization.jsonObject(with: encoder.encode(day)) as? [String: Any] else {
            preconditionFailure("Expected an encoded daily snapshot")
        }
        snapshot["reviewWords"] = try JSONSerialization.jsonObject(with: encoder.encode([review]))
        snapshot["sentences"] = try JSONSerialization.jsonObject(with: encoder.encode([reviewSentence, reserveSentence]))
        var stored = try JSONDecoder().decode(MiniDailyDay.self, from: JSONSerialization.data(withJSONObject: snapshot))
        var states: [String: MiniAudioPreparationStatus] = [
            MiniAudioTarget.word(current).requestKey: .ready,
            MiniAudioTarget.word(pool[0]).requestKey: .ready,
            MiniAudioTarget.word(reserve).requestKey: .running,
            MiniAudioTarget.sentence(reserveSentence).requestKey: .failed,
        ]
        func preparation() -> MiniLessonPreparation {
            guard let result = MiniLessonPreparation(day: stored, preparingExamples: true, examplesFailed: false,
                                                     examplesError: nil, audioItem: { target in
                expect(pool.contains(target.word), "Review materials never count toward new-word preparation")
                return .init(target: target, status: states[target.requestKey] ?? .waiting)
            }) else { preconditionFailure("This window has a current card") }
            return result
        }
        let partial = preparation()
        expect(partial.groupTarget == 3 && stored.learningWords.count == 5, "The group target and admitted window differ from the eight-word pool")
        expect(partial.steps.map(\.id) == [.words, .examples, .wordAudio, .sentenceAudio], "Preparation reports four material types")
        expect(partial.steps.map(\.total) == [8, 8, 8, 8] && partial.steps.map(\.completed) == [8, 1, 2, 0],
               "Each row counts real materials in the entire pool, including reserve words")
        expect(partial.completedCount == 11 && partial.totalCount == 32, "The overall progress counts material items")
        expect(partial.steps.map(\.status) == [.complete, .running, .running, .failed], "Examples and word audio can run in parallel")
        expect(!partial.readyToStudy, "Partial materials cannot open the window")
        expect(stored.addSentences([currentSentence]), "Publish the current sentence")
        states[MiniAudioTarget.sentence(currentSentence).requestKey] = .ready
        expect(!preparation().readyToStudy, "A ready current card must wait for reserve materials")
        let rest = stored.wordsToPrepare.map {
            MiniStudySentence(word: $0, english: "I know \($0.spelling).", chinese: "我知道这个词。")
        }
        expect(stored.addSentences(rest), "Publish the rest of the batch")
        for word in pool { states[MiniAudioTarget.word(word).requestKey] = .ready }
        for sentence in stored.sentences { states[MiniAudioTarget.sentence(sentence).requestKey] = .ready }
        states[MiniAudioTarget.word(reserve).requestKey] = .failed
        expect(!preparation().readyToStudy && preparation().completedCount == 31, "One failed reserve recording blocks entry")
        states[MiniAudioTarget.word(reserve).requestKey] = .queued
        expect(!preparation().readyToStudy, "A queued retry is not a playable recording")
        states[MiniAudioTarget.word(reserve).requestKey] = .ready
        expect(preparation().readyToStudy && preparation().completedCount == 32, "The last accepted recording opens the batch")
        expect(stored.memoryWindow?.visit?.id == day.memoryWindow?.visit?.id, "Preparation keeps the learner's place")
    }

    private func testLegacyPreparationRequiresAllCards() {
        var ledger = MiniDailyLedger()
        var day = ledger.beginOrResume(deck: [apple, book])
        let first = MiniStudySentence(word: apple, english: "One apple.", chinese: "一个苹果。")
        let second = MiniStudySentence(word: book, english: "One book.", chinese: "一本书。")
        var secondAudio: MiniAudioPreparationStatus = .failed
        func preparation() -> MiniLessonPreparation {
            guard let result = MiniLessonPreparation(day: day, preparingExamples: false, examplesFailed: false,
                                                     examplesError: nil, audioItem: { target in
                .init(target: target, status: target == .word(book) ? secondAudio : .ready)
            }) else { preconditionFailure("Legacy days with learning words require materials") }
            return result
        }
        expect(day.addSentences([first]), "Publish the first legacy example")
        let partial = preparation()
        expect(partial.groupTarget == nil && partial.steps.map(\.total) == [2, 2, 2, 2],
               "Legacy preparation counts its learning words")
        expect(!partial.readyToStudy, "Legacy preparation waits for every required sentence")
        expect(day.addSentences([second]), "Publish the remaining legacy example")
        expect(!preparation().readyToStudy, "Legacy preparation waits for failed audio after both examples arrive")
        secondAudio = .ready
        expect(preparation().readyToStudy && preparation().completedCount == 8, "Legacy days open automatically when all eight materials are ready")
    }

    private func testSingletonPreparationAndWindowWithoutVisit() {
        func prepare(_ day: MiniDailyDay) -> MiniLessonPreparation? {
            MiniLessonPreparation(day: day, preparingExamples: false, examplesFailed: false, examplesError: nil) {
                .init(target: $0, status: .waiting)
            }
        }
        let singleton = prepare(windowDay([apple], groupTarget: 1, current: apple))
        expect(singleton?.steps.map(\.total) == [1, 1, 1, 1] && singleton?.completedCount == 1,
               "A genuine one-word pool has a denominator of one")
        expect(prepare(windowDay([apple, book], groupTarget: 1, current: nil)) == nil,
               "A window with no card to open never shows a preparation gate")
    }

    private func testCanonicalRequestsAndStartedRecovery() throws {
        let request = MiniAudioRequest(target: .word(apple))
        let input = try JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any]
        expect(input?["requestId"] as? String == request.requestId.uuidString.lowercased(), "Audio request UUIDs are canonical")
        let directory = try temporaryDirectory(); defer { try? FileManager.default.removeItem(at: directory) }
        let storage = MiniAudioRecovery(directory: directory)
        let value = MiniAudioPlaybackStart(requestId: UUID(), playbackId: UUID(), occurredAt: Date(timeIntervalSinceReferenceDate: 800_000_000.123))
        try storage.save([value])
        expect(try MiniAudioRecovery(directory: directory).load() == [value], "Unconfirmed actual starts keep identity and exact occurrence time")
        let context = MiniAudioContext.review(recordId: UUID())
        expect(try JSONDecoder().decode(MiniAudioContext.self, from: JSONEncoder().encode(context)) == context,
               "Standalone review playback preserves its record identity")
    }

    @MainActor
    private func testRecallPagesPlayOnlyTheirDisplayedContent() async throws {
        let sentence = MiniStudySentence(word: apple, english: "I see an apple.", chinese: "我看见一个苹果。")
        for sequence in [MiniAudioPresentation.Sequence.sentence, .word] {
            let (service, player, controller, directory) = try fixture()
            defer { try? FileManager.default.removeItem(at: directory) }
            let card = MiniAudioPresentation(id: "recall-\(sequence)", word: apple, context: nil,
                automatic: true, enabled: true, preview: false, automaticSentence: sentence, sequence: sequence)
            controller.update(card, visible: true, muted: false) { _ in }
            try await wait { player.plays == 1 && !controller.hasPendingReceipt }
            let expected: MiniAudioTarget = sequence == .sentence ? .sentence(sentence) : .word(apple)
            expect(await service.savedRequests().map(\.target) == [expected],
                   "Recall autoplay requests only the sentence or the word shown on the page")
            player.onFinish?(true)
            controller.update(card, visible: true, muted: false) { _ in }
            for _ in 0..<10 { await Task.yield() }
            expect(player.plays == 1, "Recall pages do not append hidden audio or replay on a same-visit refresh")
            controller.disconnect()
        }
    }

    @MainActor
    private func testOneAutomaticPlayPerVisit() async throws {
        let (service, player, controller, directory) = try fixture(); defer { try? FileManager.default.removeItem(at: directory) }
        let card = presentation("review:apple:0")
        controller.update(card, visible: true, muted: false) { _ in }
        try await wait { player.plays == 1 }
        let stops = player.stops
        controller.setVolume(1.6)
        expect(player.volume == 1.6 && player.stops == stops && player.plays == 1,
               "Changing volume reaches the current player without restarting or stopping the word")
        controller.update(card, visible: true, muted: false) { _ in }
        controller.update(card, visible: true, muted: false) { _ in }
        await Task.yield()
        expect(player.plays == 1, "An unchanged presentation never replays the same visit")
        controller.update(presentation("review:apple:1"), visible: true, muted: false) { _ in }
        try await wait { player.plays == 2 }
        expect(player.volume == 1.6, "The next card uses the current volume")
        controller.update(nil, visible: true, muted: false) { _ in }
        controller.update(presentation("review:apple:1"), visible: true, muted: false) { _ in }
        try await wait { player.plays == 3 }
        let authorizations = await service.savedAuthorizations()
        expect(Set(authorizations.map(\.visitId)).count == 3, "A repeat encounter and a real re-entry have new visit identities")
        controller.disconnect()
    }

    @MainActor
    private func testAutomaticWordThenSentenceWaitsForCompletion() async throws {
        let (service, player, controller, directory) = try fixture(); defer { try? FileManager.default.removeItem(at: directory) }
        let sentence = MiniStudySentence(word: apple, english: "I eat an apple.", chinese: "我吃一个苹果。")
        let card = presentation("new:apple:initial", sentence: sentence)
        controller.update(card, visible: true, muted: false) { _ in }
        try await wait { player.plays == 1 && !controller.hasPendingReceipt }
        expect(await service.counts().0 == 1 && controller.playingTarget == .word(apple),
               "The sentence waits until the word actually finishes")
        player.onFinish?(true)
        try await wait { player.plays == 2 && !controller.hasPendingReceipt }
        let requests = await service.savedRequests(), authorizations = await service.savedAuthorizations()
        expect(requests.map(\.target) == [.word(apple), .sentence(sentence)], "The sequence requests the word before its sentence")
        expect(authorizations.count == 2 && authorizations.allSatisfy { $0.mode == .automatic },
               "Each automatically played segment receives its own authorization")
        let starts = await service.counts().2
        expect(Set(authorizations.map(\.visitId)).count == 1 && starts == 2,
               "Both actual starts belong to one card visit and have separate saved receipts")
        player.onFinish?(true)
        controller.update(card, visible: true, muted: false) { _ in }
        await Task.yield()
        expect(controller.playingTarget == nil && player.plays == 2, "Completing and refreshing the sequence does not replay it")
        controller.disconnect()
    }

    @MainActor
    private func testAutomaticSentenceStartsAfterTheDefaultGap() async throws {
        let directory = try temporaryDirectory(); defer { try? FileManager.default.removeItem(at: directory) }
        let service = AudioTestService(), player = AudioTestPlayer()
        let controller = MiniAudioController(client: service, player: player, recovery: MiniAudioRecovery(directory: directory),
                                             pollNanoseconds: 1_000_000, maximumPolls: 100)
        defer { controller.disconnect() }
        let sentence = MiniStudySentence(word: apple, english: "I eat an apple.", chinese: "我吃一个苹果。")
        controller.update(presentation("default-gap", sentence: sentence), visible: true, muted: false) { _ in }
        try await wait { player.plays == 1 && !controller.hasPendingReceipt }
        var sentenceStartedAt: ContinuousClock.Instant?
        player.beforePlay = { sentenceStartedAt = ContinuousClock.now }
        let wordFinishedAt = ContinuousClock.now
        player.onFinish?(true)
        try await Task.sleep(for: .milliseconds(350))
        let startsDuringGap = await service.counts().2
        expect(player.plays == 1 && startsDuringGap == 1,
               "A prepared sentence cannot start during the half-second pause after the word finishes")
        try await wait { player.plays == 2 && !controller.hasPendingReceipt }
        guard let sentenceStartedAt else { preconditionFailure("Missing the actual sentence playback start") }
        expect(wordFinishedAt.duration(to: sentenceStartedAt) >= .milliseconds(500),
               "The default automatic sentence starts at least half a second after the actual word finish")
        expect(await service.savedRequests().map(\.target) == [.word(apple), .sentence(sentence)],
               "The delayed continuation still plays the same card's sentence exactly once")
    }

    @MainActor
    private func testCancellingDuringTheSentenceGapNeverStartsPlayback() async throws {
        let sentence = MiniStudySentence(word: apple, english: "I eat an apple.", chinese: "我吃一个苹果。")
        for reason in ["word", "hidden", "muted", "paused", "manual", "stopped", "disconnected"] {
            let (service, player, controller, directory) = try fixture(sentenceDelayNanoseconds: 80_000_000)
            defer { controller.disconnect(); try? FileManager.default.removeItem(at: directory) }
            let card = presentation("gap-" + reason, sentence: sentence)
            controller.update(card, visible: true, muted: false) { _ in }
            try await wait { player.plays == 1 && !controller.hasPendingReceipt }
            player.onFinish?(true)
            try await Task.sleep(for: .milliseconds(10))
            let startsDuringGap = await service.counts().2
            expect(player.plays == 1 && startsDuringGap == 1,
                   "The word has finished and its automatic sentence is still waiting")
            switch reason {
            case "word":
                let next = MiniAudioPresentation(id: "gap-next", word: book, context: nil,
                                                 automatic: false, enabled: true, preview: false)
                controller.update(next, visible: true, muted: false) { _ in }
            case "manual":
                controller.play(.word(apple))
                try await wait { player.plays == 2 && !controller.hasPendingReceipt }
                player.onFinish?(true)
            case "stopped":
                controller.stop()
                controller.update(card, visible: true, muted: false) { _ in }
            case "disconnected":
                controller.disconnect()
            default:
                controller.update(presentation("gap-" + reason, enabled: reason != "paused", sentence: sentence),
                                  visible: reason != "hidden", muted: reason == "muted") { _ in }
                controller.update(card, visible: true, muted: false) { _ in }
            }
            try await Task.sleep(for: .milliseconds(120))
            let expectedStarts = reason == "manual" ? 2 : 1
            let actualStarts = await service.counts().2
            expect(player.plays == expectedStarts && actualStarts == expectedStarts,
                   "Cancelling the waiting sentence by \(reason) prevents a late actual playback or start receipt")
            let authorizations = await service.savedAuthorizations()
            expect(authorizations.filter { $0.mode == .manual }.count == (reason == "manual" ? 1 : 0),
                   "Only an explicit manual replay creates a manual playback authorization")
        }
    }

    @MainActor
    private func testRevealCreatesASequenceWithANewVisit() async throws {
        let (service, player, controller, directory) = try fixture(); defer { try? FileManager.default.removeItem(at: directory) }
        let sentence = MiniStudySentence(word: apple, english: "I eat an apple.", chinese: "我吃一个苹果。")
        controller.update(presentation("review:apple:closed"), visible: true, muted: false) { _ in }
        try await wait { player.plays == 1 }
        let closedFinish = player.onFinish
        let expanded = presentation("review:apple:revealed", sentence: sentence)
        controller.update(expanded, visible: true, muted: false) { _ in }
        try await wait { player.plays == 2 }
        closedFinish?(true)
        await Task.yield()
        expect(await service.counts().0 == 2, "A finish callback from the collapsed card cannot advance the revealed card")
        player.onFinish?(true)
        try await wait { player.plays == 3 }
        controller.update(expanded, visible: true, muted: false) { _ in }
        await Task.yield()
        let authorizations = await service.savedAuthorizations()
        expect(Set(authorizations.map(\.visitId)).count == 2 && authorizations.count == 3,
               "Revealing the card creates one fresh word-and-sentence visit")
        controller.disconnect()
    }

    @MainActor
    private func testManualReplayCancelsRemainingAutomaticAudio() async throws {
        let (service, player, controller, directory) = try fixture(); defer { try? FileManager.default.removeItem(at: directory) }
        let sentence = MiniStudySentence(word: apple, english: "I eat an apple.", chinese: "我吃一个苹果。")
        controller.update(presentation("new:apple", sentence: sentence), visible: true, muted: false) { _ in }
        try await wait { player.plays == 1 }
        let automaticFinish = player.onFinish
        controller.play(.sentence(sentence))
        try await wait { player.plays == 2 }
        automaticFinish?(true)
        player.onFinish?(true)
        await Task.yield()
        let authorizations = await service.savedAuthorizations()
        expect(authorizations.map(\.mode) == [.automatic, .manual] && player.plays == 2,
               "Explicit replay replaces the automatic sequence without a later duplicate sentence")
        controller.disconnect()
    }

    @MainActor
    private func testChangingWordsCancelsPendingSequencePlayback() async throws {
        let (service, player, controller, directory) = try fixture(); defer { try? FileManager.default.removeItem(at: directory) }
        let sentence = MiniStudySentence(word: apple, english: "I eat an apple.", chinese: "我吃一个苹果。")
        let next = MiniAudioPresentation(id: "next:book", word: book, context: nil, automatic: false, enabled: true, preview: false)
        controller.update(presentation("old:apple", sentence: sentence), visible: true, muted: false) { _ in }
        try await wait { player.plays == 1 }
        let finish = player.onFinish
        controller.update(next, visible: true, muted: false) { _ in }
        finish?(true)
        await Task.yield()
        expect(await service.counts().0 == 1 && player.plays == 1,
               "Leaving a word cancels its pending automatic sentence")
        controller.update(presentation("return:apple", sentence: sentence), visible: true, muted: false) { _ in }
        try await wait { player.plays == 2 }
        await service.setAuthorizationsDelayed(true)
        player.onFinish?(true)
        try await wait { await service.counts().1 == 3 }
        controller.update(next, visible: true, muted: false) { _ in }
        await service.releaseAuthorizations()
        for _ in 0..<10 { await Task.yield() }
        expect(player.plays == 2 && controller.playingTarget == nil,
               "A sentence authorization that returns after changing words never starts playback")
        controller.disconnect()
    }

    @MainActor
    private func testUnavailableCardsCancelTheAutomaticSequence() async throws {
        let sentence = MiniStudySentence(word: apple, english: "I eat an apple.", chinese: "我吃一个苹果。")
        for reason in ["hidden", "muted", "paused"] {
            let (service, player, controller, directory) = try fixture(); defer { try? FileManager.default.removeItem(at: directory) }
            let card = presentation(reason, sentence: sentence)
            controller.update(card, visible: true, muted: false) { _ in }
            try await wait { player.plays == 1 }
            let finish = player.onFinish
            controller.update(presentation(reason, enabled: reason != "paused", sentence: sentence),
                              visible: reason != "hidden", muted: reason == "muted") { _ in }
            controller.update(card, visible: true, muted: false) { _ in }
            finish?(true)
            for _ in 0..<10 { await Task.yield() }
            expect(await service.counts().0 == 1 && player.plays == 1,
                   "A cancelled \(reason) sequence never resumes its remaining sentence")
            controller.disconnect()
        }
    }

    @MainActor
    private func testAutomaticSequenceFailuresStayVisible() async throws {
        let (service, player, controller, directory) = try fixture(); defer { try? FileManager.default.removeItem(at: directory) }
        let sentence = MiniStudySentence(word: apple, english: "I eat an apple.", chinese: "我吃一个苹果。")
        controller.update(presentation("decode-failure", sentence: sentence), visible: true, muted: false) { _ in }
        try await wait { player.plays == 1 }
        player.onFinish?(false)
        expect(controller.notice == MiniAudioFailure.playback.localizedDescription && controller.playingTarget == nil,
               "A decoder failure is visible and stops the automatic sequence")
        expect(await service.counts().0 == 1, "An unsuccessful word finish cannot start the sentence")
        let missing = presentation("missing-sentence", sentence: sentence)
        controller.update(missing, visible: true, muted: false) { _ in }
        try await wait { player.plays == 2 }
        await service.setFailures(requests: 1)
        player.onFinish?(true)
        try await wait { controller.notice != nil && controller.busyTarget == nil }
        controller.update(missing, visible: true, muted: false) { _ in }
        for _ in 0..<10 { await Task.yield() }
        expect(await service.counts().0 == 3 && player.plays == 2,
               "An unavailable sentence leaves a visible failure and waits for an explicit replay")
        controller.disconnect()
    }

    @MainActor
    private func testStalePlaybackAuthorization() async throws {
        let (service, player, controller, directory) = try fixture()
        defer { controller.disconnect(); try? FileManager.default.removeItem(at: directory) }
        let sentence = MiniStudySentence(word: apple, english: "I eat an apple.", chinese: "我吃一个苹果。")
        await service.setAuthorizationError(.staleAudio)
        controller.update(presentation("changed-card", sentence: sentence), visible: true, muted: false) { _ in
            preconditionFailure("A declined authorization cannot refresh learning facts")
        }
        try await wait { await service.counts().1 == 1 && controller.busyTarget == nil }
        expect(controller.notice == nil && !controller.authorizing && controller.playingTarget == nil,
               "A late automatic authorization clears playback state silently")
        player.onFinish?(true)
        expect(controller.busyTarget == nil && player.plays == 0,
               "A declined automatic word cannot start its queued sentence")
        controller.play(.word(apple))
        try await wait { controller.notice != nil }
        expect(controller.notice == MiniStudyClientError.staleAudio.localizedDescription && player.plays == 0,
               "A manual replay keeps the authorization explanation")
        expect(await service.counts().2 == 0, "A declined playback never records a start")
    }

    @MainActor
    private func testPreviewSequencePreservesLearningRecovery() async throws {
        let (service, player, controller, directory) = try fixture(); defer { try? FileManager.default.removeItem(at: directory) }
        let recoveryFile = directory.appending(path: "audio-started-outbox.json")
        let original = Data("unreadable real playback recovery".utf8)
        try original.write(to: recoveryFile)
        let sentence = MiniStudySentence(word: apple, english: "I eat an apple.", chinese: "我吃一个苹果。")
        controller.update(presentation("preview-sequence", preview: true, sentence: sentence), visible: true, muted: false) { _ in
            preconditionFailure("Preview sequence cannot refresh real learning facts")
        }
        try await wait { player.plays == 1 }
        player.onFinish?(true)
        try await wait { player.plays == 2 }
        let counts = await service.counts()
        expect(counts.0 == 2 && counts.1 == 0 && counts.2 == 0, "Both preview segments play without real learning receipts")
        expect(try Data(contentsOf: recoveryFile) == original, "Preview playback preserves the pending real recovery file")
        controller.disconnect()
    }

    @MainActor
    private func testLateGenerationNeverPlaysAfterLeaving() async throws {
        let (service, player, controller, directory) = try fixture(); defer { try? FileManager.default.removeItem(at: directory) }
        await service.setDelayed(true)
        controller.update(presentation("old"), visible: true, muted: false) { _ in }
        try await wait { await service.counts().0 == 1 }
        controller.update(MiniAudioPresentation(id: "new", word: book, context: nil, automatic: false, enabled: true, preview: false),
                          visible: true, muted: false) { _ in }
        await service.releaseRequests()
        for _ in 0..<10 { await Task.yield() }
        expect(player.plays == 0, "A delayed result for a previous card never starts playback")
        expect(await service.counts().1 == 0, "A stale result does not even authorize playback")
        controller.disconnect()
    }

    @MainActor
    private func testPauseHideAndMuteNeverReplayTheSameVisit() async throws {
        let (service, player, controller, directory) = try fixture(); defer { try? FileManager.default.removeItem(at: directory) }
        let card = presentation("same")
        controller.update(card, visible: true, muted: false) { _ in }
        try await wait { player.plays == 1 }
        controller.update(presentation("same", enabled: false), visible: true, muted: false) { _ in }
        controller.update(card, visible: true, muted: false) { _ in }
        controller.update(card, visible: false, muted: false) { _ in }
        controller.update(card, visible: true, muted: false) { _ in }
        controller.update(card, visible: true, muted: true) { _ in }
        controller.update(card, visible: true, muted: false) { _ in }
        for _ in 0..<10 { await Task.yield() }
        expect(player.plays == 1, "Pause/resume, hide/show and mute/unmute do not create another visit")
        controller.play(.word(apple))
        try await wait { player.plays == 2 }
        expect(await service.counts().1 == 2, "An explicit replay remains available on the same visit")
        controller.disconnect()
    }

    @MainActor
    private func testSpellingIsManualAndAuthorizationPrecedesPlayback() async throws {
        let (service, player, controller, directory) = try fixture(); defer { try? FileManager.default.removeItem(at: directory) }
        var refreshed = false
        player.beforePlay = { self.expect(refreshed, "The learning revision is refreshed before sound starts") }
        controller.update(presentation("spelling", automatic: false), visible: true, muted: false) { revision in
            self.expect(revision == 7 && controller.authorizing, "Playback authorization locks study submission until refresh")
            refreshed = true
        }
        await Task.yield()
        expect(await service.counts().0 == 0, "Spelling never automatically requests answer audio")
        controller.play(.word(apple))
        try await wait { player.plays == 1 }
        let saved = await service.savedAuthorizations()
        expect(saved.first?.mode == .manual && saved.first?.context == .daily(dayId: "day", session: .learning),
               "Manual spelling audio retains its real learning target for help accounting")
        try await wait { await service.counts().2 == 1 }
        controller.disconnect()
    }

    @MainActor
    private func testAutomaticAdvancePronouncesTheSavedResult() async throws {
        let (service, player, controller, directory) = try fixture()
        defer { try? FileManager.default.removeItem(at: directory) }
        controller.update(presentation("next-spelling", automatic: false), visible: true, muted: false) { _ in }
        controller.play(.word(book), automatic: true)
        let submitted = UUID()
        controller.playSpellingResult(book, submissionId: submitted)
        try await wait {
            let counts = await service.counts()
            return player.plays == 1 && counts.2 == 1
        }
        let saved = await service.savedAuthorizations()
        expect(saved.count == 1 && saved[0].mode == .automatic && saved[0].context == nil &&
               saved[0].spellingSubmissionId == submitted && controller.playingTarget == .word(book),
               "Playback authorizes the saved answer identity independently of the next visible word")

        controller.update(nil, visible: true, muted: true) { _ in }
        controller.playSpellingResult(book, submissionId: UUID())
        await Task.yield()
        expect((await service.counts()).0 == 1, "Muted results do not request audio")
        controller.update(nil, visible: true, muted: false) { _ in }
        controller.playSpellingResult(apple, submissionId: UUID())
        try await wait { player.plays == 2 }
        try await wait { (await service.counts()).2 == 2 }
        controller.disconnect()
    }

    @MainActor
    private func testPreviewAuditionsWithoutLearningOrRecovery() async throws {
        let (service, player, controller, directory) = try fixture(); defer { try? FileManager.default.removeItem(at: directory) }
        let recoveryFile = directory.appending(path: "audio-started-outbox.json")
        let original = Data("damaged recovery file".utf8)
        try original.write(to: recoveryFile)
        let card = presentation("preview", preview: true)
        controller.update(card, visible: true, muted: false) { _ in preconditionFailure("No preview learning refresh") }
        try await wait { player.plays == 1 }
        controller.update(card, visible: true, muted: false) { _ in preconditionFailure("No preview learning refresh") }
        controller.play(.word(apple))
        try await wait { player.plays == 2 }
        let sentence = MiniStudySentence(word: apple, english: "I eat an apple.", chinese: "我吃一个苹果。")
        controller.play(.sentence(sentence))
        try await wait { player.plays == 3 }
        controller.regenerate(.sentence(sentence), voice: "serena")
        try await wait { controller.notice == "音频已重新生成，可以重播试听。" }
        let regenerated = await service.savedRequests().last
        expect(regenerated?.operation == .regenerate && regenerated?.voice == "serena" && regenerated?.target == .sentence(sentence),
               "Preview uses the shared regeneration request with the selected target and voice")
        expect(player.plays == 3, "Regeneration prepares an asset and waits for an explicit replay")
        controller.prefetch([.word(book)], scope: "preview:day")
        try await wait { await service.counts().0 == 5 }
        controller.update(card, visible: true, muted: true) { _ in preconditionFailure("No preview learning refresh") }
        controller.play(.word(apple))
        expect(player.plays == 3 && controller.playingTarget == nil, "Preview mute stops playback and blocks manual sound")
        controller.update(card, visible: true, muted: false) { _ in preconditionFailure("No preview learning refresh") }
        controller.play(.word(apple))
        try await wait { player.plays == 4 }
        controller.stop()
        let previewCounts = await service.counts()
        expect(previewCounts.1 == 0 && previewCounts.2 == 0 && !controller.hasPendingReceipt && controller.playingTarget == nil,
               "Preview asset generation and playback never authorize, report learning starts or create a pending start")
        expect(try Data(contentsOf: recoveryFile) == original, "Preview audition works while leaving a damaged real outbox untouched")
        controller.disconnect()
        controller.update(presentation("normal", automatic: false), visible: true, muted: false) { _ in }
        controller.play(.word(apple))
        for _ in 0..<10 { await Task.yield() }
        expect(await service.counts().0 == previewCounts.0 && player.plays == 4,
               "A damaged actual-start outbox blocks new audio without overwriting original recovery data")
        expect(try Data(contentsOf: recoveryFile) == original, "Normal mode also preserves the damaged original for recovery")
        controller.disconnect()
    }

    @MainActor
    private func testSameIDModeChangesInvalidateGeneration() async throws {
        let (service, player, controller, directory) = try fixture(); defer { try? FileManager.default.removeItem(at: directory) }
        await service.setDelayed(true)
        controller.update(presentation("shared"), visible: true, muted: false) { _ in preconditionFailure("Stale normal refresh") }
        try await wait { await service.counts().0 == 1 }
        controller.update(presentation("shared", automatic: false, preview: true), visible: true, muted: false) { _ in
            preconditionFailure("No preview learning refresh")
        }
        await service.releaseRequests()
        try await Task.sleep(for: .milliseconds(20))
        let normalCounts = await service.counts()
        expect(player.plays == 0 && normalCounts.1 == 0, "Normal generation cannot play or authorize after same-ID preview entry")
        controller.play(.word(apple))
        try await wait { await service.counts().0 == 2 }
        controller.update(presentation("shared", automatic: false), visible: true, muted: false) { _ in }
        await service.releaseRequests()
        try await Task.sleep(for: .milliseconds(20))
        let previewCounts = await service.counts()
        expect(player.plays == 0 && previewCounts.1 == 0, "Preview generation cannot play after same-ID normal entry")
        await service.setDelayed(false)
        controller.update(presentation("shared", preview: true), visible: true, muted: false) { _ in preconditionFailure("No preview learning refresh") }
        try await wait { player.plays == 1 }
        expect(!FileManager.default.fileExists(atPath: directory.appending(path: "audio-started-outbox.json").path),
               "A fresh preview never creates a persistent started outbox")
        controller.disconnect()
    }

    @MainActor
    private func testLateAuthorizationCannotRefreshPreview() async throws {
        let (service, player, controller, directory) = try fixture(); defer { try? FileManager.default.removeItem(at: directory) }
        await service.setAuthorizationsDelayed(true)
        var refreshes = 0
        controller.update(presentation("shared"), visible: true, muted: false) { _ in refreshes += 1 }
        try await wait { await service.counts().1 == 1 }
        controller.update(presentation("shared", automatic: false, preview: true), visible: true, muted: false) { _ in refreshes += 1 }
        await service.releaseAuthorizations()
        try await Task.sleep(for: .milliseconds(20))
        let lateCounts = await service.counts()
        expect(refreshes == 0 && player.plays == 0 && lateCounts.2 == 0,
               "A late normal authorization cannot refresh, play or report a start in preview")
        controller.play(.word(apple))
        try await wait { player.plays == 1 }
        let counts = await service.counts()
        expect(counts.1 == 1 && counts.2 == 0 && refreshes == 0, "The next preview audition bypasses the learning receipt path")
        controller.disconnect()
    }

    @MainActor
    private func testFailedActualStartAndReceiptRecovery() async throws {
        let (service, player, controller, directory) = try fixture(); defer { try? FileManager.default.removeItem(at: directory) }
        player.canPlay = false
        controller.update(presentation("failure", automatic: false), visible: true, muted: false) { _ in }
        controller.play(.word(apple))
        try await wait { controller.notice != nil }
        expect(await service.counts().2 == 0, "A player that did not start never submits a started receipt")
        player.canPlay = true
        await service.setFailures(starts: 1)
        controller.play(.word(apple))
        try await wait { await service.counts().2 == 1 && !controller.hasPendingReceipt }
        expect(controller.notice == nil, "A failed background receipt does not add saving feedback to the card")
        controller.disconnect()
        let resumed = MiniAudioController(client: service, player: AudioTestPlayer(), recovery: MiniAudioRecovery(directory: directory), pollNanoseconds: 1_000_000)
        resumed.update(presentation("restored", automatic: false), visible: true, muted: false) { _ in }
        for _ in 0..<10 { await Task.yield() }
        expect(await service.counts().2 == 1 && !resumed.hasPendingReceipt,
               "An exhausted background receipt is not retried again when reopening")
        expect(try MiniAudioRecovery(directory: directory).load().isEmpty,
               "The exhausted receipt leaves the background outbox")
        resumed.disconnect()
    }

    @MainActor
    private func testPrefetchAndFailuresDoNotLoop() async throws {
        let (service, _, controller, directory) = try fixture(); defer { try? FileManager.default.removeItem(at: directory) }
        await service.setFailures(requests: 1)
        let card = presentation("failed")
        controller.update(card, visible: true, muted: false) { _ in }
        try await wait { controller.notice != nil }
        controller.update(card, visible: true, muted: false) { _ in }
        for _ in 0..<10 { await Task.yield() }
        expect(await service.counts().0 == 1, "An automatic failure never loops and blocks the card")
        controller.prefetch([.word(book)], scope: "normal:day")
        controller.prefetch([.word(book)], scope: "normal:day")
        try await wait { await service.counts().0 == 2 }
        expect(await service.counts().1 == 0, "Prefetching creates assets without playback or learning exposure")
        controller.disconnect()
    }

    @MainActor
    private func testPreviewStopsPendingReceiptDrain() async throws {
        let (service, player, controller, directory) = try fixture(); defer { try? FileManager.default.removeItem(at: directory) }
        await service.setStartsDelayed(true)
        controller.update(presentation("actual", automatic: false), visible: true, muted: false) { _ in }
        controller.play(.word(apple))
        try await wait { await service.counts().2 == 1 }
        controller.play(.word(apple))
        try await wait { player.plays == 2 }
        expect(try MiniAudioRecovery(directory: directory).load().count == 2, "Both actual starts are durable before acknowledgements arrive")
        controller.disconnect()
        controller.update(presentation("preview", automatic: false, preview: true), visible: true, muted: false) { _ in }
        await service.releaseStarts()
        for _ in 0..<20 { await Task.yield() }
        expect(await service.counts().2 == 1, "Entering preview cannot drain another real playback acknowledgement")
        let remaining = try MiniAudioRecovery(directory: directory).load()
        expect(remaining.count == 1, "An already in-flight acknowledgement may settle; the next actual start remains in the outbox")
        controller.play(.word(apple))
        try await wait { player.plays == 3 }
        expect(try MiniAudioRecovery(directory: directory).load() == remaining, "Preview audition preserves the exact pending real start")
        let previewCounts = await service.counts()
        expect(previewCounts.1 == 2 && previewCounts.2 == 1, "Preview audition never adds a learning authorization or resumes the real receipt queue")
        let resumed = MiniAudioController(client: service, player: AudioTestPlayer(), recovery: MiniAudioRecovery(directory: directory))
        resumed.recover(preview: false)
        try await wait { !resumed.hasPendingReceipt }
        let starts = await service.savedStarts()
        expect(starts.count == 2 && starts.last == remaining.first, "Returning to normal mode resumes the exact remaining start once")
        resumed.disconnect(); controller.disconnect()
    }

    @MainActor
    private func testPreparationUsesRealJobsAndIndependentEnqueue() async throws {
        let directory = try temporaryDirectory(); defer { try? FileManager.default.removeItem(at: directory) }
        let service = PreparationTestService()
        let controller = MiniAudioController(client: service, player: AudioTestPlayer(), recovery: MiniAudioRecovery(directory: directory),
                                             pollNanoseconds: 1_000_000)
        let word = MiniAudioTarget.word(apple), cachedWord = MiniAudioTarget.word(book)
        let sentence = MiniAudioTarget.sentence(MiniStudySentence(word: apple, english: "I eat an apple.", chinese: "我吃一个苹果。"))
        await service.delay(word)
        await service.cache(cachedWord)
        await service.cache(sentence, historicalOnly: true)
        let targets = [word, cachedWord, sentence]
        controller.prefetch(targets + [word], scope: "normal:day")
        try await wait {
            let progress = controller.preparationProgress(for: targets, scope: "normal:day")
            return progress.items[0].status == .requesting && progress.items[1].status == .ready && progress.items[2].status == .queued
        }
        let initial = controller.preparationProgress(for: targets + [word], scope: "normal:day")
        expect(initial.total == 3 && initial.ready == 1 && initial.inProgress == 2 && initial.failed == 0,
               "Preparation counts unique requested targets and accepts only the authoritative ensure cache hit")
        expect(initial.items[2].asset == nil && initial.items[2].job != nil,
               "Historical snapshot audio cannot mark a different current-profile job ready")
        controller.prefetch(targets, scope: "normal:day")
        expect(await service.count(sentence) == 1, "A queued target is not re-enqueued on state refresh")
        await service.advance(sentence, to: .running)
        try await wait { controller.preparationItems[sentence.requestKey]?.status == .running }
        await service.advance(sentence, to: .completed)
        try await wait { controller.preparationProgress(for: targets).ready == 2 }
        await service.release(word)
        try await wait { controller.preparationItems[word.requestKey]?.status == .queued }
        await service.advance(word, to: .completed)
        try await wait { controller.preparationProgress(for: targets).isReady }
        let complete = controller.preparationProgress(for: targets)
        expect(complete.items.allSatisfy { $0.asset != nil } && complete.ready == 3,
               "Completion requires each actual completed job's committed asset")
        controller.disconnect()
    }

    @MainActor
    private func testPreparationRetriesOnlyFailedTargets() async throws {
        let directory = try temporaryDirectory(); defer { try? FileManager.default.removeItem(at: directory) }
        let service = PreparationTestService()
        let controller = MiniAudioController(client: service, player: AudioTestPlayer(), recovery: MiniAudioRecovery(directory: directory),
                                             pollNanoseconds: 1_000_000, preparationRetryDelay: .milliseconds(40))
        let cachedWord = MiniAudioTarget.word(apple), missingWord = MiniAudioTarget.word(book)
        let sentence = MiniAudioTarget.sentence(MiniStudySentence(word: apple, english: "I eat an apple.", chinese: "我吃一个苹果。"))
        let targets = [cachedWord, missingWord, sentence]
        await service.cache(cachedWord)
        await service.loseNextResponse(missingWord)
        controller.prefetch(targets, scope: "normal:day")
        try await wait { controller.preparationItems[sentence.requestKey]?.status == .queued }
        await service.advance(sentence, to: .failed, error: "Controlled synthesis failure")
        try await wait { controller.preparationItems[sentence.requestKey]?.status == .retrying }
        expect(controller.preparationProgress(for: targets).inProgress == 2, "Active retry delays keep the materials in progress")
        controller.retryPreparation(targets, scope: "normal:day") // Cannot double-dispatch pending retries.
        try await wait {
            controller.preparationItems[missingWord.requestKey]?.status == .queued
                && controller.preparationItems[sentence.requestKey]?.status == .queued
        }
        let cachedCount = await service.count(cachedWord)
        let missingIDs = await service.requestIDs(missingWord), sentenceIDs = await service.requestIDs(sentence)
        expect(cachedCount == 1 && missingIDs.count == 2 && Set(missingIDs).count == 1,
               "A lost response retries the original ensure identity without touching cached audio")
        expect(sentenceIDs.count == 2 && Set(sentenceIDs).count == 2,
               "A confirmed synthesis failure automatically starts a fresh ensure, even without clicking retry")
        await service.advance(missingWord, to: .completed)
        await service.advance(sentence, to: .completed)
        try await wait { controller.preparationProgress(for: targets).isReady }
        controller.disconnect()
    }

    @MainActor
    private func testPreparationExhaustionAndManualRetry() async throws {
        let service = PreparationTestService(), word = MiniAudioTarget.word(book)
        let controller = MiniAudioController(client: service, player: AudioTestPlayer(), pollNanoseconds: 1_000_000,
                                             preparationRetryDelay: .milliseconds(3))
        defer { controller.disconnect() }
        controller.prefetch([word], scope: "lesson")
        for n in 1...4 {
            try await wait {
                await service.count(word) == n && controller.preparationItems[word.requestKey]?.status == .queued
            }
            await service.advance(word, to: n == 2 ? .interrupted : .failed, error: "Failed audio inspection")
        }
        try await wait { controller.preparationItems[word.requestKey]?.status == .failed }
        controller.prefetch([word], scope: "lesson")
        try await Task.sleep(for: .milliseconds(45))
        let ids = await service.requestIDs(word)
        expect(ids.count == 4 && Set(ids).count == 4 && controller.preparationItems[word.requestKey]?.error == "Failed audio inspection",
               "Three automatic retries exhaust the budget and keep the final reason across refreshes")
        controller.retryPreparation([word], scope: "lesson")
        expect(controller.preparationItems[word.requestKey]?.status == .requesting, "Manual retry immediately changes the failed row")
        controller.retryPreparation([word], scope: "lesson")
        try await wait { controller.preparationItems[word.requestKey]?.status == .queued }
        await service.advance(word, to: .completed)
        try await wait { controller.preparationProgress(for: [word]).isReady }
        expect(await service.count(word) == 5, "A double-click after exhausted retries enqueues one new attempt")
    }

    @MainActor
    private func testLeavingDuringPreparationRetry() async throws {
        let service = PreparationTestService(), previous = MiniAudioTarget.word(book), next = MiniAudioTarget.word(apple)
        let controller = MiniAudioController(client: service, player: AudioTestPlayer(), pollNanoseconds: 1_000_000,
                                             preparationRetryDelay: .milliseconds(50))
        defer { controller.disconnect() }
        await service.cache(next)
        controller.prefetch([previous], scope: "previous")
        try await wait { controller.preparationItems[previous.requestKey]?.status == .queued }
        await service.advance(previous, to: .interrupted)
        try await wait { controller.preparationItems[previous.requestKey]?.status == .retrying }
        controller.prefetch([next], scope: "next")
        try await wait { controller.preparationProgress(for: [next]).isReady }
        try await Task.sleep(for: .milliseconds(80))
        expect(await service.count(previous) == 1 && controller.preparationItems[previous.requestKey] == nil,
               "Switching lessons during backoff cancels every pending old retry")
    }

    @MainActor
    private func testPreparationScopeAndReconnection() async throws {
        let directory = try temporaryDirectory(); defer { try? FileManager.default.removeItem(at: directory) }
        let service = PreparationTestService()
        let controller = MiniAudioController(client: service, player: AudioTestPlayer(), recovery: MiniAudioRecovery(directory: directory),
                                             pollNanoseconds: 1_000_000)
        let oldWord = MiniAudioTarget.word(apple), nextWord = MiniAudioTarget.word(book)
        await service.delay(oldWord)
        await service.cache(nextWord)
        controller.prefetch([oldWord], scope: "normal:old")
        try await wait { await service.count(oldWord) == 1 }
        controller.prefetch([nextWord], scope: "preview:next")
        try await wait { controller.preparationProgress(for: [nextWord], scope: "preview:next").isReady }
        await service.release(oldWord)
        try await Task.sleep(for: .milliseconds(10))
        expect(controller.preparationItems.count == 1 && controller.preparationItems[oldWord.requestKey] == nil,
               "A late previous-group result cannot populate the current group")
        expect(controller.preparationProgress(for: [nextWord], scope: "normal:old").ready == 0,
               "Progress for a mismatched group scope stays waiting")
        controller.prefetch([oldWord], scope: "normal:old")
        try await wait { controller.preparationItems[oldWord.requestKey]?.status == .queued }
        let originalJob = controller.preparationItems[oldWord.requestKey]?.job?.id
        controller.disconnect()
        let resumed = MiniAudioController(client: service, player: AudioTestPlayer(), recovery: MiniAudioRecovery(directory: directory),
                                         pollNanoseconds: 1_000_000)
        resumed.prefetch([oldWord], scope: "normal:old")
        try await wait { resumed.preparationItems[oldWord.requestKey]?.status == .queued }
        expect(resumed.preparationItems[oldWord.requestKey]?.job?.id == originalJob,
               "Reconnection observes the original service job instead of inventing local completion")
        await service.advance(oldWord, to: .completed)
        try await wait { resumed.preparationProgress(for: [oldWord]).isReady }
        resumed.disconnect()
    }

    @MainActor
    private func testCardPlaybackEnqueuesBeforeBackgroundPreparation() async throws {
        let (service, player, controller, directory) = try fixture(); defer { try? FileManager.default.removeItem(at: directory) }
        await service.setDelayed(true)
        controller.update(presentation("current"), visible: true, muted: false) { _ in }
        try await wait { await service.counts().0 == 1 }
        controller.prefetch([.word(book)], scope: "normal:day")
        try await Task.sleep(for: .milliseconds(10))
        expect(await service.counts().0 == 1 && controller.preparationItems[MiniAudioTarget.word(book).requestKey]?.status == .waiting,
               "A foreground card's immediate audio request enters before background targets")
        expect(controller.preparationProgress(for: [.word(book)]).inProgress == 0,
               "Waiting for foreground playback never appears as an active background request")
        await service.setDelayed(false)
        await service.releaseRequests()
        try await wait { player.plays == 1 && controller.preparationProgress(for: [.word(book)]).isReady }
        expect(await service.counts().1 == 1, "Background readiness creates no extra playback authorization")
        controller.disconnect()
    }

    @MainActor
    private func fixture(sentenceDelayNanoseconds: UInt64 = 0) throws -> (AudioTestService, AudioTestPlayer, MiniAudioController, URL) {
        let directory = try temporaryDirectory()
        let service = AudioTestService(), player = AudioTestPlayer()
        let controller = MiniAudioController(client: service, player: player, recovery: MiniAudioRecovery(directory: directory),
                                             pollNanoseconds: 1_000_000, maximumPolls: 100,
                                             sentenceDelayNanoseconds: sentenceDelayNanoseconds)
        return (service, player, controller, directory)
    }

    private func presentation(_ id: String, automatic: Bool = true, enabled: Bool = true, preview: Bool = false,
                              sentence: MiniStudySentence? = nil) -> MiniAudioPresentation {
        MiniAudioPresentation(id: id, word: apple, context: .daily(dayId: "day", session: .learning),
                              automatic: automatic, enabled: enabled, preview: preview, automaticSentence: sentence)
    }

    @MainActor
    private func wait(_ predicate: () async -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(3)
        while !(await predicate()), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(5)) }
        expect(await predicate(), "The controlled audio operation must settle within its bounded deadline")
    }

    @MainActor
    private func testHTTPAudio(baseURL: URL, tokenFile: URL) async throws {
        let directory = try temporaryDirectory(); defer { try? FileManager.default.removeItem(at: directory) }
        let study = MiniStudyClient(baseURL: baseURL, tokenFile: tokenFile, legacyDirectory: directory)
        let client = MiniAudioClient(study: study)
        var state = try await study.importLegacy(study.prepareLegacyImport())
        func perform(_ action: MiniStudyAction) async throws -> MiniStudySnapshot {
            do { return try await study.perform(MiniStudyCommand(expectedRevision: state.revision, action: action)) }
            catch {
                let actual = try? await study.snapshot()
                let message = "Audio integration command \(action.type.rawValue) failed at expected revision \(state.revision), actual \(actual?.revision.description ?? "unavailable"): \(error)\n"
                FileHandle.standardError.write(Data(message.utf8))
                throw error
            }
        }
        var begin = MiniStudyAction(type: .begin, target: .daily)
        begin.deck = [apple]; begin.timezone = TimeZone.current.identifier
        state = try await perform(begin)
        guard let dayId = state.planning.activeDayId else { preconditionFailure("Missing audio integration group") }
        var material = MiniStudyAction(type: .addSentences, target: .daily, dayId: dayId)
        let sentence = MiniStudySentence(word: apple, english: "I eat an apple.", chinese: "我吃一个苹果。")
        material.sentences = [sentence]
        state = try await perform(material)
        let revisionBeforeAudio = state.revision
        let playbackCount = try await client.snapshot().playbacks.count
        let player = AudioTestPlayer()
        let controller = MiniAudioController(client: client, player: player, recovery: MiniAudioRecovery(directory: directory),
                                             pollNanoseconds: 20_000_000)
        defer { controller.disconnect() }
        let targets: [MiniAudioTarget] = [.word(apple), .sentence(sentence)]
        let scope = "normal:" + dayId
        controller.prefetch(targets, scope: scope)
        try await wait { controller.preparationProgress(for: targets, scope: scope).isReady }
        let prepared = controller.preparationProgress(for: targets, scope: scope)
        expect(prepared.total == 2 && prepared.ready == 2 && prepared.items.allSatisfy { $0.asset != nil },
               "Native preparation observes both committed HTTP word and sentence assets")
        expect(try await study.snapshot().revision == revisionBeforeAudio && player.plays == 0,
               "HTTP background preparation completes without changing learning facts or starting playback")
        expect(try await client.snapshot().playbacks.count == playbackCount,
               "HTTP preparation creates no authorized or started playback receipts")
        let original = try await ready(client, request: MiniAudioRequest(target: .word(apple)))
        let reused = try await client.request(MiniAudioRequest(target: .word(apple)))
        expect(reused.asset?.id == original.id && reused.reused, "The same word reuses its committed asset and voice")
        let originalBytes = try await client.file(original.id)
        expect(try await study.snapshot().revision == revisionBeforeAudio, "Generating and reading audio never creates learning facts")
        let card = MiniAudioPresentation(id: "http:" + dayId + ":initial", word: apple,
                                         context: .daily(dayId: dayId, session: .learning), automatic: true,
                                         enabled: true, preview: false, automaticSentence: sentence)
        controller.update(card, visible: true, muted: false) { _ in _ = try await study.snapshot() }
        try await wait { player.plays == 1 && !controller.hasPendingReceipt }
        expect(try await client.snapshot().playbacks.count == playbackCount + 1,
               "HTTP autoplay starts only the word until its actual completion callback")
        player.onFinish?(true)
        try await wait { player.plays == 2 && !controller.hasPendingReceipt }
        let sequenceReceipts = Array(try await client.snapshot().playbacks.dropFirst(playbackCount))
        expect(sequenceReceipts.count == 2 && sequenceReceipts.allSatisfy { $0.status == .started }
               && Set(sequenceReceipts.map(\.visitId)).count == 1,
               "Word and sentence obtain distinct actual-start receipts within one HTTP card visit")
        player.onFinish?(true)
        let visit = UUID()
        let authorization = try await client.authorize(MiniAudioPlaybackRequest(requestId: UUID(), assetId: original.id,
            visitId: visit, mode: .automatic, context: .daily(dayId: dayId, session: .learning)))
        expect(authorization.status == .authorized && authorization.startedAt == nil, "Authorization never claims actual playback")
        let start = MiniAudioPlaybackStart(requestId: UUID(), playbackId: authorization.id, occurredAt: .now)
        let started = try await client.started(start)
        expect(started.status == .started && started.startedAt != nil, "The controlled playback start obtains a distinct receipt")
        expect(try await client.started(start).id == started.id, "Uncertain start acknowledgements replay the original identity")
        state = try await study.snapshot()
        var marked = MiniStudyAction(type: .markStudied, target: .daily, dayId: dayId, word: apple)
        marked.remainOnCard = true
        state = try await perform(marked)
        expect(state.ledger.days.last?.retainedLearningWord == apple, "The marked card remains selected in authoritative state")
        let spellingCount = state.ledger.days.last?.learning?.spellingAttempts.count
        state = try await perform(MiniStudyAction(type: .openDictation, target: .daily, dayId: dayId, session: .learning, word: apple))
        guard let practice = state.practice?.activeDictation else { preconditionFailure("Missing single-card practice") }
        var practiceAction = MiniStudyAction(type: .submitDictation, target: .daily, dayId: dayId, session: .learning)
        practiceAction.dictationId = practice.id
        practiceAction.answer = ""
        state = try await perform(practiceAction)
        expect(state.practice?.activeDictation?.attempts.last?.answer == "" && state.practice?.activeDictation?.revealedAt != nil,
               "An unanswered single-card practice saves the blank input and reveals the reference without a group score")
        practiceAction.answer = "  APPLE  "
        state = try await perform(practiceAction)
        expect(state.practice?.activeDictation?.attempts.last?.answer == "  APPLE  " && state.practice?.activeDictation?.attempts.last?.correct == true,
               "Single-card practice preserves the exact original input and the service's objective comparison")
        expect(state.ledger.days.last?.learning?.spellingAttempts.count == spellingCount,
               "Extra practice never counts as a whole-group spelling answer")
        practiceAction = MiniStudyAction(type: .revealDictation, target: .daily, dayId: dayId, session: .learning)
        practiceAction.dictationId = practice.id
        state = try await perform(practiceAction)
        expect(state.practice?.activeDictation?.revealedAt != nil, "Single-card answer reveal is an actual saved fact")
        practiceAction = MiniStudyAction(type: .closeDictation, target: .daily, dayId: dayId, session: .learning)
        practiceAction.dictationId = practice.id
        state = try await perform(practiceAction)
        state = try await perform(MiniStudyAction(type: .unmarkStudied, target: .daily, dayId: dayId, word: apple))
        expect(state.ledger.days.last?.retainedLearningWord == nil && state.practice?.activeDictation == nil,
               "Undoing a study mark closes the optional practice")
        state = try await perform(marked)
        state = try await perform(MiniStudyAction(type: .advanceLearningCard, target: .daily, dayId: dayId, word: apple))
        let manual = try await client.authorize(MiniAudioPlaybackRequest(requestId: UUID(), assetId: original.id,
            visitId: UUID(), mode: .manual, context: .daily(dayId: dayId, session: .learning)))
        _ = try await client.started(MiniAudioPlaybackStart(requestId: UUID(), playbackId: manual.id, occurredAt: .now))
        state = try await study.snapshot()
        var spelling = MiniStudyAction(type: .submitSpelling, target: .daily, dayId: dayId, session: .learning, word: apple)
        spelling.advanceOnCorrect = false
        let playsBeforeSpelling = player.plays
        for (index, answer) in ["aple", apple.spelling].enumerated() {
            spelling.answer = answer
            state = try await perform(spelling)
            let savedAttempts = state.ledger.days.first { $0.id == dayId }?.learning?.spellingAttempts
            let resultCard = MiniAudioPresentation(id: "http-spelling:\(index)", word: apple,
                context: .daily(dayId: dayId, session: .learning), automatic: false,
                enabled: true, preview: false, sequence: .word)
            controller.update(resultCard, visible: true, muted: false) { _ in _ = try await study.snapshot() }
            controller.play(.word(apple), automatic: true)
            try await wait { player.plays == playsBeforeSpelling + index + 1 && !controller.hasPendingReceipt }
            controller.update(resultCard, visible: true, muted: false) { _ in _ = try await study.snapshot() }
            state = try await study.snapshot()
            expect(state.ledger.days.first { $0.id == dayId }?.learning?.spellingAttempts == savedAttempts,
                   "Automatic result pronunciation preserves each original spelling answer and help condition")
            player.onFinish?(true)
        }
        expect(player.plays == playsBeforeSpelling + 2,
               "Wrong and correct spelling results each play the cached word once through real HTTP")
        expect(state.ledger.days.first { $0.id == dayId }?.learning?.spellingAttempts.last?.lastPotentialHelpAt != nil,
               "Hearing the spelling answer is preserved as help before the subsequent submitted answer")
        state = try await perform(MiniStudyAction(type: .beginProbe, target: .daily, word: apple))
        guard let probe = state.scheduling?.activeProbe else { preconditionFailure("Missing independent probe") }
        var probeAction = MiniStudyAction(type: .submitProbe, target: .daily)
        probeAction.probeId = probe.id
        probeAction.answer = "  apple  "
        state = try await perform(probeAction)
        let measured = state.scheduling?.activeProbe
        expect(measured?.answer == "  apple  " && measured?.classification == .tooSoon && measured?.rating == nil,
               "A just-exposed word keeps its raw probe answer and cannot manufacture a FSRS Good")
        probeAction = MiniStudyAction(type: .endProbe, target: .daily)
        probeAction.probeId = probe.id
        state = try await perform(probeAction)
        expect(state.scheduling?.activeProbe == nil && state.scheduling?.probes.last?.answer == "  apple  ",
               "Ending the probe preserves its original submitted answer")
        let regenerated = try await ready(client, request: MiniAudioRequest(target: .word(apple), operation: .regenerate, voice: "aiden"))
        expect(regenerated.id != original.id && regenerated.voice == "aiden", "Explicit regeneration switches to a separately committed version")
        expect(try await client.file(original.id) == originalBytes, "Regeneration never overwrites the original immutable audio file")
    }

    private func ready(_ client: MiniAudioClient, request: MiniAudioRequest) async throws -> MiniAudioAsset {
        let result = try await client.request(request)
        if request.operation == .ensure, let asset = result.asset { return asset }
        guard var job = result.job else { preconditionFailure("Missing audio task") }
        let deadline = ContinuousClock.now + .seconds(10)
        while job.status.isActive, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(20))
            job = try await client.job(job.id)
        }
        guard job.status == .completed, let id = job.assetId,
              let asset = try await client.snapshot().assets.first(where: { $0.id == id }) else {
            preconditionFailure("The isolated audio runtime did not save a valid asset")
        }
        return asset
    }

    private func expect(_ value: Bool, _ message: String) { precondition(value, message) }
    private func temporaryDirectory() throws -> URL {
        let directory = URL.temporaryDirectory.appending(path: "lingoweave-audio-client-" + UUID().uuidString.lowercased())
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }
}
