import Foundation

struct MiniWord: Codable, Hashable, Sendable {
    let spelling: String
    let meaning: String
    var phonetic = ""

    var chatContext: String {
        [spelling, phonetic, meaning].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    static func parseList(_ text: String) -> [MiniWord] {
        text.split(whereSeparator: \.isNewline).compactMap { line in
            let columns = line.split(separator: "\t", maxSplits: 1, omittingEmptySubsequences: false)
            let spelling = columns[0].trimmingCharacters(in: .whitespaces)
            guard !spelling.isEmpty else { return nil }
            let meaning = columns.count == 2 ? columns[1].trimmingCharacters(in: .whitespaces) : ""
            return MiniWord(spelling: spelling, meaning: meaning)
        }
    }

    // Adapted from the project's seed glossary, CC BY-SA 4.0, Wiktionary contributors.
    // Source revisions and attribution are listed in docs/lexicon-sources.md.
    static let starter: [MiniWord] = [
        .init(spelling: "apple", meaning: "苹果（水果）", phonetic: "/ˈæpəl/"),
        .init(spelling: "book", meaning: "书；书本", phonetic: "/bʊk/"),
        .init(spelling: "water", meaning: "水", phonetic: "/ˈwɔː.tə/"),
        .init(spelling: "read", meaning: "阅读；看懂文字", phonetic: "/ɹiːd/"),
        .init(spelling: "write", meaning: "写；书写文字", phonetic: "/ɹaɪt/"),
        .init(spelling: "house", meaning: "房屋；住宅", phonetic: "/haʊ̯s/"),
        .init(spelling: "room", meaning: "房间", phonetic: "/ɹuːm/"),
        .init(spelling: "door", meaning: "门", phonetic: "/dɔː/"),
        .init(spelling: "chair", meaning: "椅子", phonetic: "/t͡ʃɛə/"),
        .init(spelling: "table", meaning: "桌子", phonetic: "/ˈteɪbl̩/"),
        .init(spelling: "food", meaning: "食物", phonetic: "/fuːd/"),
        .init(spelling: "milk", meaning: "奶；乳汁", phonetic: "/mɪlk/"),
        .init(spelling: "bread", meaning: "面包", phonetic: "/bɹɛd/"),
        .init(spelling: "friend", meaning: "朋友", phonetic: "/fɹɛnd/"),
        .init(spelling: "family", meaning: "家庭；家人", phonetic: "/ˈfæm(ɪ)li/"),
        .init(spelling: "school", meaning: "学校", phonetic: "/skuːl/"),
        .init(spelling: "teacher", meaning: "老师；教师", phonetic: "/ˈti.t͡ʃɚ/"),
        .init(spelling: "student", meaning: "学生", phonetic: "/ˈstjuː.dn̩t/"),
        .init(spelling: "day", meaning: "一天（约二十四小时）", phonetic: "/deɪ̯/"),
        .init(spelling: "night", meaning: "夜晚", phonetic: "/naɪ̯t/"),
        .init(spelling: "go", meaning: "去；前往", phonetic: "/ɡəʊ/"),
        .init(spelling: "come", meaning: "来；靠近", phonetic: "/kʌm/"),
        .init(spelling: "eat", meaning: "吃（食物）", phonetic: "/iːt/"),
        .init(spelling: "drink", meaning: "喝（液体）", phonetic: "/ˈdɹɪŋk/"),
        .init(spelling: "see", meaning: "看见", phonetic: "/siː/"),
        .init(spelling: "hear", meaning: "听见", phonetic: "/ˈhɪə/"),
        .init(spelling: "speak", meaning: "说话", phonetic: "/spiːk/"),
        .init(spelling: "learn", meaning: "学习；获得知识或技能", phonetic: "/lɜːn/"),
        .init(spelling: "small", meaning: "小的（体积或尺寸）", phonetic: "/smɔːl/"),
        .init(spelling: "happy", meaning: "高兴的；快乐的", phonetic: "/ˈhæpi/")
    ]
}
