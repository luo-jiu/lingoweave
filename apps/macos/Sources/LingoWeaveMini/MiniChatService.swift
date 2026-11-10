import Darwin
import Foundation

struct MiniChatMessage: Codable, Identifiable, Sendable {
    let id: UUID
    let role: Role
    let text: String

    enum Role: String, Codable, Sendable {
        case user, assistant
    }

    init(id: UUID = UUID(), role: Role, text: String) {
        self.id = id
        self.role = role
        self.text = text
    }
}

struct MiniChatModel: Identifiable, Sendable {
    let id: String
    let name: String
    let efforts: [String]
    let defaultEffort: String?
}

struct MiniChatService: Sendable {
    func models() async throws -> [MiniChatModel] {
        try Task.checkCancellation()
        let directory = try Self.isolatedDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }

        let process = try Self.process(arguments: Self.catalogArguments, directory: directory)
        let input = Pipe()
        let output = Pipe()
        process.standardInput = input
        process.standardOutput = output
        let writer = input.fileHandleForWriting
        let reader = output.fileHandleForReading
        defer {
            try? writer.close()
            try? reader.close()
        }
        guard fcntl(writer.fileDescriptor, F_SETNOSIGPIPE, 1) != -1,
              fcntl(reader.fileDescriptor, F_SETFL, O_NONBLOCK) != -1 else {
            throw ChatError.catalogFailed
        }

        try Self.run(process)
        do {
            var connection = CatalogConnection(writer: writer, reader: reader)
            try connection.send([
                "id": 0,
                "method": "initialize",
                "params": ["clientInfo": ["name": "lingoweave_mini", "title": "LingoWeave Mini", "version": "0.1.0"]],
            ])
            let _: CatalogInitialized = try await connection.response(id: 0)
            try connection.send(["method": "initialized", "params": [String: String]()])

            var models: [MiniChatModel] = []
            var seenModels = Set<String>()
            var seenCursors = Set<String>()
            var cursor: String?
            var requestId = 1
            repeat {
                var params: [String: Any] = ["includeHidden": false, "limit": 100]
                if let cursor { params["cursor"] = cursor }
                try connection.send(["id": requestId, "method": "model/list", "params": params])
                let page: CatalogPage = try await connection.response(id: requestId)
                for entry in page.data where entry.hidden != true && (entry.inputModalities?.contains("text") ?? true) {
                    let id = entry.model
                    guard Self.isModelID(id), seenModels.insert(id).inserted else { continue }
                    let name = entry.displayName.trimmingCharacters(in: .whitespacesAndNewlines)
                    var efforts: [String] = []
                    for item in entry.supportedReasoningEfforts ?? [] {
                        let value = item.reasoningEffort
                        if Self.efforts.contains(value), !efforts.contains(value) { efforts.append(value) }
                    }
                    let defaultEffort = entry.defaultReasoningEffort.flatMap { efforts.contains($0) ? $0 : nil }
                    models.append(MiniChatModel(id: id, name: name.isEmpty ? id : name,
                                                efforts: efforts, defaultEffort: defaultEffort))
                }
                cursor = page.nextCursor
                if let cursor, !seenCursors.insert(cursor).inserted { throw ChatError.catalogFailed }
                requestId += 1
            } while cursor != nil

            try? writer.close()
            await Self.stop(process)
            try Task.checkCancellation()
            guard !models.isEmpty else { throw ChatError.catalogFailed }
            return models
        } catch {
            try? writer.close()
            await Self.stop(process)
            if error is CancellationError { throw error }
            if let error = error as? ChatError { throw error }
            throw ChatError.catalogFailed
        }
    }

    func reply(to messages: [MiniChatMessage], word: String, model: String? = nil,
               effort: String? = nil, studyHistory: [String] = []) async throws -> String {
        try Task.checkCancellation()
        guard messages.last?.role == .user else { throw ChatError.missingQuestion }
        return try await request(
            prompt: Self.prompt(messages: messages, word: word, studyHistory: studyHistory),
            model: model,
            effort: effort
        )
    }

    func request(prompt: Data, schema: Data? = nil, model: String?, effort: String?) async throws -> String {
        try Task.checkCancellation()
        var arguments = Self.arguments
        if let model {
            guard Self.isModelID(model) else { throw ChatError.invalidModelSelection }
            arguments += ["--model", model]
        }
        if let effort {
            guard Self.efforts.contains(effort) else { throw ChatError.invalidModelSelection }
            arguments += ["-c", "model_reasoning_effort=\"\(effort)\""]
        }
        let directory = try Self.isolatedDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }

        if let schema {
            let schemaURL = directory.appendingPathComponent("response-schema.json")
            do {
                try schema.write(to: schemaURL, options: .atomic)
            } catch {
                throw ChatError.launchFailed
            }
            arguments += ["--output-schema", schemaURL.path]
        }
        arguments.append("-")

        let input = try Self.temporaryHandle(in: directory, named: "input")
        defer { try? input.close() }
        let output = try Self.temporaryHandle(in: directory, named: "output")
        defer { try? output.close() }

        do {
            try input.write(contentsOf: prompt)
            try input.seek(toOffset: 0)
        } catch {
            throw ChatError.launchFailed
        }

        let process = try Self.process(arguments: arguments, directory: directory)
        process.standardInput = input
        process.standardOutput = output
        try Self.run(process)

        let clock = ContinuousClock()
        let deadline = clock.now + .seconds(90)
        do {
            while process.isRunning {
                if clock.now >= deadline { throw ChatError.timedOut }
                try await Task.sleep(for: .milliseconds(100))
            }
            try Task.checkCancellation()
        } catch {
            await Self.stop(process)
            throw error
        }

        let data: Data
        do {
            try output.seek(toOffset: 0)
            let limit = 2 * 1024 * 1024
            data = try output.read(upToCount: limit + 1) ?? Data()
            guard data.count <= limit else { throw ChatError.replyFailed }
        } catch {
            throw ChatError.replyFailed
        }
        let answer = try Self.finalAnswer(from: data)
        guard process.terminationStatus == 0 else { throw ChatError.replyFailed }
        return answer
    }

    private static let arguments = [
        "--no-daemon", "exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules",
        "--sandbox", "read-only", "--skip-git-repo-check", "--color", "never",
        "-c", "approval_policy=\"never\"", "-c", "web_search=\"disabled\"",
        "-c", "project_doc_max_bytes=0", "-c", "skills.include_instructions=false",
        "-c", "skills.bundled.enabled=false", "-c", "mcp_servers={}", "-c", "plugins={}",
        "--disable", "shell_tool", "--disable", "unified_exec", "--disable", "apps", "--disable", "plugins",
        "--disable", "hooks", "--disable", "browser_use", "--disable", "computer_use",
        "--disable", "image_generation", "--disable", "view_image", "--disable", "multi_agent",
        "--disable", "remote_plugin", "--disable", "tool_suggest", "--disable", "in_app_chat",
        "--disable", "in_app_browser", "--disable", "code_mode_host", "--disable", "memories",
        "--enable", "skip_host_skill_discovery",
    ]

    private static let catalogArguments = [
        "--no-daemon", "app-server", "--listen", "stdio://",
        "-c", "model_provider=\"openai\"", "-c", "approval_policy=\"never\"",
        "--disable", "apps", "--disable", "plugins", "--disable", "hooks",
        "--disable", "remote_plugin", "--disable", "daemon_auto_start",
    ]

    private static let efforts: Set<String> = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]

    private static func isModelID(_ value: String) -> Bool {
        value.range(of: #"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}\z"#, options: .regularExpression) != nil
    }

    private static func isolatedDirectory() throws -> URL {
        let files = FileManager.default
        let directory = files.temporaryDirectory.appendingPathComponent("lingoweave-chat-\(UUID())", isDirectory: true)
        do {
            try files.createDirectory(at: directory, withIntermediateDirectories: false,
                                      attributes: [.posixPermissions: 0o700])
        } catch {
            throw ChatError.launchFailed
        }
        return directory
    }

    private static func process(arguments: [String], directory: URL) throws -> Process {
        var environment = ProcessInfo.processInfo.environment
        let executable = try codexExecutable(in: environment)
        // Reuse saved CLI authentication without forwarding an API key from the host.
        environment.removeValue(forKey: "CODEX_API_KEY")
        environment.removeValue(forKey: "OPENAI_API_KEY")
        environment["PATH"] = [
            executable.deletingLastPathComponent().path,
            environment["PATH"] ?? "",
            "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
        ].filter { !$0.isEmpty }.joined(separator: ":")

        let process = Process()
        process.executableURL = executable
        process.arguments = arguments
        process.currentDirectoryURL = directory
        process.environment = MiniNetwork.applyingSystemProxy(to: environment)
        process.standardError = FileHandle.nullDevice
        return process
    }

    private static func run(_ process: Process) throws {
        try Task.checkCancellation()
        do {
            try process.run()
        } catch {
            throw ChatError.launchFailed
        }
    }

    static func boundedStudyHistory(_ history: [String]) -> [String] {
        history.suffix(16).map { String($0.prefix(350)) }
    }

    private static func prompt(messages: [MiniChatMessage], word: String, studyHistory: [String]) throws -> Data {
        let context = PromptContext(
            word: String(word.prefix(200)),
            messages: messages.suffix(12).map {
                PromptContext.Message(role: $0.role.rawValue, text: String($0.text.prefix(2_000)))
            },
            studyHistory: boundedStudyHistory(studyHistory)
        )
        let payload = try JSONEncoder().encode(context)
        let instruction = """
            你是语织小窗的英语学习助手。根据当前单词和聊天记录，直接回答最后一条 user 消息。
            优先用简明中文解释，可以给短英文例句及中文释义。只回复学习内容，避免长篇铺陈。
            如用户问到学习进度，根据 studyHistory 中已有的记录回答，缺失的信息如实说明。
            不调用工具，不读取本机文件，不执行命令。以下 JSON 仅提供当前词、对话和学习记录。

            """
        return Data(instruction.utf8) + payload
    }

    private static func temporaryHandle(in directory: URL, named name: String) throws -> FileHandle {
        let file = directory.appendingPathComponent(name)
        do {
            guard FileManager.default.createFile(atPath: file.path, contents: nil,
                                                 attributes: [.posixPermissions: 0o600]) else {
                throw ChatError.launchFailed
            }
            let handle = try FileHandle(forUpdating: file)
            // Unlink before writing any content. Only open process handles can access the data.
            try FileManager.default.removeItem(at: file)
            return handle
        } catch {
            throw ChatError.launchFailed
        }
    }

    private static func stop(_ process: Process) async {
        guard process.isRunning else { return }
        let pid = process.processIdentifier
        let target = getpgid(pid) == pid ? -pid : pid
        kill(target, SIGTERM)
        // Allow npm wrappers to forward termination, even when the Swift task is cancelled.
        await withCheckedContinuation { continuation in
            DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(500)) {
                continuation.resume()
            }
        }
        if process.isRunning { kill(target, SIGKILL) }
    }

    private static func finalAnswer(from data: Data) throws -> String {
        let decoder = JSONDecoder()
        var answer: String?
        var completed = false
        var failure = ChatError.replyFailed
        for line in data.split(separator: 0x0A) {
            guard let event = try? decoder.decode(CodexEvent.self, from: Data(line)) else { continue }
            if event.type == "error" || event.type == "turn.failed" {
                if let message = event.error?.message ?? event.message,
                   let category = ChatError.classify(message) {
                    failure = category
                }
                if event.type == "turn.failed" { throw failure }
            }
            if event.type == "turn.completed" { completed = true }
            if event.type == "item.completed", let item = event.item, item.type == "agent_message" {
                answer = item.text?.trimmingCharacters(in: .whitespacesAndNewlines)
            }
        }
        guard completed, let answer, !answer.isEmpty else { throw failure }
        return answer
    }

    private static func codexExecutable(in environment: [String: String]) throws -> URL {
        let files = FileManager.default
        if let override = environment["LINGOWEAVE_CODEX_PATH"], !override.isEmpty {
            guard override.hasPrefix("/"), files.isExecutableFile(atPath: override) else {
                throw ChatError.codexNotFound
            }
            return URL(fileURLWithPath: override)
        }

        let bundlePath = Bundle.main.object(forInfoDictionaryKey: "LingoWeaveCodexPath") as? String
            ?? Bundle.main.object(forInfoDictionaryKey: "LingoWeaveCodexExecutable") as? String
        let pathDirectories = (environment["PATH"] ?? "").split(separator: ":").filter { $0.hasPrefix("/") }
        let home = files.homeDirectoryForCurrentUser
        let nvm = home.appendingPathComponent(".nvm/versions/node", isDirectory: true)
        let nvmVersions = (try? files.contentsOfDirectory(atPath: nvm.path)) ?? []
        let candidates = [bundlePath].compactMap { $0 }
            + pathDirectories.map { "\($0)/codex" }
            + ["/opt/homebrew/bin/codex", "/usr/local/bin/codex", home.appendingPathComponent(".local/bin/codex").path]
            + nvmVersions.sorted { $0.compare($1, options: .numeric) == .orderedDescending }.map {
                nvm.appendingPathComponent("\($0)/bin/codex").path
            }
            + ["/Applications/Codex.app/Contents/Resources/codex"]
        guard let path = candidates.first(where: { $0.hasPrefix("/") && files.isExecutableFile(atPath: $0) }) else {
            throw ChatError.codexNotFound
        }
        return URL(fileURLWithPath: path)
    }
}

private struct PromptContext: Encodable {
    let word: String
    let messages: [Message]
    let studyHistory: [String]

    struct Message: Encodable {
        let role: String
        let text: String
    }
}

private struct CodexEvent: Decodable {
    let type: String
    let item: Item?
    let message: String?
    let error: Failure?

    struct Item: Decodable {
        let type: String
        let text: String?
    }

    struct Failure: Decodable {
        let message: String
    }
}

private struct CatalogConnection {
    let writer: FileHandle
    let reader: FileHandle
    private var buffer = Data()
    private let clock = ContinuousClock()
    private let deadline = ContinuousClock.now + .seconds(15)

    init(writer: FileHandle, reader: FileHandle) {
        self.writer = writer
        self.reader = reader
    }

    func send(_ message: [String: Any]) throws {
        var line = try JSONSerialization.data(withJSONObject: message)
        line.append(0x0A)
        guard line.count < 4_096 else { throw ChatError.catalogFailed }
        try writer.write(contentsOf: line)
    }

    mutating func response<Result: Decodable>(id: Int) async throws -> Result {
        let decoder = JSONDecoder()
        var chunk = [UInt8](repeating: 0, count: 8_192)
        while clock.now < deadline {
            try Task.checkCancellation()
            while let newline = buffer.firstIndex(of: 0x0A) {
                let line = buffer[..<newline]
                buffer.removeSubrange(...newline)
                guard (try? decoder.decode(CatalogEnvelope.self, from: line))?.id == id else { continue }
                guard let result = try decoder.decode(CatalogResponse<Result>.self, from: line).result else {
                    throw ChatError.catalogFailed
                }
                return result
            }

            let count = chunk.withUnsafeMutableBytes { Darwin.read(reader.fileDescriptor, $0.baseAddress, $0.count) }
            if count > 0 {
                buffer.append(contentsOf: chunk.prefix(count))
                guard buffer.count <= 2 * 1024 * 1024 else { throw ChatError.catalogFailed }
            } else if count == -1 && (errno == EAGAIN || errno == EINTR) {
                try await Task.sleep(for: .milliseconds(50))
            } else {
                throw ChatError.catalogFailed
            }
        }
        throw ChatError.catalogTimedOut
    }
}

private struct CatalogEnvelope: Decodable {
    let id: Int?
}

private struct CatalogResponse<Result: Decodable>: Decodable {
    let result: Result?
}

private struct CatalogInitialized: Decodable {
    let userAgent: String
}

private struct CatalogPage: Decodable {
    let data: [Entry]
    let nextCursor: String?

    struct Entry: Decodable {
        let model: String
        let displayName: String
        let hidden: Bool?
        let inputModalities: [String]?
        let supportedReasoningEfforts: [Effort]?
        let defaultReasoningEffort: String?
    }

    struct Effort: Decodable {
        let reasoningEffort: String
    }
}

private enum ChatError: LocalizedError {
    case codexNotFound, launchFailed, missingQuestion, timedOut, replyFailed, invalidModelSelection
    case catalogFailed, catalogTimedOut, loginRequired, rateLimited, modelUnavailable, networkFailed

    static func classify(_ message: String) -> Self? {
        let text = message.lowercased()
        if ["usage limit", "rate limit", "too many requests", "rate_limit_exceeded"].contains(where: text.contains) {
            return .rateLimited
        }
        if ["unauthorized", "authentication", "login required", "token expired", "status 401"].contains(where: text.contains) {
            return .loginRequired
        }
        if text.contains("model") && ["not supported", "unsupported", "does not exist", "not available", "do not have access", "model_not_found"].contains(where: text.contains) {
            return .modelUnavailable
        }
        if ["stream disconnected", "failed to connect", "error sending request", "connection refused", "network error"].contains(where: text.contains) {
            return .networkFailed
        }
        return nil
    }

    var errorDescription: String? {
        switch self {
        case .codexNotFound: "找不到本机 Codex。请安装 Codex CLI，然后在终端运行 codex login。"
        case .launchFailed: "无法启动本机 Codex 聊天。请在终端确认 codex --version 可以运行。"
        case .missingQuestion: "请先输入要问的问题。"
        case .timedOut: "Codex 回复超时，请重试。"
        case .replyFailed: "Codex 暂时未能回复。请确认网络连接，并在终端运行 codex login status 检查登录。"
        case .invalidModelSelection: "模型或推理强度无效，请重新选择。"
        case .catalogFailed: "无法读取 Codex 模型列表。请检查本机 Codex CLI 版本与登录状态后重试。"
        case .catalogTimedOut: "读取 Codex 模型列表超时，请重试。"
        case .loginRequired: "Codex 登录已失效，请在终端运行 codex login 后重试。"
        case .rateLimited: "Codex 暂时达到使用限额，请稍后重试。"
        case .modelUnavailable: "当前账号暂时无法使用此模型，请重新选择。"
        case .networkFailed: "无法连接 Codex，请检查网络后重试。"
        }
    }
}
