import SwiftUI

enum MiniCardTextSize: String, CaseIterable {
    case large, medium, small

    var label: String {
        switch self {
        case .large: "大"
        case .medium: "中"
        case .small: "小"
        }
    }

    func font(mediumSize: CGFloat) -> Font {
        let size: CGFloat = switch self {
        case .large: 42
        case .medium: mediumSize
        case .small: 14
        }
        return .system(size: size, weight: .semibold, design: .serif)
    }
}

private struct MiniCardTextSizeKey: EnvironmentKey {
    static let defaultValue = MiniCardTextSize.medium
}

extension EnvironmentValues {
    var miniCardTextSize: MiniCardTextSize {
        get { self[MiniCardTextSizeKey.self] }
        set { self[MiniCardTextSizeKey.self] = newValue }
    }
}
