import AVFoundation
import Combine
import Foundation

extension Notification.Name {
    static let miniWindowVisibilityChanged = Notification.Name("lingoweave.mini.window-visibility-changed")
}

struct MiniAudioPresentation: Equatable, Sendable {
    enum Sequence: Sendable { case word, sentence, wordThenSentence }
    let id: String
    let word: MiniWord
    let context: MiniAudioContext?
    let automatic: Bool
    let enabled: Bool
    let preview: Bool
    let automaticSentence: MiniStudySentence?
    let sequence: Sequence

    init(id: String, word: MiniWord, context: MiniAudioContext?, automatic: Bool,
         enabled: Bool, preview: Bool, automaticSentence: MiniStudySentence? = nil,
         sequence: Sequence = .wordThenSentence) {
        self.id = id
        self.word = word
        self.context = context
        self.automatic = automatic
        self.enabled = enabled
        self.preview = preview
        self.automaticSentence = automaticSentence
        self.sequence = sequence
    }

    var automaticTargets: [MiniAudioTarget] {
        let sentence = automaticSentence.map { MiniAudioTarget.sentence($0) }
        switch sequence {
        case .word: return [.word(word)]
        case .sentence: return sentence.map { [$0] } ?? []
        case .wordThenSentence: return [.word(word)] + (sentence.map { [$0] } ?? [])
        }
    }
}

enum MiniAudioPreparationStatus: Sendable {
    case waiting, requesting, queued, running, ready, failed
}

struct MiniAudioPreparationItem: Identifiable, Sendable {
    let target: MiniAudioTarget
    var status: MiniAudioPreparationStatus
    var job: MiniAudioJob?
    var asset: MiniAudioAsset?
    var error: String?
    var id: String { target.requestKey }
}

struct MiniAudioPreparationProgress: Sendable {
    let items: [MiniAudioPreparationItem]
    var total: Int { items.count }
    var ready: Int { items.filter { $0.status == .ready }.count }
    var failed: Int { items.filter { $0.status == .failed }.count }
    var inProgress: Int { items.filter { $0.status == .requesting || $0.status == .queued || $0.status == .running }.count }
    var isReady: Bool { ready == total }
    var error: String? { items.first { $0.error != nil }?.error }
}

@MainActor
protocol MiniAudioPlaying: AnyObject {
    var onFinish: ((Bool) -> Void)? { get set }
    func play(_ data: Data) throws -> Bool
    func stop()
}

@MainActor
final class MiniAudioPlayer: NSObject, MiniAudioPlaying, @preconcurrency AVAudioPlayerDelegate {
    var onFinish: ((Bool) -> Void)?
    private var player: AVAudioPlayer?

    func play(_ data: Data) throws -> Bool {
        stop()
        let next = try AVAudioPlayer(data: data)
        next.delegate = self
        next.prepareToPlay()
        player = next
        return next.play()
    }

    func stop() { player?.stop(); player = nil }
    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        guard self.player === player else { return }
        self.player = nil
        onFinish?(flag)
    }
    func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: (any Error)?) {
        guard self.player === player else { return }
        self.player = nil
        onFinish?(false)
    }
}

enum MiniAudioFailure: LocalizedError {
    case interrupted, notReady, playback
    var errorDescription: String? {
        switch self {
        case .interrupted: "这条音频尚未生成成功，可以重播或重新生成。"
        case .notReady: "这条音频等待较久，生成任务仍保留，可稍后重播。"
        case .playback: "音频暂时无法播放，可以重新生成这一条。"
        }
    }
}

/// Controls a card visit and playback only. Assets and learning facts stay on the service.
@MainActor
final class MiniAudioController: ObservableObject {
    @Published private(set) var busyTarget: MiniAudioTarget?
    @Published private(set) var playingTarget: MiniAudioTarget?
    @Published private(set) var notice: String?
    @Published private(set) var hasPendingReceipt = false
    @Published private(set) var authorizing = false
    @Published private(set) var preparationScope: String?
    @Published private(set) var preparationItems: [String: MiniAudioPreparationItem] = [:]
    private let client: any MiniAudioServing
    private let player: any MiniAudioPlaying
    private let recovery: MiniAudioRecovery
    private let pollNanoseconds: UInt64
    private let maximumPolls: Int
    private let sentenceDelayNanoseconds: UInt64
    private var presentation: MiniAudioPresentation?
    private var visitId = UUID()
    private var autoAttempted = false
    private var visible = true
    private var muted = false
    private var operation = UUID()
    private var automaticNextTarget: MiniAudioTarget?
    private var task: Task<Void, Never>?
    private var receiptTask: Task<Void, Never>?
    private var receiptToken = UUID()
    private var prefetchToken = UUID()
    private var preparationTasks: [String: Task<Void, Never>] = [:]
    private var pendingStarts: [MiniAudioPlaybackStart] = []
    private var recoveryLoaded = false
    private var recoveryAllowed = false
    private var refresh: ((Int?) async throws -> Void)?

    init(client: any MiniAudioServing = MiniAudioClient(), player: (any MiniAudioPlaying)? = nil,
         recovery: MiniAudioRecovery = MiniAudioRecovery(), pollNanoseconds: UInt64 = 400_000_000,
         maximumPolls: Int = 900, sentenceDelayNanoseconds: UInt64 = 500_000_000) {
        self.client = client
        self.player = player ?? MiniAudioPlayer()
        self.recovery = recovery
        self.pollNanoseconds = pollNanoseconds
        self.maximumPolls = maximumPolls
        self.sentenceDelayNanoseconds = sentenceDelayNanoseconds
    }

    func update(_ next: MiniAudioPresentation?, visible: Bool, muted: Bool,
                refresh: @escaping (Int?) async throws -> Void) {
        self.refresh = refresh
        let identityChanged = presentation?.id != next?.id || presentation?.preview != next?.preview
        let becameUnavailable = !visible || muted || next?.enabled != true
        if identityChanged || becameUnavailable { stop() }
        self.visible = visible
        self.muted = muted
        self.presentation = next
        if identityChanged {
            visitId = UUID()
            autoAttempted = false
            notice = nil
        }
        guard let next else { return }
        if next.preview {
            pauseReceiptDrain()
        } else {
            recoveryAllowed = true
            loadRecoveryIfNeeded()
            retryReceipts()
        }
        // A hidden, muted or paused visit must not be replayed later on resume.
        guard !autoAttempted, next.automatic else { return }
        autoAttempted = true
        guard visible, !muted, next.enabled else { return }
        let targets = next.automaticTargets
        guard let first = targets.first else { return }
        play(first, automatic: true, followedBy: targets.dropFirst().first)
    }

    func prefetch(_ targets: [MiniAudioTarget], scope: String) {
        if preparationScope != scope {
            cancelPreparation()
            preparationScope = scope
        }
        for target in targets where preparationItems[target.requestKey] == nil {
            startPreparation(target)
        }
    }

    func preparationProgress(for targets: [MiniAudioTarget], scope: String? = nil) -> MiniAudioPreparationProgress {
        var seen = Set<String>()
        let items = targets.filter { seen.insert($0.requestKey).inserted }.map { target in
            if scope == nil || preparationScope == scope, let item = preparationItems[target.requestKey] { return item }
            return MiniAudioPreparationItem(target: target, status: .waiting)
        }
        return MiniAudioPreparationProgress(items: items)
    }

    func retryPreparation(_ targets: [MiniAudioTarget], scope: String) {
        prefetch(targets, scope: scope)
        for target in targets {
            guard let item = preparationItems[target.requestKey],
                  item.status == .failed || item.status == .waiting,
                  preparationTasks[target.requestKey] == nil else { continue }
            startPreparation(target)
        }
    }

    private func startPreparation(_ target: MiniAudioTarget) {
        let key = target.requestKey, token = prefetchToken
        preparationItems[key] = MiniAudioPreparationItem(target: target, status: .waiting)
        preparationTasks[key] = Task { [weak self] in
            guard let self else { return }
            defer { if prefetchToken == token { preparationTasks[key] = nil } }
            do {
                // A card's immediate playback request gets to enter the service queue first.
                // Each remaining target then enqueues independently of long-running jobs.
                while busyTarget != nil {
                    try Task.checkCancellation()
                    try await Task.sleep(nanoseconds: pollNanoseconds)
                }
                try checkPreparation(token)
                preparationItems[key]?.status = .requesting
                let result = try await client.request(MiniAudioRequest(target: target))
                try checkPreparation(token)
                if let asset = result.asset {
                    preparationItems[key] = MiniAudioPreparationItem(target: target, status: .ready, asset: asset)
                    return
                }
                guard var job = result.job else { throw MiniAudioFailure.interrupted }
                while true {
                    try checkPreparation(token)
                    preparationItems[key]?.job = job
                    switch job.status {
                    case .queued: preparationItems[key]?.status = .queued
                    case .running: preparationItems[key]?.status = .running
                    case .completed:
                        guard let assetId = job.assetId else { throw MiniStudyClientError.invalidResponse }
                        let snapshot = try await client.snapshot()
                        try checkPreparation(token)
                        guard let asset = snapshot.assets.first(where: { $0.id == assetId }) else {
                            throw MiniStudyClientError.invalidResponse
                        }
                        preparationItems[key] = MiniAudioPreparationItem(target: target, status: .ready, job: job, asset: asset)
                        return
                    case .failed, .interrupted:
                        throw MiniStudyClientError.service(job.error ?? "音频生成中断，可以重试缺少的音频。")
                    }
                    try await Task.sleep(nanoseconds: pollNanoseconds)
                    job = try await client.job(job.id)
                }
            } catch is CancellationError { return }
            catch {
                guard prefetchToken == token, !Task.isCancelled else { return }
                preparationItems[key]?.status = .failed
                preparationItems[key]?.error = error.localizedDescription
            }
        }
    }

    private func checkPreparation(_ token: UUID) throws {
        guard !Task.isCancelled, prefetchToken == token else { throw CancellationError() }
    }

    private func cancelPreparation() {
        prefetchToken = UUID()
        for task in preparationTasks.values { task.cancel() }
        preparationTasks = [:]
        preparationItems = [:]
        preparationScope = nil
    }

    func play(_ target: MiniAudioTarget, automatic: Bool = false) {
        play(target, automatic: automatic, followedBy: nil)
    }

    private func play(_ target: MiniAudioTarget, automatic: Bool, followedBy: MiniAudioTarget?,
                      notBefore: ContinuousClock.Instant? = nil) {
        guard let card = presentation else { return }
        guard visible, card.enabled else { return }
        guard !muted else { notice = "已静音，打开声音后可以重播。"; return }
        guard target.word == card.word else { return }
        if !card.preview {
            loadRecoveryIfNeeded()
            guard recoveryLoaded else { return }
        }
        stop()
        let token = operation, visit = visitId
        if automatic, followedBy?.word == card.word { automaticNextTarget = followedBy }
        player.onFinish = { [weak self] successful in
            self?.finishedPlayback(token: token, visit: visit, preview: card.preview, successful: successful)
        }
        busyTarget = target
        notice = nil
        task = Task { [weak self] in
            guard let self else { return }
            defer { if operation == token { authorizing = false } }
            do {
                let asset = try await readyAsset(target, regenerate: false)
                try ensureCurrent(token, visit: visit, preview: card.preview)
                let bytes = try await client.file(asset.id)
                try ensureCurrent(token, visit: visit, preview: card.preview)
                var authorization: MiniAudioPlaybackReceipt?
                if !card.preview {
                    authorizing = true
                    authorization = try await client.authorize(MiniAudioPlaybackRequest(
                        requestId: UUID(), assetId: asset.id, visitId: visit,
                        mode: automatic ? .automatic : .manual, context: card.context))
                    try ensureCurrent(token, visit: visit, preview: false)
                    // Refresh a committed support fact before accepting further study commands.
                    try await refresh?(authorization?.learningRevision)
                    try ensureCurrent(token, visit: visit, preview: false)
                    authorizing = false
                }
                if let notBefore { try await ContinuousClock().sleep(until: notBefore) }
                try ensureCurrent(token, visit: visit, preview: card.preview)
                guard try player.play(bytes) else { throw MiniAudioFailure.playback }
                playingTarget = target
                busyTarget = nil
                guard let authorization else { return }
                let started = MiniAudioPlaybackStart(requestId: UUID(), playbackId: authorization.id, occurredAt: .now)
                pendingStarts.append(started)
                hasPendingReceipt = true
                do { try recovery.save(pendingStarts) }
                catch {
                    player.stop(); playingTarget = nil
                    automaticNextTarget = nil
                }
                retryReceipts()
            } catch is CancellationError {
                return
            } catch {
                guard operation == token else { return }
                busyTarget = nil
                playingTarget = nil
                automaticNextTarget = nil
                notice = error.localizedDescription
            }
        }
    }

    private func finishedPlayback(token: UUID, visit: UUID, preview: Bool, successful: Bool) {
        guard operation == token, visitId == visit, presentation?.preview == preview else { return }
        playingTarget = nil
        guard successful else {
            automaticNextTarget = nil
            notice = MiniAudioFailure.playback.localizedDescription
            return
        }
        guard let next = automaticNextTarget else { return }
        automaticNextTarget = nil
        guard visible, !muted, presentation?.enabled == true else { return }
        let notBefore = ContinuousClock().now.advanced(by: .nanoseconds(Int64(clamping: sentenceDelayNanoseconds)))
        play(next, automatic: true, followedBy: nil, notBefore: notBefore)
    }

    func regenerate(_ target: MiniAudioTarget, voice: String? = nil) {
        guard let card = presentation else { return }
        guard visible, card.enabled, target.word == card.word else { return }
        stop()
        let token = operation
        busyTarget = target
        notice = nil
        task = Task { [weak self] in
            guard let self else { return }
            do {
                _ = try await readyAsset(target, regenerate: true, voice: voice)
                guard operation == token else { return }
                busyTarget = nil
                notice = "音频已重新生成，可以重播试听。"
            } catch is CancellationError { return }
            catch {
                guard operation == token else { return }
                busyTarget = nil
                notice = error.localizedDescription
            }
        }
    }

    func stop() {
        operation = UUID()
        automaticNextTarget = nil
        task?.cancel(); task = nil
        player.onFinish = nil
        player.stop()
        busyTarget = nil
        playingTarget = nil
        authorizing = false
    }

    func disconnect() {
        stop()
        presentation = nil
        pauseReceiptDrain()
        cancelPreparation()
    }

    private func pauseReceiptDrain() {
        recoveryAllowed = false
        receiptToken = UUID()
        receiptTask?.cancel(); receiptTask = nil
    }

    func recover(preview: Bool) {
        guard !preview else { return }
        recoveryAllowed = true
        loadRecoveryIfNeeded()
        retryReceipts()
    }

    func retryReceipts() {
        guard recoveryAllowed, receiptTask == nil else { return }
        loadRecoveryIfNeeded()
        guard recoveryLoaded else { return }
        guard !pendingStarts.isEmpty else { return }
        let token = UUID()
        receiptToken = token
        receiptTask = Task { [weak self] in
            guard let self else { return }
            defer { if receiptToken == token { receiptTask = nil } }
            while let first = pendingStarts.first {
                guard !Task.isCancelled, recoveryAllowed else { return }
                do {
                    _ = try await client.started(first)
                    let remaining = pendingStarts.filter { $0.requestId != first.requestId }
                    try recovery.save(remaining)
                    pendingStarts = remaining
                    hasPendingReceipt = !remaining.isEmpty
                } catch {
                    if Task.isCancelled { return }
                    pendingStarts.removeAll { $0.requestId == first.requestId }
                    hasPendingReceipt = !pendingStarts.isEmpty
                    try? recovery.save(pendingStarts)
                }
            }
        }
    }

    private func loadRecoveryIfNeeded() {
        guard !recoveryLoaded else { return }
        do {
            pendingStarts = try recovery.load()
            hasPendingReceipt = !pendingStarts.isEmpty
            recoveryLoaded = true
        } catch {}
    }

    private func ensureCurrent(_ token: UUID, visit: UUID, preview: Bool) throws {
        guard !Task.isCancelled, operation == token, visitId == visit, visible, !muted,
              presentation?.enabled == true, presentation?.preview == preview else { throw CancellationError() }
    }

    private func readyAsset(_ target: MiniAudioTarget, regenerate: Bool, voice: String? = nil) async throws -> MiniAudioAsset {
        let result = try await client.request(MiniAudioRequest(target: target,
            operation: regenerate ? .regenerate : .ensure, voice: voice))
        if !regenerate, let asset = result.asset { return asset }
        guard var job = result.job else {
            if let asset = result.asset { return asset }
            throw MiniAudioFailure.interrupted
        }
        for _ in 0..<maximumPolls {
            try Task.checkCancellation()
            if job.status == .completed, let id = job.assetId {
                let snapshot = try await client.snapshot()
                guard let asset = snapshot.assets.first(where: { $0.id == id }) else { throw MiniStudyClientError.invalidResponse }
                return asset
            }
            if !job.status.isActive { throw MiniStudyClientError.service(job.error ?? "音频生成中断，可以重新生成这一条。") }
            try await Task.sleep(nanoseconds: pollNanoseconds)
            job = try await client.job(job.id)
        }
        throw MiniAudioFailure.notReady
    }
}
