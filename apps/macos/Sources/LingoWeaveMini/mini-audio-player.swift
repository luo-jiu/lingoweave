import AVFoundation

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

@MainActor
protocol MiniAudioPlaying: AnyObject {
    var onFinish: ((Bool) -> Void)? { get set }
    func setVolume(_ volume: Double)
    func play(_ data: Data) throws -> Bool
    func stop()
}

@MainActor
final class MiniAudioPlayer: MiniAudioPlaying {
    var onFinish: ((Bool) -> Void)?
    private var level: Double = 1
    private var generation: UUID?
    private let engine: AVAudioEngine
    private let node = AVAudioPlayerNode()
    private let limiter = AVAudioUnitEffect(audioComponentDescription: AudioComponentDescription(
        componentType: kAudioUnitType_Effect, componentSubType: kAudioUnitSubType_PeakLimiter,
        componentManufacturer: kAudioUnitManufacturer_Apple, componentFlags: 0, componentFlagsMask: 0
    ))
    private var format: AVAudioFormat?

    init(engine: AVAudioEngine = AVAudioEngine()) {
        self.engine = engine
        engine.attach(node)
        engine.attach(limiter)
    }

    func setVolume(_ volume: Double) {
        level = volume.isFinite ? min(2, max(0, volume)) : 1
        guard format != nil else { return }
        applyVolume()
    }

    private func applyVolume() {
        node.volume = Float(min(level, 1))
        limiter.bypass = level <= 1
        // The limiter provides positive gain and controls peaks before output mixing.
        AudioUnitSetParameter(limiter.audioUnit, kLimiterParam_PreGain, kAudioUnitScope_Global, 0,
                              Float(20 * log10(max(1, level))), 0)
    }

    func play(_ data: Data) throws -> Bool {
        try play(Self.decodeWordOrSentence(data))
    }

    func play(_ buffer: AVAudioPCMBuffer) throws -> Bool {
        guard buffer.frameLength > 0, buffer.format.isStandard else { throw MiniAudioFailure.playback }
        stop()
        if format != buffer.format {
            engine.connect(node, to: limiter, format: buffer.format)
            engine.connect(limiter, to: engine.mainMixerNode, format: buffer.format)
            format = buffer.format
        }
        engine.prepare()
        try engine.start()
        applyVolume()
        let id = UUID()
        generation = id
        node.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.generation == id else { return }
                self.stop()
                self.onFinish?(true)
            }
        }
        node.play()
        return true
    }

    func stop() {
        generation = nil
        if format != nil { node.stop() }
        if engine.isRunning { engine.stop() }
    }

    // The service validates 24 kHz, mono, signed 16-bit PCM. WAV metadata chunks and
    // padding may occur between fmt and data, so the first sample need not be byte 44.
    private static func decodeWordOrSentence(_ data: Data) throws -> AVAudioPCMBuffer {
        try data.withUnsafeBytes { raw in
            func u32(_ offset: Int) -> UInt32 { UInt32(littleEndian: raw.loadUnaligned(fromByteOffset: offset, as: UInt32.self)) }
            func u16(_ offset: Int) -> UInt16 { UInt16(littleEndian: raw.loadUnaligned(fromByteOffset: offset, as: UInt16.self)) }
            guard raw.count >= 44, raw.count <= 20 * 1024 * 1024, u32(0) == 0x46464952,
                  Int(u32(4)) == raw.count - 8, u32(8) == 0x45564157 else { throw MiniAudioFailure.playback }
            var position = 12, samples: Range<Int>?, validFormat = false
            while position + 8 <= raw.count {
                let id = u32(position), start = position + 8, size = Int(u32(position + 4))
                guard size <= raw.count - start else { throw MiniAudioFailure.playback }
                switch id {
                case 0x20746d66: // fmt
                    validFormat = size >= 16 && u16(start) == 1 && u16(start + 2) == 1 && u32(start + 4) == 24_000
                        && u16(start + 12) == 2 && u16(start + 14) == 16
                case 0x61746164: // data
                    samples = start..<(start + size)
                default: break
                }
                position = start + size + size % 2
            }
            guard validFormat, let samples, !samples.isEmpty, samples.count.isMultiple(of: 2),
                  let format = AVAudioFormat(standardFormatWithSampleRate: 24_000, channels: 1),
                  let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count / 2)),
                  let channel = buffer.floatChannelData?[0] else { throw MiniAudioFailure.playback }
            buffer.frameLength = buffer.frameCapacity
            for index in 0..<Int(buffer.frameLength) {
                channel[index] = Float(Int16(bitPattern: u16(samples.lowerBound + 2 * index))) / 32768
            }
            return buffer
        }
    }
}
