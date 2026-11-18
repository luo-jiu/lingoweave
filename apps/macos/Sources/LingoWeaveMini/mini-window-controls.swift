import SwiftUI

struct MiniWindowCommands {
    let draft: Binding<String>
    let choose: (Bool) -> Void
    let correct: () -> Void
    let advance: (Bool?) -> Void
    let saveDraft: () -> Void
}

struct MiniWindowControls: View {
    let visit: MiniMemoryWindow.Visit
    let saving: Bool
    let commands: MiniWindowCommands?

    var body: some View {
        HStack(spacing: 10) {
            if visit.stage == 0 {
                Button("记住了") {
                    guard visit.initial == nil else { return }
                    commands?.choose(true)
                }
                .keyboardShortcut(.return, modifiers: [])
            } else if visit.awaitingConfirmation {
                if visit.initial == true {
                    Button("记错了") {
                        guard visit.canCorrect else { return }
                        commands?.correct()
                    }
                    .accessibilityIdentifier("windowCorrect")
                }
                Button("下一个") {
                    guard !visit.advancesAutomatically else { return }
                    commands?.advance(nil)
                }
                .keyboardShortcut(.return, modifiers: [])
                .accessibilityIdentifier("windowConfirm")
            } else {
                Button("想不起来") { commands?.choose(false) }
                Button("想起来了") { commands?.choose(true) }
                    .accessibilityIdentifier("windowRecall")
            }
        }
        .allowsHitTesting(!saving && !visit.advancesAutomatically)
        .task(id: visit.advancesAutomatically && !saving ? visit.id : nil) {
            guard visit.advancesAutomatically, !saving else { return }
            do { try await Task.sleep(for: .milliseconds(300)) }
            catch { return }
            guard !Task.isCancelled else { return }
            commands?.advance(nil)
        }
    }
}
