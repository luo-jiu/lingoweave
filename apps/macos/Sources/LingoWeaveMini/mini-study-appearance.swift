import SwiftUI

enum MiniStudyAppearance: String, CaseIterable {
    case rich, simple

    var label: String {
        switch self {
        case .rich: "丰富"
        case .simple: "简约"
        }
    }

    var isSimple: Bool { self == .simple }
}

private struct MiniStudyAppearanceKey: EnvironmentKey {
    static let defaultValue = MiniStudyAppearance.rich
}

private struct MiniTranslationObscuredKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    var miniStudyAppearance: MiniStudyAppearance {
        get { self[MiniStudyAppearanceKey.self] }
        set { self[MiniStudyAppearanceKey.self] = newValue }
    }

    var miniTranslationObscured: Bool {
        get { self[MiniTranslationObscuredKey.self] }
        set { self[MiniTranslationObscuredKey.self] = newValue }
    }
}

struct MiniStudyIconButton: View {
    let title: String
    let systemImage: String
    var prominent = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 13, weight: .medium))
                .frame(minWidth: 18, minHeight: 14)
        }
        .miniStudyButton(prominent: prominent)
        .help(title)
        .accessibilityLabel(title)
    }
}

extension View {
    func miniStudyButton(prominent: Bool = false) -> some View {
        modifier(MiniStudyButtonModifier(prominent: prominent))
    }

    func miniTranslationPrivacy() -> some View {
        modifier(MiniTranslationPrivacyModifier())
    }
}

private struct MiniTranslationPrivacyModifier: ViewModifier {
    @Environment(\.miniTranslationObscured) private var obscured

    func body(content: Content) -> some View {
        content
            .blur(radius: obscured ? 6 : 0)
            .clipped()
            .overlay {
                if obscured { Color(nsColor: .windowBackgroundColor).opacity(0.44) }
            }
            .allowsHitTesting(!obscured)
            .accessibilityHidden(obscured)
    }
}

private struct MiniStudyButtonModifier: ViewModifier {
    @Environment(\.miniStudyAppearance) private var appearance
    let prominent: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        if appearance.isSimple {
            content.buttonStyle(MiniNeutralStudyButtonStyle())
        } else if prominent {
            content.buttonStyle(.borderedProminent)
        } else {
            content.buttonStyle(.bordered)
        }
    }
}

private struct MiniNeutralStudyButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        let shape = RoundedRectangle(cornerRadius: 5)
        configuration.label
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .foregroundStyle(Color.primary.opacity(isEnabled ? 1 : 0.48))
            .background {
                shape.fill(Color.primary.opacity(configuration.isPressed ? 0.09 : 0))
            }
            .overlay {
                shape.strokeBorder(Color.primary.opacity(isEnabled ? 0.18 : 0.09), lineWidth: 0.75)
            }
            .contentShape(shape)
    }
}
