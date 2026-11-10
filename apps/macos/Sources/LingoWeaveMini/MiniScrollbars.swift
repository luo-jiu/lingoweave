import AppKit
import SwiftUI

extension View {
    /// Keeps native scrollbars compact inside the small study window.
    func miniWindowScrollbars() -> some View {
        background {
            MiniScrollbarObserver()
                .allowsHitTesting(false)
                .accessibilityHidden(true)
        }
    }
}

private struct MiniScrollbarObserver: NSViewRepresentable {
    func makeNSView(context: Context) -> ObserverView { ObserverView() }

    func updateNSView(_ view: ObserverView, context: Context) {
        view.scheduleUpdate()
    }

    final class ObserverView: NSView {
        private var updateScheduled = false

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            let notifications = NotificationCenter.default
            notifications.removeObserver(self, name: NSWindow.didUpdateNotification, object: nil)
            guard let window else { return }
            notifications.addObserver(
                self, selector: #selector(scheduleUpdate), name: NSWindow.didUpdateNotification, object: window
            )
            scheduleUpdate()
        }

        @objc func scheduleUpdate() {
            guard !updateScheduled, window != nil else { return }
            updateScheduled = true
            Task { @MainActor [weak self] in
                guard let self else { return }
                updateScheduled = false
                if let content = window?.contentView { styleScrollViews(in: content) }
            }
        }

        private func styleScrollViews(in view: NSView) {
            if let scrollView = view as? NSScrollView {
                if scrollView.scrollerStyle != .overlay { scrollView.scrollerStyle = .overlay }
                if !scrollView.autohidesScrollers { scrollView.autohidesScrollers = true }
                let largeScrollers = [scrollView.verticalScroller, scrollView.horizontalScroller]
                    .compactMap { $0 }
                    .filter { $0.controlSize != .small }
                if !largeScrollers.isEmpty {
                    for scroller in largeScrollers { scroller.controlSize = .small }
                    scrollView.tile()
                }
            }
            for child in view.subviews { styleScrollViews(in: child) }
        }
    }
}
