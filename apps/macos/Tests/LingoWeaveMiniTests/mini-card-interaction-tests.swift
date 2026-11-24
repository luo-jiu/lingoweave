import AppKit
import SwiftUI

@MainActor
private final class ScratchState: ObservableObject {
    @Published var draft = "whare"
    @Published var storagePending = false
    @Published var practice = MiniDictation(id: UUID(), target: .daily, dayId: "isolated",
        recordId: nil, session: .learning, word: MiniWord(spelling: "where", meaning: "在哪里"),
        openedAt: .now, closedAt: nil, revealedAt: nil, attempts: [])

    func answer(_ answer: String) {
        let previous = practice
        storagePending = true
        practice = MiniDictation(id: previous.id, target: previous.target, dayId: previous.dayId,
            recordId: nil, session: previous.session, word: previous.word, openedAt: previous.openedAt,
            closedAt: nil, revealedAt: .now,
            attempts: previous.attempts + [MiniDictationAttempt(id: UUID(), answer: answer,
                correct: MiniReviewSession.matchesSpelling(answer, word: practice.word.spelling), submittedAt: .now)])
    }
}

private struct ScratchContent: View {
    @ObservedObject var state: ScratchState
    var body: some View {
        MiniDictationPracticeView(practice: state.practice, draft: $state.draft,
            submit: state.answer, reveal: {}, close: {})
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
    @Published var groupIndex: Int?
    @Published var saving = false
    @Published var session = MiniReviewSession(words: [
        MiniWord(spelling: "where", meaning: "adv. 在哪里"),
        MiniWord(spelling: "bag", meaning: "n. 袋子"),
        MiniWord(spelling: "book", meaning: "n. 书")
    ], startingWithSpelling: true)
}

private struct SpellingContent: View {
    @ObservedObject var state: SpellingState
    var body: some View {
        MiniReviewView(session: $state.session, onFinish: {}, groupIndex: state.groupIndex,
                       playSpellingResult: { state.playedWords.append($0) }, saving: state.saving)
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
    @Published var day: MiniDailyDay?
    @Published var familiarMarks = 0
    @Published var saving = false
    var advances: [Bool?] = []
    var corrections = 0

    init(visit: MiniMemoryWindow.Visit) { self.visit = visit }

    convenience init(day: MiniDailyDay) {
        guard let visit = day.memoryWindow?.visit else { preconditionFailure("Missing window visit") }
        self.init(visit: visit)
        self.day = day
    }

    convenience init(stage: Int, remembered: Bool? = nil) {
        let now = Date.now
        self.init(visit: MiniMemoryWindow.Visit(id: UUID(), word: MiniWord(spelling: "bag", meaning: "袋子"),
            stage: stage, openedAt: now, initial: remembered, selectedAt: remembered == nil ? nil : now,
            revealedAt: remembered == nil ? nil : now, correctedAt: nil, draft: ""))
    }

    func advance(_ choice: Bool?) {
        advances.append(choice)
        if var projected = day, let current = projected.memoryWindow?.visit {
            precondition(projected.advanceWindow(visitId: current.id, nextId: UUID(), remembered: choice,
                                                 markWrong: false, familiar: false, draft: nil, at: .now))
            day = projected
        }
    }

    func choose(_ choice: Bool) {
        let previous = visit
        let now = Date.now
        visit = MiniMemoryWindow.Visit(id: previous.id, word: previous.word, stage: previous.stage,
            openedAt: previous.openedAt, initial: choice, selectedAt: now, revealedAt: now,
            correctedAt: nil, draft: previous.draft)
    }
}

private struct WindowContent: View {
    @ObservedObject var state: WindowState
    var offersFamiliar = false
    var body: some View {
        let commands = MiniWindowCommands(draft: .constant(""), choose: state.choose,
            correct: { state.corrections += 1 }, advance: state.advance, saveDraft: {},
            markFamiliar: offersFamiliar ? { state.familiarMarks += 1 } : nil)
        if let day = Binding($state.day) {
            MiniDailyView(day: day, preparing: false, grading: false, retryPreparation: {},
                          gradeTranslation: {}, reviewGroupIndex: 1, saving: state.saving, previewWindow: commands)
        } else {
            MiniWindowControls(visit: state.visit, commands: commands).background(LayoutMarker())
        }
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
        let returnKey = #selector(NSResponder.insertNewline(_:))
        _ = coordinator?.control(field, textView: editor, doCommandBy: returnKey)
        pump()
        precondition(state.storagePending && field.isEnabled && window.firstResponder === editor,
                     "An in-flight scratch save must preserve the enabled input and its focus")
        precondition(editor.textColor == NSColor.systemRed && state.practice.attempts.count == 1,
                     "An incorrect answer turns red before the save returns")
        precondition(field.convert(field.bounds, to: nil) == frame,
                     "Showing a wrong-answer reference must preserve the input position")
        state.draft = "where"
        pump()
        _ = coordinator?.control(field, textView: editor, doCommandBy: returnKey)
        pump()
        precondition(state.storagePending && editor.textColor == NSColor.systemGreen && state.practice.attempts.count == 2,
                     "A correction turns green while previous saves are pending")
        precondition(field.convert(field.bounds, to: nil) == frame,
                     "Showing accepted spelling must preserve the input position")
        window.makeFirstResponder(nil)
        _ = coordinator?.control(field, textView: editor, doCommandBy: returnKey)
        window.makeKeyAndOrderFront(nil)
        app.activate(ignoringOtherApps: true)
        pump()
        precondition(state.draft.isEmpty && field.currentEditor() != nil,
                     "Repeat spelling must clear the draft and explicitly restore input focus")
        precondition(state.storagePending && state.practice.attempts.count == 2,
                     "Starting another attempt only clears the draft while saves are pending")
        state.storagePending = false
        pump()
        precondition(editor.textColor == NSColor.labelColor && state.draft.isEmpty,
                     "Save completion must not bring back the previous answer or its color")
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

        for stage in [1, 2] {
            let transition = WindowState(stage: stage)
            let transitionWindow = makeWindow()
            transitionWindow.contentView = NSHostingView(rootView: WindowContent(state: transition))
            transitionWindow.makeKeyAndOrderFront(nil)
            pump()
            clickWindowControl(in: transitionWindow, relativeX: 0.75)
            pump()
            precondition(transition.visit.initial == true && transition.visit.showsFullCard && transition.advances.isEmpty,
                         "Recall reveals the card for checking before moving on")
            let corrects = stage == 2
            clickWindowControl(in: transitionWindow, relativeX: corrects ? 0.25 : 0.75)
            pump(for: 0.03)
            precondition(corrects ? transition.corrections == 1 && transition.advances.isEmpty : transition.advances == [nil],
                         "Confirm or correct dispatches its single action immediately")
            transitionWindow.orderOut(nil)
        }

        let familiar = WindowState(stage: 0)
        let familiarWindow = makeWindow()
        familiarWindow.contentView = NSHostingView(rootView: WindowContent(state: familiar, offersFamiliar: true))
        familiarWindow.makeKeyAndOrderFront(nil)
        pump()
        clickWindowControl(in: familiarWindow, relativeX: 0.25)
        pump()
        familiar.objectWillChange.send()
        pump()
        precondition(familiar.familiarMarks == 1 && familiar.visit.initial == nil && familiar.advances.isEmpty,
                     "The familiar button dispatches once without also submitting a normal recall or advance")
        familiarWindow.orderOut(nil)

        for size in [NSSize(width: 360, height: 234), NSSize(width: 600, height: 440)] {
            let spelling = SpellingState()
            let spellingWindow = makeWindow()
            spellingWindow.setContentSize(size)
            spellingWindow.contentView = NSHostingView(rootView: SpellingContent(state: spelling))
            spellingWindow.makeKeyAndOrderFront(nil)
            pump()
            let initialFrame = spellingFrame(in: spellingWindow)
            precondition(abs(initialFrame.midY - size.height / 2) < 14,
                         "The typing row stays near the center of the card at compact and expanded sizes")
            precondition(spelling.playedWords.isEmpty, "Opening a spelling prompt must keep its pronunciation concealed")
            spelling.saving = true
            pump()
            guard let input = answerField(in: spellingWindow.contentView) else { preconditionFailure() }
            precondition(input.isEnabled && input.currentEditor() != nil,
                         "A background write must keep the spelling field enabled and focused")
            precondition(spelling.session.submitSpelling("where"))
            pump()
            precondition(input.isEnabled && input.textColor == .systemGreen,
                         "A correct spelling stays green while a save is pending")
            precondition(spelling.playedWords.map(\.spelling) == ["where"], "A correct result reads its word once")
            precondition(spellingFrame(in: spellingWindow) == initialFrame,
                         "Showing the green answer and Next button must preserve the input and underline position")
            precondition(spelling.session.advanceSpelling())
            pump()
            precondition(spelling.playedWords.count == 1, "Moving to the next prompt does not read its answer")
            precondition(spellingFrame(in: spellingWindow) == initialFrame,
                         "Removing the Next button for the following word must preserve the spelling position")
            let emptyFeedback = spellingFeedbackPixels(in: spellingWindow)
            guard let field = answerField(in: spellingWindow.contentView),
                  let editor = field.currentEditor() as? NSTextView,
                  let coordinator = field.delegate as? ReviewAnswerField.Coordinator else {
                preconditionFailure("The grouped spelling input must have keyboard focus")
            }
            let returnKey = #selector(NSResponder.insertNewline(_:))
            precondition(editor.string.isEmpty && coordinator.control(field, textView: editor, doCommandBy: returnKey))
            pump()
            precondition(spelling.session.spellingState == .correcting && spelling.session.lastSpellingAttempt?.answer == "",
                         "Return on a blank field saves an incorrect original answer")
            precondition(spelling.playedWords.map(\.spelling) == ["where", "bag"], "A blank answer also reads its word once")
            precondition(spellingFeedbackPixels(in: spellingWindow) != emptyFeedback,
                         "A blank submission shows its reference spelling before correction starts")
            precondition(spellingFrame(in: spellingWindow) == initialFrame,
                         "Showing the reference spelling must preserve the input and underline position")
            spelling.session.spellingDraft = "b"
            pump()
            precondition(spellingFeedbackPixels(in: spellingWindow) == emptyFeedback,
                         "Starting a correction removes the visible reference spelling")
            spelling.session.spellingDraft = ""
            pump()
            precondition(spellingFeedbackPixels(in: spellingWindow) == emptyFeedback,
                         "Clearing the correction must not restore the hint until Return is pressed")
            precondition(coordinator.control(field, textView: editor, doCommandBy: returnKey))
            pump()
            precondition(spellingFeedbackPixels(in: spellingWindow) != emptyFeedback && spelling.session.spellingAttempts.count == 2,
                         "Return restores the same blank-answer hint without counting it again")
            precondition(spelling.playedWords.count == 2 && spellingFrame(in: spellingWindow) == initialFrame,
                         "Editing a correction preserves the input position and does not play audio")
            precondition(spelling.session.submitSpelling("still incorrect"))
            pump()
            precondition(field.isEnabled && field.textColor == .systemRed && editor.textColor == .systemRed,
                         "A submitted wrong correction appears red in the active editor")
            precondition(spellingFeedbackPixels(in: spellingWindow) != emptyFeedback,
                         "Another submitted wrong answer shows fresh feedback")
            spelling.session.spellingDraft = "s"
            pump()
            spelling.session.spellingDraft = "still incorrect"
            pump()
            precondition(spellingFeedbackPixels(in: spellingWindow) == emptyFeedback)
            precondition(coordinator.control(field, textView: editor, doCommandBy: returnKey))
            pump()
            precondition(field.textColor == .systemRed && spelling.session.spellingAttempts.count == 3,
                         "Resubmitting the same incorrect text restores red feedback without duplicating the answer")
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
        testWindowCardWhileSaving()
        testResumingAnOldWindowChoice()
        testWrappedSpellingPrompt()
        testLongReviewFitsPanel()
        print("Native card focus, spelling layout, compact review progress, audio layout and window transition tests passed.")
    }

    @MainActor
    private static func testWindowCardWhileSaving() {
        let newWords = MiniDevPreview.make(.learning).day
        var relearning = MiniDevPreview.make(.reviewJudgment).day
        relearning.flow = newWords.flow
        relearning.review?.relearning = newWords.memoryWindow
        relearning.review?.relearningWords = newWords.preparationWords
        for day in [newWords, relearning] {
            guard let confirmed = day.memoryWindow?.visit else { preconditionFailure("Missing memory visit") }
            let state = WindowState(day: day)
            let window = makeWindow()
            let hasFamiliar = day.phase == .learning
            let host = NSHostingView(rootView: WindowContent(state: state, offersFamiliar: hasFamiliar))
            window.contentView = host
            window.makeKeyAndOrderFront(nil)
            defer { window.orderOut(nil) }
            pump()
            let buttonStrip = NSRect(x: host.bounds.midX - 85, y: 0, width: 170, height: 26)
            let wordCard = NSRect(x: 0, y: 30, width: host.bounds.width, height: host.bounds.height - 60)
            let ready = pixels(in: host, windowRect: buttonStrip)
            let original = pixels(in: host, windowRect: wordCard)
            state.saving = true
            pump()
            precondition(pixels(in: host, windowRect: buttonStrip) == ready,
                         "An in-flight write must not dim either kind of memory card")
            click(in: window, at: NSPoint(x: host.bounds.midX + (hasFamiliar ? 32 : 0), y: 12))
            pump(for: 0.03)
            precondition(state.advances == [true] && state.day?.memoryWindow?.visit?.word != confirmed.word,
                         "Remember advances in one action even while saving")
            precondition(pixels(in: host, windowRect: wordCard) != original,
                         "The next word appears before the original server visit changes")
            state.saving = false
            pump(for: 0.08)
            state.saving = true
            pump(for: 0.2)
            precondition(state.advances == [true], "Background writes cannot advance another word")
        }
    }

    @MainActor
    private static func testResumingAnOldWindowChoice() {
        for stage in [MiniDevStage.learning, .learningMeaning] {
            var day = MiniDevPreview.make(stage).day
            precondition(MiniDevPreview.editVisit(&day, choice: true))
            if stage == .learningMeaning { precondition(MiniDevPreview.editVisit(&day, corrected: true)) }
            let state = WindowState(day: day)
            let window = makeWindow()
            window.contentView = NSHostingView(rootView: WindowContent(state: state))
            window.makeKeyAndOrderFront(nil)
            defer { window.orderOut(nil) }
            pump()
            precondition(state.advances == [nil], "A saved choice left by older releases advances without a held frame")
            state.saving = true
            pump()
            precondition(state.advances == [nil], "A redraw must not consume a second choice")
        }
    }

    @MainActor
    private static func testWrappedSpellingPrompt() {
        let word = MiniWord(spelling: "local", meaning: "a. 地方性的, 当地的, 局部的, 乡土的, 本地的")
        let state = SpellingState()
        state.session = MiniReviewSession(words: [word], startingWithSpelling: true)
        let window = makeWindow()
        window.setContentSize(NSSize(width: 300, height: 218))
        window.contentView = NSHostingView(rootView: SpellingContent(state: state))
        window.makeKeyAndOrderFront(nil)
        defer { window.orderOut(nil) }
        pump()
        let line = spellingFrame(in: window)
        for answer in ["loacl", "local"] {
            precondition(state.session.submitSpelling(answer))
            pump()
            precondition(spellingFrame(in: window) == line,
                         "A wrapped definition keeps its height and the typing row stays put across feedback")
        }
    }

    @MainActor
    private static func testLongReviewFitsPanel() {
        let words = (1...300).map { MiniWord(spelling: "word\($0)", meaning: "词\($0)") }
        let state = SpellingState()
        let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 360, height: 300),
                            styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        panel.isReleasedWhenClosed = false
        let host = NSHostingView(rootView: SpellingContent(state: state))
        panel.contentView = host
        panel.orderFront(nil)
        defer { panel.orderOut(nil) }
        for width: CGFloat in [360, 300, 600] {
            panel.setContentSize(NSSize(width: width, height: 300))
            state.session = MiniReviewSession(words: words)
            pump()
            func assertWidth() {
                precondition(abs(host.bounds.width - width) < 1 && host.fittingSize.width <= width,
                             "The 300-word progress row must fit the panel at its chosen width (\(width))")
            }
            assertWidth()
            state.session.chooseJudgment(.clear)
            pump()
            assertWidth()
            state.session = MiniReviewSession(words: words, startingWithSpelling: true)
            pump()
            assertWidth()
            state.session = MiniReviewSession(words: Array(words.prefix(10)))
            pump()
            assertWidth()
            for spelling in [false, true] {
                state.groupIndex = nil
                state.session = MiniReviewSession(words: Array(words.prefix(10)), startingWithSpelling: spelling)
                pump()
                let centered = markerPixels(in: host)
                state.groupIndex = 12
                pump()
                precondition(markerPixels(in: host) == centered,
                             "The left group label must leave the centered ten-word indicator in place at \(width) pt")
                if spelling {
                    precondition(state.session.submitSpelling("word1") && state.session.advanceSpelling())
                } else {
                    precondition(state.session.chooseJudgment(.clear) && state.session.advanceJudgment())
                }
                pump()
                precondition(markerPixels(in: host) != centered, "Advancing must change the captured progress markers")
            }
        }
    }

    @MainActor
    private static func markerPixels(in host: NSView) -> Data {
        let frame = host.convert(host.bounds, to: nil)
        return pixels(in: host, windowRect: NSRect(x: frame.midX - 87, y: frame.maxY - 32, width: 174, height: 20))
    }

    @MainActor
    private static func pixels(in host: NSView, windowRect: NSRect) -> Data {
        let strip = host.convert(windowRect, from: nil)
        guard let image = host.bitmapImageRepForCachingDisplay(in: strip) else { preconditionFailure() }
        host.cacheDisplay(in: strip, to: image)
        guard let pixels = image.representation(using: .png, properties: [:]) else { preconditionFailure() }
        return pixels
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
    private static func clickWindowControl(in window: NSWindow, relativeX: CGFloat) {
        guard let marker = layoutMarker(in: window.contentView) else {
            preconditionFailure("Missing window control geometry")
        }
        let frame = marker.convert(marker.bounds, to: nil)
        click(in: window, at: NSPoint(x: frame.minX + frame.width * relativeX, y: frame.midY))
    }

    @MainActor
    private static func click(in window: NSWindow, at point: NSPoint) {
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
