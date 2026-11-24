import SwiftUI

struct MiniWindowCommands {
    let draft: Binding<String>
    let choose: (Bool) -> Void
    let correct: () -> Void
    let advance: (Bool?) -> Void
    let saveDraft: () -> Void
    var markFamiliar: (() -> Void)? = nil
}

struct MiniWindowControls: View {
    let visit: MiniMemoryWindow.Visit
    let commands: MiniWindowCommands?

    var body: some View {
        HStack(spacing: 10) {
            if visit.stage == 0 {
                if let markFamiliar = commands?.markFamiliar {
                    MiniStudyIconButton(title: "已认识", systemImage: "book.closed") {
                        guard visit.initial == nil else { return }
                        markFamiliar()
                    }
                    .help("已认识 · 直接加入本组拼写，之后仍要翻译")
                    .accessibilityHint("直接加入本组拼写，之后仍要翻译")
                    .accessibilityIdentifier("windowFamiliar")
                }
                MiniStudyIconButton(title: "记住了", systemImage: "checkmark", prominent: true) {
                    guard visit.initial == nil else { return }
                    commands?.advance(true)
                }
                .keyboardShortcut(.return, modifiers: [])
                .accessibilityIdentifier("windowRemember")
            } else if visit.awaitingConfirmation {
                if visit.initial == true {
                    MiniStudyIconButton(title: "记错了", systemImage: "arrow.uturn.backward") {
                        guard visit.canCorrect else { return }
                        commands?.correct()
                    }
                    .accessibilityIdentifier("windowCorrect")
                }
                MiniStudyIconButton(title: "下一个", systemImage: "arrow.right", prominent: true) {
                    guard !visit.advancesAutomatically else { return }
                    commands?.advance(nil)
                }
                .keyboardShortcut(.return, modifiers: [])
                .accessibilityIdentifier("windowConfirm")
            } else {
                recallButton("Forgot", remembered: false)
                    .accessibilityIdentifier("windowForgot")
                recallButton("Got it", remembered: true)
                    .accessibilityIdentifier("windowRecall")
            }
        }
        .allowsHitTesting(!visit.advancesAutomatically)
    }

    private func recallButton(_ title: String, remembered: Bool) -> some View {
        let description = remembered ? "想起来了" : "想不起来"
        return Button {
            commands?.choose(remembered)
        } label: {
            Text(title).frame(width: 52, height: 16)
        }
        .miniStudyButton(prominent: remembered)
        .help(description)
        .accessibilityLabel(description)
    }
}
