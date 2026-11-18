import AppKit
import SwiftUI

@MainActor
private final class ScratchState: ObservableObject {
    @Published var draft = "where"
    @Published var saving = false
    var playedWords: [MiniWord] = []
    @Published var practice = MiniDictation(id: UUID(), target: .daily, dayId: "isolated",
        recordId: nil, session: .learning, word: MiniWord(spelling: "where", meaning: "在哪里"),
        openedAt: .now, closedAt: nil, revealedAt: nil, attempts: [])

    func answer(_ correct: Bool) {
        let previous = practice
        practice = MiniDictation(id: previous.id, target: previous.target, dayId: previous.dayId,
            recordId: nil, session: previous.session, word: previous.word, openedAt: previous.openedAt,
            closedAt: nil, revealedAt: .now,
            attempts: previous.attempts + [MiniDictationAttempt(id: UUID(), answer: draft,
                correct: correct, submittedAt: .now)])
        saving = false
    }
}

private struct ScratchContent: View {
    @ObservedObject var state: ScratchState
    var body: some View {
        MiniDictationPracticeView(practice: state.practice, draft: $state.draft, saving: state.saving,
            submit: { _ in state.saving = true }, reveal: {}, close: {},
            playWord: { state.playedWords.append($0) })
            .padding(14)
    }
}

@MainActor
private final class FieldState: ObservableObject {
    @Published var enabled = false
    @Published var text = ""
}

private struct FieldContent: View {
    @ObservedObject var state: FieldState
    var body: some View {
        ReviewAnswerField(text: $state.text, selectOnFocus: false, onSubmit: { _ in false })
            .frame(width: 206, height: 30).disabled(!state.enabled)
    }
}

@MainActor
private final class SpellingState: ObservableObject {
    var playedWords: [MiniWord] = []
    @Published var session = MiniReviewSession(words: [
        MiniWord(spelling: "where", meaning: "adv. 在哪里"),
        MiniWord(spelling: "bag", meaning: "n. 袋子"),
        MiniWord(spelling: "book", meaning: "n. 书")
    ], startingWithSpelling: true)
}

private struct SpellingContent: View {
    @ObservedObject var state: SpellingState
    var body: some View {
        MiniReviewView(session: $state.session, onFinish: {},
                       playSpellingResult: { state.playedWords.append($0) })
            .safeAreaInset(edge: .bottom, spacing: 2) {
                MiniAudioFooter(notice: nil) {
                    Label("听词提示", systemImage: "speaker.wave.2").font(.caption)
                }
            }
            .padding(14)
    }
}

@MainActor
private final class FooterState: ObservableObject {
    @Published var ready = false
    @Published var notice: String?
}

private struct LayoutMarker: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        view.identifier = NSUserInterfaceItemIdentifier("recallButtons")
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {}
}

private struct FooterContent: View {
    @ObservedObject var state: FooterState
    var body: some View {
        VStack {
            Spacer()
            Text("I like this music.")
            Spacer()
            HStack {
                Button("想不起来") {}
                Button("想起来了") {}
            }.background(LayoutMarker())
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .safeAreaInset(edge: .bottom, spacing: 2) {
            MiniAudioFooter(notice: state.notice) {
                if state.ready {
                    HStack {
                        Label("读词", systemImage: "speaker.wave.2")
                        Label("例句", systemImage: "speaker.wave.2")
                    }.font(.caption)
                }
            }
        }
        .padding(14)
    }
}

@MainActor
private final class WindowState: ObservableObject {
    @Published var visit: MiniMemoryWindow.Visit
    var advances: [Date] = []
    var selectedAt: Date?

    init(stage: Int, remembered: Bool? = nil) {
        let now = Date.now
        visit = MiniMemoryWindow.Visit(id: UUID(), word: MiniWord(spelling: "bag", meaning: "袋子"),
            stage: stage, openedAt: now, initial: remembered, selectedAt: remembered == nil ? nil : now,
            revealedAt: remembered == nil ? nil : now, correctedAt: nil, draft: "")
    }

    func edit(choice: Bool? = nil, corrected: Bool = false) {
        let previous = visit
        selectedAt = .now
        visit = MiniMemoryWindow.Visit(id: previous.id, word: previous.word, stage: previous.stage,
            openedAt: previous.openedAt, initial: choice ?? previous.initial,
            selectedAt: choice == nil ? previous.selectedAt : selectedAt,
            revealedAt: choice == nil ? previous.revealedAt : selectedAt,
            correctedAt: corrected ? selectedAt : previous.correctedAt, draft: previous.draft)
    }
}

private struct WindowContent: View {
    @ObservedObject var state: WindowState
    var body: some View {
        MiniWindowControls(visit: state.visit, saving: false,
            commands: MiniWindowCommands(draft: .constant(""), choose: { state.edit(choice: $0) },
                correct: { state.edit(corrected: true) }, advance: { _ in state.advances.append(.now) }, saveDraft: {}))
            .background(LayoutMarker())
    }
}

@main
struct MiniCardInteractionTests {
    @MainActor
    static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        app.activate(ignoringOtherApps: true)
        let state = ScratchState()
        let window = makeWindow()
        window.contentView = NSHostingView(rootView: ScratchContent(state: state))
        pump()
        window.makeKeyAndOrderFront(nil)
        pump()
        guard let field = answerField(in: window.contentView),
              let editor = field.currentEditor() as? NSTextView else {
            preconditionFailure("Opening scratch spelling must focus its input when the window becomes key")
        }
        precondition(window.firstResponder === editor)
        let frame = field.convert(field.bounds, to: nil)
        let coordinator = field.delegate as? ReviewAnswerField.Coordinator
        _ = coordinator?.control(field, textView: editor, doCommandBy: #selector(NSResponder.insertNewline(_:)))
        pump()
        precondition(state.saving && field.isEnabled && window.firstResponder === editor,
                     "An in-flight scratch save must preserve the enabled input and its focus")
        precondition(field.convert(field.bounds, to: nil) == frame,
                     "Submitting must preserve the input position")
        state.answer(false)
        pump()
        precondition(editor.textColor == NSColor.systemRed && state.playedWords.count == 1,
                     "Each incorrect result turns the submitted answer red and pronounces the word once")
        state.saving = false
        pump()
        precondition(state.playedWords.count == 1, "An unchanged result must not repeat its pronunciation")
        precondition(field.convert(field.bounds, to: nil) == frame,
                     "Showing a wrong-answer reference must preserve the input position")
        state.answer(true)
        pump()
        precondition(editor.textColor == NSColor.systemGreen)
        precondition(state.playedWords.count == 2, "A correct result also pronounces the word once")
        precondition(field.convert(field.bounds, to: nil) == frame,
                     "Showing accepted spelling must preserve the input position")
        window.makeFirstResponder(nil)
        _ = coordinator?.control(field, textView: editor, doCommandBy: #selector(NSResponder.insertNewline(_:)))
        window.makeKeyAndOrderFront(nil)
        app.activate(ignoringOtherApps: true)
        pump()
        precondition(state.draft.isEmpty && field.currentEditor() != nil,
                     "Repeat spelling must clear the draft and explicitly restore input focus")
        precondition(state.playedWords.count == 2, "Starting another spelling attempt does not read the answer")
        let repeatedFrame = field.convert(field.bounds, to: nil)
        precondition(abs(repeatedFrame.midX - frame.midX) < 0.5 && abs(repeatedFrame.midY - frame.midY) < 0.5,
                     "Repeat changed the input frame from \(frame) to \(repeatedFrame)")
        window.orderOut(nil)

        let reenabled = FieldState()
        let second = makeWindow()
        second.contentView = NSHostingView(rootView: FieldContent(state: reenabled))
        second.makeKeyAndOrderFront(nil)
        pump()
        guard let secondField = answerField(in: second.contentView) else {
            preconditionFailure("Missing spelling field")
        }
        precondition(!secondField.isEnabled)
        reenabled.enabled = true
        pump()
        precondition(secondField.currentEditor() != nil,
                     "A field first mounted while saving must acquire focus when enabled")
        second.orderOut(nil)

        let footerState = FooterState()
        let footerWindow = makeWindow()
        footerWindow.contentView = NSHostingView(rootView: FooterContent(state: footerState))
        footerWindow.makeKeyAndOrderFront(nil)
        pump()
        guard let marker = layoutMarker(in: footerWindow.contentView) else {
            preconditionFailure("Missing recall button layout marker")
        }
        let buttonFrame = marker.convert(marker.bounds, to: nil)
        precondition(buttonFrame.height > 0)
        footerState.ready = true
        pump()
        precondition(marker.convert(marker.bounds, to: nil) == buttonFrame,
                     "Audio controls appearing after loading must not move the recall buttons")
        footerState.notice = "这条音频尚未生成成功，可以重播或重新生成。"
        pump()
        precondition(marker.convert(marker.bounds, to: nil) == buttonFrame,
                     "A two-line audio notice must use reserved space without moving the recall buttons")
        footerState.ready = false
        footerState.notice = nil
        pump()
        precondition(marker.convert(marker.bounds, to: nil) == buttonFrame,
                     "Audio controls disappearing during a card refresh must preserve button positions")
        footerWindow.orderOut(nil)

        for stage in [0, 2] {
            let transition = WindowState(stage: stage, remembered: stage == 0 ? nil : true)
            let transitionWindow = makeWindow()
            transitionWindow.contentView = NSHostingView(rootView: WindowContent(state: transition))
            transitionWindow.makeKeyAndOrderFront(nil)
            pump()
            clickWindowControl(in: transitionWindow, firstOfTwo: stage != 0)
            pump()
            precondition(transition.visit.completedStages == (stage == 0 ? 1 : 0),
                         "Clicking the actual button immediately updates the current word's dots")
            precondition(transition.advances.isEmpty, "The green/reset feedback stays visible for 0.3 seconds")
            pump(for: 0.3)
            precondition(transition.advances.count == 1)
            precondition(transition.advances[0].timeIntervalSince(transition.selectedAt ?? .distantPast) >= 0.3)
            pump(for: 0.35)
            precondition(transition.advances.count == 1, "Ordinary redraws cannot advance a second word")
            transitionWindow.orderOut(nil)
        }

        let cancelled = WindowState(stage: 0)
        let cancelledWindow = makeWindow()
        cancelledWindow.contentView = NSHostingView(rootView: WindowContent(state: cancelled))
        cancelledWindow.makeKeyAndOrderFront(nil)
        pump()
        clickWindowControl(in: cancelledWindow, firstOfTwo: false)
        pump(for: 0.05)
        cancelledWindow.contentView = nil
        pump(for: 0.4)
        precondition(cancelled.advances.isEmpty, "Leaving the card cancels its pending automatic advance")
        cancelledWindow.orderOut(nil)

        for size in [NSSize(width: 360, height: 234), NSSize(width: 600, height: 440)] {
            let spelling = SpellingState()
            let spellingWindow = makeWindow()
            spellingWindow.setContentSize(size)
            spellingWindow.contentView = NSHostingView(rootView: SpellingContent(state: spelling))
            spellingWindow.makeKeyAndOrderFront(nil)
            pump()
            let initialFrame = spellingFrame(in: spellingWindow)
            precondition(spelling.playedWords.isEmpty, "Opening a spelling prompt must keep its pronunciation concealed")
            precondition(spelling.session.submitSpelling("where"))
            pump()
            precondition(spelling.playedWords.map(\.spelling) == ["where"], "A correct result reads its word once")
            precondition(spellingFrame(in: spellingWindow) == initialFrame,
                         "Showing the green answer and Next button must preserve the input and underline position")
            precondition(spelling.session.advanceSpelling())
            pump()
            precondition(spelling.playedWords.count == 1, "Moving to the next prompt does not read its answer")
            precondition(spellingFrame(in: spellingWindow) == initialFrame,
                         "Removing the Next button for the following word must preserve the spelling position")
            let emptyFeedback = spellingFeedbackPixels(in: spellingWindow)
            precondition(spelling.session.submitSpelling("incorrect"))
            pump()
            precondition(spelling.playedWords.map(\.spelling) == ["where", "bag"], "An incorrect result also reads its word once")
            precondition(spellingFeedbackPixels(in: spellingWindow) != emptyFeedback,
                         "A wrong submission shows its reference spelling before correction starts")
            precondition(spellingFrame(in: spellingWindow) == initialFrame,
                         "Showing the reference spelling must preserve the input and underline position")
            spelling.session.spellingDraft = "b"
            pump()
            precondition(spellingFeedbackPixels(in: spellingWindow) == emptyFeedback,
                         "Starting a correction removes the visible reference spelling")
            spelling.session.spellingDraft = "incorrect"
            pump()
            precondition(spellingFeedbackPixels(in: spellingWindow) == emptyFeedback,
                         "Typing the old wrong answer again must not restore the hidden reference")
            precondition(spelling.playedWords.count == 2 && spellingFrame(in: spellingWindow) == initialFrame,
                         "Editing a correction preserves the input position and does not play audio")
            precondition(spelling.session.submitSpelling("still incorrect"))
            pump()
            precondition(spellingFeedbackPixels(in: spellingWindow) != emptyFeedback,
                         "Another submitted wrong answer shows fresh feedback")
            precondition(spelling.session.submitSpelling("bag"))
            pump()
            precondition(spelling.playedWords.map(\.spelling) == ["where", "bag", "bag", "bag"], "Each submitted correction reads its word once")
            spelling.objectWillChange.send()
            pump()
            precondition(spelling.playedWords.count == 4, "A normal redraw must not repeat the submitted result's pronunciation")
            precondition(spellingFrame(in: spellingWindow) == initialFrame,
                         "Replacing the reference spelling with Next after correction must preserve the input position")
            precondition(spelling.session.advanceSpelling())
            var attempts = 0
            while spelling.session.spellingSkips?.isEmpty != false {
                attempts += 1
                precondition(attempts < 12)
                guard let word = spelling.session.currentWord else { preconditionFailure("Missing repeat word") }
                precondition(spelling.session.submitSpelling("incorrect"))
                if spelling.session.spellingState == .correcting {
                    precondition(spelling.session.submitSpelling(word.spelling))
                    precondition(spelling.session.advanceSpelling())
                }
            }
            pump()
            precondition(spelling.session.phase == .spelling && spellingFrame(in: spellingWindow) == initialFrame,
                         "The deferred-word notice must use reserved space while spelling continues")
            spellingWindow.orderOut(nil)
        }
        print("9 native card focus, spelling layout, audio layout and delayed window transition tests passed.")
    }

    @MainActor
    private static func makeWindow() -> NSWindow {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 360, height: 234),
                              styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.title = "Isolated card interaction tests"
        return window
    }

    @MainActor
    private static func answerField(in view: NSView?) -> AnswerTextField? {
        guard let view else { return nil }
        if let field = view as? AnswerTextField { return field }
        return view.subviews.lazy.compactMap { answerField(in: $0) }.first
    }

    @MainActor
    private static func spellingFrame(in window: NSWindow) -> NSRect {
        guard let field = answerField(in: window.contentView) else {
            preconditionFailure("Missing grouped spelling input")
        }
        return field.convert(field.bounds, to: nil)
    }

    @MainActor
    private static func spellingFeedbackPixels(in window: NSWindow) -> Data {
        guard let content = window.contentView else { preconditionFailure("Missing spelling content") }
        let field = spellingFrame(in: window)
        let region = content.convert(NSRect(x: field.midX - 100, y: field.minY - 58, width: 200, height: 48), from: nil)
        guard let bitmap = content.bitmapImageRepForCachingDisplay(in: region) else {
            preconditionFailure("Could not inspect the spelling feedback region")
        }
        content.cacheDisplay(in: region, to: bitmap)
        guard let pixels = bitmap.representation(using: .png, properties: [:]) else {
            preconditionFailure("Could not inspect spelling feedback pixels")
        }
        return pixels
    }

    @MainActor
    private static func layoutMarker(in view: NSView?) -> NSView? {
        guard let view else { return nil }
        if view.identifier?.rawValue == "recallButtons" { return view }
        return view.subviews.lazy.compactMap { layoutMarker(in: $0) }.first
    }

    @MainActor
    private static func clickWindowControl(in window: NSWindow, firstOfTwo: Bool) {
        guard let marker = layoutMarker(in: window.contentView) else {
            preconditionFailure("Missing window control geometry")
        }
        let frame = marker.convert(marker.bounds, to: nil)
        let point = NSPoint(x: firstOfTwo ? frame.minX + frame.width / 4 : frame.midX, y: frame.midY)
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            guard let event = NSEvent.mouseEvent(with: type, location: point, modifierFlags: [],
                timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                context: nil, eventNumber: 1, clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0) else {
                preconditionFailure("Could not create an isolated control click")
            }
            window.sendEvent(event)
        }
    }

    @MainActor
    private static func pump(for duration: TimeInterval = 0.12) {
        RunLoop.current.run(until: Date.now.addingTimeInterval(duration))
    }
}
