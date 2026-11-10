import Foundation

struct MiniReviewRecord: Codable, Sendable {
    let id: UUID
    var session: MiniReviewSession
    var paused: Bool
    var continuedToLearning: Bool
    let nextWordIndex: Int

    init(
        id: UUID = UUID(),
        session: MiniReviewSession,
        paused: Bool = false,
        continuedToLearning: Bool = false,
        nextWordIndex: Int
    ) {
        self.id = id
        self.session = session
        self.paused = paused
        self.continuedToLearning = continuedToLearning
        self.nextWordIndex = nextWordIndex
    }
}

struct MiniReviewStorage {
    private let directory: URL

    init(directory: URL? = nil) {
        self.directory = directory ?? URL.applicationSupportDirectory
            .appending(path: Bundle.main.bundleIdentifier ?? "com.lingoweave.mini", directoryHint: .isDirectory)
            .appending(path: "Review", directoryHint: .isDirectory)
    }

    private var currentFile: URL { directory.appending(path: "current.json") }

    func load() throws -> MiniReviewRecord? {
        try read(currentFile)
    }

    func save(_ record: MiniReviewRecord) throws {
        // Read the old record before replacing it so a damaged file stays available for recovery.
        _ = try load()
        try write(record, to: currentFile)
    }

    func archive(_ record: MiniReviewRecord) throws {
        let historyFile = directory.appending(path: "History", directoryHint: .isDirectory)
            .appending(path: "\(record.id.uuidString).json")
        if let existing = try read(historyFile) {
            guard existing.id == record.id else { throw CocoaError(.fileReadCorruptFile) }
            return
        }
        try write(record, to: historyFile)
    }

    private func read(_ file: URL) throws -> MiniReviewRecord? {
        let data: Data
        do {
            data = try Data(contentsOf: file)
        } catch let error as CocoaError where error.code == .fileReadNoSuchFile || error.code == .fileNoSuchFile {
            return nil
        }
        return try JSONDecoder().decode(MiniReviewRecord.self, from: data)
    }

    private func write(_ record: MiniReviewRecord, to file: URL) throws {
        let data = try JSONEncoder().encode(record)
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: file, options: .atomic)
    }
}
