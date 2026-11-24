import AVFoundation
import Combine

@MainActor
final class MiniPatternVoice: ObservableObject {
    private let synthesizer = AVSpeechSynthesizer()
    private let player = MiniAudioPlayer()
    private var rendering: Task<Void, Never>?
    @Published private(set) var error: String?

    func read(_ english: String) {
        stop()
        error = nil
        rendering = Task {
            do {
                let buffer = try await Self.render(english, with: synthesizer)
                try Task.checkCancellation()
                guard try player.play(buffer) else { throw MiniAudioFailure.playback }
            } catch {
                if !Task.isCancelled { self.error = "句式朗读暂时不可用。" }
            }
        }
    }

    func setVolume(_ volume: Double) { player.setVolume(volume) }

    func stop() {
        rendering?.cancel()
        rendering = nil
        synthesizer.stopSpeaking(at: .immediate)
        player.stop()
    }

    // System voices deliver short reusable buffers. Copy their samples before the callback returns.
    static func render(_ english: String, with synthesizer: AVSpeechSynthesizer) async throws -> AVAudioPCMBuffer {
        try Task.checkCancellation()
        let utterance = AVSpeechUtterance(string: english)
        utterance.voice = AVSpeechSynthesisVoice(language: "en-US")
        let (stream, output) = AsyncThrowingStream<(Double, [Float]), Error>.makeStream()
        synthesizer.write(utterance) { @Sendable audio in
            guard let pcm = audio as? AVAudioPCMBuffer else { output.finish(throwing: MiniAudioFailure.playback); return }
            guard pcm.frameLength > 0 else { output.finish(); return }
            do {
                let mono = try floatMono(pcm)
                guard let channel = mono.floatChannelData?[0] else { throw MiniAudioFailure.playback }
                output.yield((mono.format.sampleRate, Array(UnsafeBufferPointer(start: channel, count: Int(mono.frameLength)))))
            } catch { output.finish(throwing: error) }
        }
        var rate: Double?
        var samples: [Float] = []
        for try await (sampleRate, chunk) in stream {
            guard rate == nil || rate == sampleRate else { throw MiniAudioFailure.playback }
            rate = sampleRate
            samples.append(contentsOf: chunk)
        }
        try Task.checkCancellation()
        guard let rate, let count = AVAudioFrameCount(exactly: samples.count), count > 0,
              let format = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 1),
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: count),
              let channel = buffer.floatChannelData?[0] else { throw MiniAudioFailure.playback }
        buffer.frameLength = count
        channel.update(from: samples, count: samples.count)
        return buffer
    }

    private nonisolated static func floatMono(_ source: AVAudioPCMBuffer) throws -> AVAudioPCMBuffer {
        if source.format.channelCount == 1, source.format.commonFormat == .pcmFormatFloat32 { return source }
        guard let format = AVAudioFormat(standardFormatWithSampleRate: source.format.sampleRate, channels: 1),
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: source.frameLength),
              let converter = AVAudioConverter(from: source.format, to: format) else { throw MiniAudioFailure.playback }
        try converter.convert(to: buffer, from: source)
        return buffer
    }
}
