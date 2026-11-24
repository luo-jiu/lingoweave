import SwiftUI

struct MiniVolumeControl: View {
    @Binding var volume: Double
    @Binding var muted: Bool
    @State private var expanded = false
    @State private var volumeBeforeDrag: Double?

    private var level: Double { muted ? 0 : min(max(volume.isFinite ? volume : 1, 0), 2) }
    private var percentage: String { "\(Int((level * 100).rounded()))%" }
    private var symbol: String {
        if level == 0 { return "speaker.slash.fill" }
        if level <= 0.5 { return "speaker.wave.1" }
        return level <= 1 ? "speaker.wave.2" : "speaker.wave.3"
    }

    var body: some View {
        Button { expanded.toggle() } label: {
            Image(systemName: symbol).frame(width: 20, height: 24)
        }
        .accessibilityLabel("朗读音量").accessibilityValue(percentage)
        .help("调节朗读音量")
        .popover(isPresented: $expanded, arrowEdge: .bottom) {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text("朗读音量").font(.headline)
                    Spacer()
                    Text(verbatim: percentage).monospacedDigit().foregroundStyle(.secondary)
                }
                HStack(spacing: 8) {
                    Button {
                        if level == 0 {
                            if !volume.isFinite || volume <= 0 { volume = 1 }
                            muted = false
                        } else { muted = true }
                    } label: {
                        Image(systemName: symbol).frame(width: 20, height: 20)
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel(level == 0 ? "恢复声音" : "静音")
                    .help(level == 0 ? "恢复声音" : "静音")
                    Slider(value: Binding(get: { level }, set: setLevel), in: 0...2) {
                        Text("朗读音量")
                    } onEditingChanged: { dragging in
                        volumeBeforeDrag = dragging ? volume : nil
                    }
                    .labelsHidden().accessibilityValue(percentage)
                }
            }
            .font(.body).padding(12).frame(width: 216)
        }
    }

    private func setLevel(_ value: Double) {
        let gain = (value * 100).rounded() / 100
        if gain == 0 {
            muted = true
            if let previous = volumeBeforeDrag, previous > 0 { volume = previous }
        } else {
            volume = gain
            muted = false
        }
    }
}
