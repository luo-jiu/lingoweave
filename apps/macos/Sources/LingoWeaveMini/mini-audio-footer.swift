import SwiftUI

struct MiniAudioFooter<Controls: View>: View {
    let notice: String?
    @ViewBuilder var controls: () -> Controls

    var body: some View {
        VStack(spacing: 2) {
            Text(notice ?? " ")
                .font(.caption2).foregroundStyle(.secondary).lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading).frame(height: 24, alignment: .top)
                .opacity(notice == nil ? 0 : 1)
                .accessibilityHidden(notice == nil)
            ZStack(alignment: .leading) {
                Color.clear
                controls()
            }.frame(height: 18)
        }
        .padding(.top, 3)
    }
}
