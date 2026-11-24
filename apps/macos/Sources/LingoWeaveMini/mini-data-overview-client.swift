import Foundation

struct MiniDataOverview: Decodable, Sendable {
    struct Learning: Decodable, Sendable {
        let completedWords: Int
        let reviewVisits: Int
        let studyDays: Int
        let events: Int
        let translations: Int
    }

    struct AI: Decodable, Sendable {
        let conversations: Int
        let messages: Int
        let completedAssessments: Int
        let pendingAssessments: Int
        let failedAssessments: Int
    }

    struct Audio: Decodable, Sendable {
        let wordAssets: Int
        let sentenceAssets: Int
        let currentAssets: Int
        let previousAssets: Int
        let missingFiles: Int
        let unreferencedFiles: Int
        let pendingJobs: Int
        let failedJobs: Int
    }

    struct Vocabulary: Decodable, Sendable {
        let books: Int
        let entries: Int
    }

    enum StorageKind: String, Decodable, Sendable {
        case learning, ai, audioIndex, audioFiles, vocabulary, materials, serviceLog, other
    }

    struct Storage: Decodable, Sendable, Identifiable {
        let kind: StorageKind
        let bytes: Int64
        var id: StorageKind { kind }
    }

    let schemaVersion: Int
    let asOf: Date
    let dataPath: String
    let learning: Learning
    let ai: AI
    let audio: Audio
    let vocabulary: Vocabulary
    let storage: [Storage]
}

struct MiniDataOverviewClient: Sendable {
    let study: MiniStudyClient

    func overview() async throws -> MiniDataOverview {
        let snapshot: MiniDataOverview = try await study.serviceRequest(path: "data-overview", body: nil)
        guard snapshot.schemaVersion == 1, snapshot.dataPath.hasPrefix("/") else {
            throw MiniStudyClientError.invalidResponse
        }
        return snapshot
    }
}
