import Foundation
import CryptoKit

enum MiniVocabularyOrder: String, Codable, CaseIterable, Identifiable, Sendable {
    case random, source

    var id: String { rawValue }
    var label: String { self == .random ? "乱序" : "顺序" }
}

struct MiniVocabularyDeck: Decodable, Sendable, Identifiable {
    let id: String
    let name: String
    let wordCount: Int
    let level: String?
    let bookId: String?
}

struct MiniVocabularyBookLevel: Decodable, Sendable, Identifiable {
    var id: String { level }
    let level: String
    let deckId: String
    let wordCount: Int
}

struct MiniVocabularyBook: Decodable, Sendable, Identifiable {
    let id: String
    let name: String
    let wordCount: Int
    let levels: [MiniVocabularyBookLevel]

    func deckId(for level: String?) -> String {
        guard let level else { return id }
        return levels.first { $0.level == level }?.deckId ?? id
    }
}

struct MiniVocabularySource: Decodable, Sendable, Identifiable {
    let id: String
    let title: String
    let url: String
    let version: String
    let license: String
}

struct MiniVocabularyCatalog: Decodable, Sendable {
    let schemaVersion: Int
    let revision: Int
    let activeDeckId: String?
    let activeOrder: MiniVocabularyOrder
    let books: [MiniVocabularyBook]
    let decks: [MiniVocabularyDeck]
    let activeWords: [MiniWord]
    let sources: [MiniVocabularySource]

    var activeDeck: MiniVocabularyDeck? { decks.first { $0.id == activeDeckId } }
    var activeBook: MiniVocabularyBook? {
        books.first { book in
            book.id == activeDeckId || book.levels.contains { $0.deckId == activeDeckId }
        }
    }
    var activeSelectionDetail: String? {
        guard activeBook != nil else { return nil }
        return (activeDeck?.level ?? "全部") + " · " + activeOrder.label
    }

    var activeSelectionName: String? {
        guard let book = activeBook, let detail = activeSelectionDetail else { return activeDeck?.name }
        return book.name + " · " + detail
    }

    func orderedCustomWords(_ words: [MiniWord]) -> [MiniWord] {
        guard activeOrder == .random else { return words }
        let keyed: [(word: MiniWord, key: String, offset: Int)] = words.enumerated().map { offset, word in
            let spelling = word.spelling.precomposedStringWithCompatibilityMapping
                .trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            let meaning = word.meaning.precomposedStringWithCompatibilityMapping
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let spellingKey = "\(spelling.utf8.count):" + spelling
            let meaningKey = "\(meaning.utf8.count):" + meaning
            let identity = "mini-custom-vocabulary-order-v1:" + spellingKey + meaningKey
            let digest = SHA256.hash(data: Data(identity.utf8)).map { String(format: "%02x", $0) }.joined()
            return (word: word, key: digest, offset: offset)
        }
        return keyed.sorted { left, right in
            left.key == right.key ? left.offset < right.offset : left.key < right.key
        }.map(\.word)
    }

    private enum CodingKeys: String, CodingKey {
        case schemaVersion, revision, activeDeckId, activeOrder, books, decks, activeWords, sources
    }

    init(from decoder: any Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try values.decode(Int.self, forKey: .schemaVersion)
        revision = try values.decode(Int.self, forKey: .revision)
        activeDeckId = try values.decodeIfPresent(String.self, forKey: .activeDeckId)
        activeOrder = try values.decodeIfPresent(MiniVocabularyOrder.self, forKey: .activeOrder) ?? .random
        let decodedDecks = try values.decode([MiniVocabularyDeck].self, forKey: .decks)
        decks = decodedDecks
        activeWords = try values.decode([MiniWord].self, forKey: .activeWords)
        sources = try values.decode([MiniVocabularySource].self, forKey: .sources)
        if let decodedBooks = try values.decodeIfPresent([MiniVocabularyBook].self, forKey: .books) {
            books = decodedBooks
        } else {
            // Earlier catalogs used the full deck ID as the book ID and explicit level suffixes.
            books = decodedDecks.filter { $0.level == nil }.map { full in
                let levels = decodedDecks.compactMap { deck -> MiniVocabularyBookLevel? in
                    guard let level = deck.level,
                          deck.id == full.id + "-" + level.lowercased() else { return nil }
                    return MiniVocabularyBookLevel(level: level, deckId: deck.id, wordCount: deck.wordCount)
                }
                return MiniVocabularyBook(id: full.id, name: full.name, wordCount: full.wordCount, levels: levels)
            }
        }
        var claimedDecks = Set<String>()
        var validBooks = Set(books.map(\.id)).count == books.count && Set(decks.map(\.id)).count == decks.count
        for book in books {
            guard let full = decks.first(where: { $0.id == book.id }), full.level == nil,
                  full.wordCount == book.wordCount, full.bookId == nil || full.bookId == book.id else {
                throw DecodingError.dataCorruptedError(forKey: .books, in: values, debugDescription: "Book has no matching full deck")
            }
            validBooks = claimedDecks.insert(full.id).inserted && validBooks
            validBooks = Set(book.levels.map(\.level)).count == book.levels.count && validBooks
            for level in book.levels {
                guard let deck = decks.first(where: { $0.id == level.deckId }), deck.level == level.level,
                      deck.wordCount == level.wordCount, deck.bookId == nil || deck.bookId == book.id else {
                    throw DecodingError.dataCorruptedError(forKey: .books, in: values, debugDescription: "Book level has no matching deck")
                }
                validBooks = claimedDecks.insert(deck.id).inserted && validBooks
            }
        }
        guard validBooks, claimedDecks.count == decks.count else {
            throw DecodingError.dataCorruptedError(forKey: .books, in: values, debugDescription: "Book and deck relationships are inconsistent")
        }
    }
}

struct MiniVocabularyActivation: Codable, Sendable {
    let requestId: UUID
    let expectedRevision: Int
    let deckId: String?
    let order: MiniVocabularyOrder?

    init(requestId: UUID = UUID(), expectedRevision: Int, deckId: String?, order: MiniVocabularyOrder? = nil) {
        self.requestId = requestId
        self.expectedRevision = expectedRevision
        self.deckId = deckId
        self.order = order
    }

    private enum CodingKeys: String, CodingKey { case requestId, expectedRevision, deckId, order }
    func encode(to encoder: any Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(requestId.uuidString.lowercased(), forKey: .requestId)
        try values.encode(expectedRevision, forKey: .expectedRevision)
        try values.encode(deckId, forKey: .deckId)
        try values.encodeIfPresent(order, forKey: .order)
    }
}

struct MiniVocabularyClient: Sendable {
    private let study: MiniStudyClient
    init(study: MiniStudyClient = MiniStudyClient()) { self.study = study }
    private var pendingFile: URL { study.recoveryDirectory.appending(path: "vocabulary-pending.json") }

    func catalog() async throws -> MiniVocabularyCatalog {
        let value: MiniVocabularyCatalog = try await study.serviceRequest(path: "vocabulary/catalog", body: nil)
        return try validated(value)
    }

    func activate(_ request: MiniVocabularyActivation) async throws -> MiniVocabularyCatalog {
        let value: MiniVocabularyCatalog = try await study.serviceRequest(path: "vocabulary/activate", body: JSONEncoder().encode(request))
        return try validated(value)
    }

    private func validated(_ value: MiniVocabularyCatalog) throws -> MiniVocabularyCatalog {
        guard value.schemaVersion == 1, value.activeDeckId == nil || (!value.activeWords.isEmpty && value.activeDeck != nil) else {
            throw MiniStudyClientError.invalidResponse
        }
        return value
    }

    func pending() throws -> MiniVocabularyActivation? {
        do { return try JSONDecoder().decode(MiniVocabularyActivation.self, from: Data(contentsOf: pendingFile)) }
        catch let error as CocoaError where error.code == .fileReadNoSuchFile || error.code == .fileNoSuchFile { return nil }
    }

    func savePending(_ request: MiniVocabularyActivation) throws {
        try FileManager.default.createDirectory(at: study.recoveryDirectory, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        try JSONEncoder().encode(request).write(to: pendingFile, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: pendingFile.path)
    }

    func clearPending(_ requestId: UUID) throws {
        guard let request = try pending(), request.requestId == requestId else { return }
        try FileManager.default.removeItem(at: pendingFile)
    }
}
