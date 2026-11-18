import SwiftUI

/// This view only observes durable jobs; leaving home does not cancel evaluation.
struct MiniAssessmentHomeView: View {
    let client: MiniAssessmentClient?
    var preview: MiniAssessmentSnapshot? = nil
    var previewDetail: MiniAssessmentDetail? = nil
    var didUpdate: (() async -> Void)? = nil
    @State private var snapshot: MiniAssessmentSnapshot?
    @State private var detail: MiniAssessmentDetail?
    @State private var expanded = false
    @State private var error: String?
    @State private var loadingDetail = false
    @State private var retryRequests: [UUID: UUID] = [:]
    @State private var retrying: Set<UUID> = []

    var body: some View {
        Group {
            if let snapshot, !snapshot.jobs.isEmpty {
                DisclosureGroup(isExpanded: $expanded) {
                    VStack(alignment: .leading, spacing: 7) {
                        ForEach(snapshot.jobs) { job in
                            HStack(spacing: 6) {
                                Button(job.word.spelling) { loadDetail(job.id) }
                                    .buttonStyle(.plain).foregroundStyle(Color.accentColor)
                                Spacer(minLength: 3)
                                Text(job.status.label).foregroundStyle(.secondary)
                                if job.status == .failed {
                                    Button("重试") { retry(job.id) }.disabled(retrying.contains(job.id))
                                }
                            }
                            if job.status == .failed, let error = job.error {
                                Text(error).foregroundStyle(.secondary).textSelection(.enabled)
                            }
                        }
                        if loadingDetail { ProgressView().controlSize(.mini) }
                        if let detail { audit(detail) }
                    }
                    .padding(.top, 4)
                } label: {
                    HStack(spacing: 6) {
                        Text("学习评价")
                        Spacer(minLength: 3)
                        if snapshot.processingCount > 0 {
                            Text("\(snapshot.processingCount) 词处理中").foregroundStyle(.secondary)
                            ProgressView().controlSize(.mini)
                        } else { Text("查看记录").foregroundStyle(.secondary) }
                        if snapshot.failedCount > 0 {
                            Text("\(snapshot.failedCount) 词待重试").foregroundStyle(.orange)
                        }
                    }
                }
                .font(.caption)
                .accessibilityIdentifier("homeAssessments")
            }
            if let error { Text(error).font(.caption2).foregroundStyle(.secondary) }
        }
        .task {
            if let preview { snapshot = preview; return }
            while !Task.isCancelled {
                await refresh()
                do { try await Task.sleep(for: .seconds(3)) } catch { return }
            }
        }
    }

    private func audit(_ detail: MiniAssessmentDetail) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Divider()
            HStack {
                Text(detail.job.word.spelling).font(.subheadline.weight(.semibold))
                Spacer()
                Button("收起") { self.detail = nil }.buttonStyle(.plain)
            }
            Text(detail.source.question.direction == .englishToChinese ? detail.source.question.english : detail.source.question.chinese)
            Text("原答：" + detail.source.answer)
            if let application = detail.application {
                Text(application.result.summary)
                Text("词义：" + application.result.meaning.explanation)
                Text("拼写：" + application.result.spelling.explanation)
                Text("用法：" + application.result.usage.explanation)
                if !application.result.referenceTranslation.isEmpty {
                    Text("参考：" + application.result.referenceTranslation)
                }
                if !application.result.uncertainties.isEmpty {
                    Text(application.result.uncertainties.joined(separator: "；")).foregroundStyle(.secondary)
                }
                Text(application.trace.model + " · " + application.trace.rulesVersion).foregroundStyle(.secondary)
            }
            if let receipt = detail.job.receipt {
                Text(receipt.reason)
                if let date = receipt.scheduling.afterDueAt {
                    HStack(spacing: 4) {
                        Text("下次复习")
                        if let previous = receipt.scheduling.beforeDueAt {
                            Text(previous, style: .date)
                            Text("→")
                        }
                        Text(date, style: .date)
                    }
                }
            }
            if !detail.source.discussion.isEmpty {
                DisclosureGroup("当时的讨论") {
                    ForEach(detail.source.discussion) { message in
                        Text((message.role == "user" ? "我：" : "AI：") + message.text)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }
        .textSelection(.enabled)
        .accessibilityIdentifier("assessmentAudit")
    }

    @MainActor
    private func refresh() async {
        guard let client else { return }
        do {
            let next = try await client.snapshot()
            let changed = snapshot != nil && next.jobs.map(\.updatedAt) != snapshot?.jobs.map(\.updatedAt)
            snapshot = next
            if let shown = detail, let updated = next.jobs.first(where: { $0.id == shown.job.id }),
               updated.updatedAt != shown.job.updatedAt {
                detail = try await client.detail(shown.job.id)
            }
            error = nil
            if changed { await didUpdate?() }
        } catch is CancellationError { return }
        catch { self.error = "学习评价记录暂时无法读取。" }
    }

    private func loadDetail(_ id: UUID) {
        guard let client else { detail = previewDetail; return }
        loadingDetail = true
        Task { @MainActor in
            defer { loadingDetail = false }
            do { detail = try await client.detail(id); error = nil }
            catch { self.error = "评价详情暂时无法读取，请重试。" }
        }
    }

    private func retry(_ id: UUID) {
        guard let client else { error = "开发预览：正式任务可在这里重试，原答会保留。"; return }
        let request = retryRequests[id] ?? UUID()
        retryRequests[id] = request
        retrying.insert(id)
        Task { @MainActor in
            defer { retrying.remove(id) }
            do {
                _ = try await client.retry(id, requestId: request)
                retryRequests.removeValue(forKey: id)
                await refresh()
            } catch { self.error = "重试请求暂未确认，再次点击会安全重试。" }
        }
    }
}
