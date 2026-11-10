import Foundation

struct MiniChatStorage {
    private let file: URL

    init() {
        file = URL.applicationSupportDirectory
            .appending(path: Bundle.main.bundleIdentifier ?? "com.lingoweave.mini", directoryHint: .isDirectory)
            .appending(path: "StudyChat.json")
    }

    func load() throws -> [MiniWord: [MiniChatMessage]] {
        do {
            return try JSONDecoder().decode([MiniWord: [MiniChatMessage]].self, from: Data(contentsOf: file))
        } catch let error as CocoaError where error.code == .fileReadNoSuchFile || error.code == .fileNoSuchFile {
            return [:]
        }
    }

    func save(_ chats: [MiniWord: [MiniChatMessage]]) throws {
        _ = try load()
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(chats).write(to: file, options: .atomic)
    }
}
