import Foundation

@main
struct MiniMemoryClientTests {
    static func main() async throws {
        let tests = Self()
        tests.rangeIsBoundedAndIncludesRecentHistory()
        tests.panAndFocusKeepTheZoomedRange()
        try tests.queryUsesSwiftDatesWithoutCommands()
        try tests.missingAbilitiesRemainMissing()
        try tests.curveSegmentsAndEventTimesRemainDistinct()
        print("5 mini memory viewport and read-model tests passed.")
        let env = ProcessInfo.processInfo.environment
        if let address = env["MINI_TEST_FLOW_SERVICE_URL"], let url = URL(string: address), let token = env["MINI_TEST_FLOW_TOKEN_PATH"] {
            try await tests.readLiveFlow(baseURL: url, tokenFile: URL(fileURLWithPath: token))
            print("Swift → HTTP memory overview/detail are read-only; learning snapshot and revision unchanged.")
        }
    }

    private let anchor = Date(timeIntervalSinceReferenceDate: 816_000_000)

    private func rangeIsBoundedAndIncludesRecentHistory() {
        var viewport = MiniMemoryViewport(anchor: anchor)
        precondition(viewport.spanDays == 90)
        precondition(viewport.range.lowerBound == anchor.addingTimeInterval(-30 * 86400))
        precondition(viewport.range.upperBound == anchor.addingTimeInterval(60 * 86400))
        viewport.preset = .overview
        precondition(viewport.spanDays == 730)
        viewport.zoom = 1_000
        precondition(viewport.spanDays <= 730 && viewport.spanDays >= 7)
        viewport.preset = .month
        precondition(viewport.spanDays == 7)
        viewport.zoom = .nan
        precondition(viewport.spanDays == 30 && viewport.range.lowerBound < viewport.range.upperBound)
    }

    private func panAndFocusKeepTheZoomedRange() {
        var viewport = MiniMemoryViewport(zoom: 3, anchor: anchor)
        let initial = viewport.range
        viewport.pan(0.5)
        precondition(viewport.range.lowerBound == initial.lowerBound.addingTimeInterval(15 * 86400))
        let target = anchor.addingTimeInterval(500 * 86400)
        viewport.focus(target)
        precondition(viewport.range.contains(target))
        precondition(abs(target.timeIntervalSince(viewport.range.lowerBound) - 15 * 86400) < 0.01)
        viewport.reset(at: anchor)
        precondition(viewport.zoom == 1 && viewport.offsetDays == 0)
    }

    private func queryUsesSwiftDatesWithoutCommands() throws {
        let viewport = MiniMemoryViewport(anchor: anchor)
        let data = try JSONEncoder().encode(MiniMemoryClient.Query(viewport: viewport, timezone: "Asia/Shanghai", senseId: "sense-apple"))
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { preconditionFailure("Invalid query") }
        precondition(json["from"] as? Double == anchor.timeIntervalSinceReferenceDate - 30 * 86400)
        precondition(json["to"] as? Double == anchor.timeIntervalSinceReferenceDate + 60 * 86400)
        precondition(json["senseId"] as? String == "sense-apple")
        precondition(Set(json.keys) == ["from", "to", "timezone", "senseId"])
    }

    private var wordJSON: String {
        #"{"senseId":"sense-apple","word":{"spelling":"apple","meaning":"苹果","phonetic":""},"source":"flow","status":"learning","dueAt":816086400,"idealDueAt":816086400,"firstSeenAt":816000000,"lastReviewAt":null,"reviewCount":0,"meaning":null,"spelling":null}"#
    }
    private var responseHeader: String {
        #""schemaVersion":1,"revision":7,"asOf":816000000,"timezone":"Asia/Shanghai","from":813408000,"to":821184000,"notices":[]"#
    }

    private func missingAbilitiesRemainMissing() throws {
        let json = "{" + responseHeader + #", "summary":{"wordCount":1,"completedWordCount":1,"measuredWordCount":0,"dueCount":0,"scheduledCount":1,"learningCount":1,"excludedLegacyCount":0},"words":["# + wordJSON + #"],"load":[{"day":"2026-11-10","at":816086400,"count":1}]}"#
        let overview = try JSONDecoder().decode(MiniMemoryOverview.self, from: Data(json.utf8))
        precondition(overview.words[0].meaning == nil && overview.words[0].spelling == nil)
        precondition(overview.words[0].dueAt == Date(timeIntervalSinceReferenceDate: 816086400))
        precondition(overview.summary.completedWordCount == 1 && overview.summary.measuredWordCount == 0)
    }

    private func curveSegmentsAndEventTimesRemainDistinct() throws {
        let json = "{" + responseHeader + #", "word":"# + wordJSON + #", "points":[{"at":816000000,"meaning":0.85,"spelling":null,"meaningSegment":"prior","spellingSegment":null,"projected":false},{"at":816086400,"meaning":0.8,"spelling":null,"meaningSegment":"next","spellingSegment":null,"projected":true}],"events":[{"id":"event","kind":"assessment","occurredAt":815900000,"recordedAt":816000000,"evidence":"model","meaning":"Hard","spelling":null,"reasons":["原答证据"]}],"downsampled":false,"eventsTruncated":false}"#
        let detail = try JSONDecoder().decode(MiniMemoryDetail.self, from: Data(json.utf8))
        precondition(detail.points[0].segment(.meaning) != detail.points[1].segment(.meaning))
        precondition(!detail.points[0].projected && detail.points[1].projected)
        precondition(detail.points[0].value(.spelling) == nil)
        precondition(detail.events[0].recordedAt > detail.events[0].occurredAt && detail.events[0].evidence == "model")
    }

    private func readLiveFlow(baseURL: URL, tokenFile: URL) async throws {
        let study = MiniStudyClient(baseURL: baseURL, tokenFile: tokenFile)
        let before = try await study.serviceData(path: "snapshot")
        let state = try JSONDecoder().decode(MiniStudySnapshot.self, from: before)
        let client = MiniMemoryClient(study: study)
        let viewport = MiniMemoryViewport()
        let overview = try await client.overview(viewport)
        precondition(overview.revision == state.revision && overview.summary.completedWordCount >= 2)
        guard let word = overview.words.first(where: { $0.dueAt != nil }) else { preconditionFailure("Expected an actually scheduled learning word") }
        let detail = try await client.detail(word.senseId, viewport: viewport)
        precondition(detail.word.senseId == word.senseId && detail.revision == state.revision)
        precondition(detail.events.contains { $0.kind == "completion" })
        let after = try await study.serviceData(path: "snapshot")
        precondition(before == after, "Reading charts must never change answers, schedules, tasks, or revision")
    }
}
