import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  miniAssessmentCommitSchema,
  miniAssessmentReceiptSchema,
  type MiniAssessmentApplication,
  type MiniAssessmentReceipt,
  type MiniAssessmentSource,
} from '@lingoweave/contracts';
import { LearningError } from './learning-store.js';
import { CodexError } from './codex/transport.js';
import type { PreparationRuntime } from './preparation-service.js';
import { MiniAssessmentStore, miniAssessmentHash } from './mini-assessment-store.js';
import { swiftTime } from './mini-study.js';

export interface MiniAssessmentRepository {
  pending(): MiniAssessmentSource[];
  get(id: string): MiniAssessmentSource | undefined;
  apply(application: MiniAssessmentApplication): MiniAssessmentReceipt;
}

const model = 'gpt-6.1-sol';
const effort = 'xhigh';
const rulesVersion = 'mini-assessment-v1';
const prompt =
  'This is a background learning assessment, not a learner conversation. Read learning_get_assessment and evaluate the frozen original answer with the referenced learning evidence. Call learning_submit_assessment once with the exact sourceId and inputHash. Assess meaning, target spelling, and use separately. Cite source evidence identifiers and give concise Chinese reasons. Do not request learner input or change scheduling.';
const instructions =
  '只使用本任务冻结的原题、原答、学习事实和相关讨论。答后讨论不是首答；参考译法不是唯一答案。无法测到目标词时标记not_tested，目标判定存在真实歧义或缺失证据才用uncertain。近期学习、支持、eligibility=false、不能证明长期掌握都不是语义或拼写不确定，应在explanation中说明并由程序处理资格；不得因此填写uncertainties。uncertainties非空必须对应至少一个uncertain维度；如果三个维度都明确或not_tested，uncertainties必须为空。英译中没有英文产出时拼写与英文运用not_tested。保留原答中可明确判断的目标词拼写错误，其他词或风格问题不等于目标词遗忘。提交结构化评价，不给due、掌握或完成命令，不输出隐式推理。后台工作不向翻译页或聊天发送进度。';

function failure(error: unknown) {
  return error instanceof LearningError || error instanceof CodexError
    ? error.message
    : '评价暂未完成，原答案与已完成学习已保存，可在首页重试。';
}

function evidenceIds(source: MiniAssessmentSource): Set<string> {
  const ids = new Set([
    source.attemptId,
    source.question.id,
    ...source.discussion.map((message) => message.id),
  ]);
  const visit = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value !== null && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (key === 'id' && typeof child === 'string') ids.add(child);
        visit(child);
      }
    }
  };
  visit(source.learningEvidence);
  return ids;
}

export class MiniAssessmentService {
  private baseUrl: string | null = null;
  private closing = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly active = new Map<
    string,
    {
      token: string;
      controller: AbortController;
      promise: Promise<void>;
      readHash: string | null;
      startedAt: number;
      threadId: string | null;
      skillHash: string;
    }
  >();

  constructor(
    readonly repository: MiniAssessmentRepository,
    readonly store: MiniAssessmentStore,
    private readonly runtime: PreparationRuntime,
    private readonly now: () => Date = () => new Date(),
  ) {
    // A persisted candidate is reapplied with the same request identity before
    // another model call. A process crash never becomes another learner answer.
    for (const detail of store.all()) {
      if (detail.job.status === 'running') store.status(detail.job.id, 'queued');
    }
  }

  setBaseUrl(url: string) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1')
      throw new LearningError('ASSESSMENT_URL_INVALID', '评价服务仅支持本机接口。');
    this.baseUrl = url;
    this.wake();
    if (!this.timer) {
      this.timer = setInterval(() => {
        try {
          this.wake();
        } catch {
          /* The durable learning outbox remains pending. */
        }
      }, 5000);
      this.timer.unref();
    }
  }

  wake() {
    if (this.closing || !this.baseUrl) return;
    for (const source of this.repository.pending()) this.store.ensure(source);
    this.drain();
  }
  snapshot() {
    return this.store.snapshot();
  }
  detail(id: string) {
    return this.store.detail(id);
  }
  retry(input: { requestId: string; jobId: string }) {
    const job = this.store.retry(input);
    this.drain();
    return job;
  }

  private drain() {
    if (this.closing || !this.baseUrl || this.active.size >= 1) return;
    const next = this.store.all().find((detail) => detail.job.status === 'queued');
    if (!next) return;
    const id = next.job.id;
    const token = randomBytes(32).toString('hex');
    const controller = new AbortController();
    const promise = Promise.resolve().then(() => this.run(id, controller));
    this.active.set(id, {
      token,
      controller,
      promise,
      readHash: null,
      startedAt: swiftTime(this.now()),
      threadId: null,
      skillHash: '',
    });
    const finish = () => {
      this.active.delete(id);
      this.drain();
    };
    void promise.then(finish, finish);
  }

  private applySaved(id: string): boolean {
    const detail = this.store.detail(id);
    if (!detail.application) return false;
    const receipt = miniAssessmentReceiptSchema.parse(this.repository.apply(detail.application));
    this.store.complete(id, receipt);
    return true;
  }

  private async run(id: string, controller: AbortController) {
    try {
      if (controller.signal.aborted) return;
      if (this.applySaved(id)) return;
      this.store.status(id, 'running');
      const status = await this.runtime.status();
      if (controller.signal.aborted) return;
      if (!status.available || !status.authenticated)
        throw new LearningError('CODEX_UNAVAILABLE', status.error ?? '请先在本机 Codex 完成登录。');
      const selected = status.models.find((item) => item.id === model);
      if (!selected)
        throw new LearningError('MODEL_UNAVAILABLE', '所选评价模型当前不可用，未更换模型。');
      if (!selected.supportedReasoningEfforts?.includes(effort))
        throw new LearningError('EFFORT_UNAVAILABLE', '所选评价模型不支持 xhigh，已保留原配置。');
      const active = this.active.get(id);
      if (!active) return;
      const compiled = import.meta.url.endsWith('.js');
      const entry = fileURLToPath(
        new URL(
          compiled ? './mini-assessment-mcp.js' : './mini-assessment-mcp.ts',
          import.meta.url,
        ),
      );
      const skillPath = fileURLToPath(
        new URL('../../../skills/mini-feedback/SKILL.md', import.meta.url),
      );
      active.skillHash = miniAssessmentHash(readFileSync(skillPath, 'utf8'));
      const result = await this.runtime.prepare({
        jobId: id,
        model,
        effort,
        tools: ['learning_get_assessment', 'learning_submit_assessment'],
        prompt,
        instructions,
        skill: { name: 'mini-feedback', path: skillPath },
        mcp: {
          command: process.execPath,
          args: compiled ? [entry] : ['--import', import.meta.resolve('tsx'), entry],
          env: {
            LINGOWEAVE_MINI_ASSESSMENT_URL: `${this.baseUrl}/api/internal/mini-assessment/${id}`,
            LINGOWEAVE_MINI_ASSESSMENT_TOKEN: active.token,
          },
        },
        onThread: (thread) => {
          if (thread.model !== model)
            throw new LearningError('MODEL_UNAVAILABLE', '评价运行时替换了所选模型，结果未采用。');
          active.threadId = thread.threadId;
        },
        onProgress: () => {},
        onText: () => {},
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (result.model !== model)
        throw new LearningError('MODEL_UNAVAILABLE', '评价运行时替换了所选模型，结果未采用。');
      if (this.store.detail(id).job.status !== 'completed' && !this.applySaved(id))
        throw new LearningError('ASSESSMENT_RESULT_MISSING', '模型未提交有效评价，可在首页重试。');
    } catch (error) {
      // A tool may have committed before the runtime failed to produce its final text.
      if (this.store.detail(id).job.status !== 'completed')
        this.store.status(
          id,
          controller.signal.aborted ? 'queued' : 'failed',
          controller.signal.aborted ? null : failure(error),
        );
    }
  }

  tool(id: string, token: string, action: string, raw: unknown) {
    const active = this.active.get(id);
    if (!active || active.token !== token || active.controller.signal.aborted || this.closing)
      throw new LearningError('ASSESSMENT_TASK_EXPIRED', '评价任务已失效。', 403);
    const detail = this.store.detail(id);
    if (detail.job.status !== 'running' && detail.job.status !== 'completed')
      throw new LearningError('ASSESSMENT_TASK_EXPIRED', '评价任务已停止。', 403);
    const hash = miniAssessmentHash(detail.source);
    const source = this.repository.get(detail.source.id);
    if (!source || miniAssessmentHash(source) !== hash)
      throw new LearningError('ASSESSMENT_SOURCE_CHANGED', '评价原始证据不再可用。', 409);
    if (action === 'context') {
      active.readHash = hash;
      return {
        source: detail.source,
        inputHash: hash,
        rulesVersion,
        evidenceIds: [...evidenceIds(detail.source)],
        evidenceGuidance:
          'Cite the original attemptId, discussion message ids, or ids in learningEvidence. Only original answer content establishes answer correctness; later discussion is teaching.',
      };
    }
    if (action !== 'commit')
      throw new LearningError('ASSESSMENT_TOOL_INVALID', '未知评价工具。', 400);
    if (active.readHash !== hash)
      throw new LearningError('ASSESSMENT_CONTEXT_REQUIRED', '请先读取本次冻结的评价证据。');
    const input = miniAssessmentCommitSchema.parse(raw);
    if (
      input.result.uncertainties.length > 0 &&
      ![input.result.meaning, input.result.spelling, input.result.usage].some(
        (observation) => observation.outcome === 'uncertain',
      )
    )
      throw new LearningError(
        'ASSESSMENT_UNCERTAINTY_SCOPE',
        '三个维度均明确或未测到，却填写了全局不确定项。近期曝光、支持条件或不能证明长期保持请写入explanation，不属于目标判定歧义；此时uncertainties应为空。若确有题干冲突或证据缺失，请将受影响维度标记uncertain并说明实际问题。此次结果尚未保存，请修正后重新提交。',
        400,
      );
    if (input.result.sourceId !== source.id || input.result.inputHash !== hash)
      throw new LearningError(
        'ASSESSMENT_TARGET_INVALID',
        '不能评价另一份原答或其他版本的证据。',
        403,
      );
    const available = evidenceIds(source);
    for (const observation of [input.result.meaning, input.result.spelling, input.result.usage]) {
      if (
        observation.evidenceIds.some((evidenceId) => !available.has(evidenceId)) ||
        ((observation.outcome === 'correct' || observation.outcome === 'incorrect') &&
          observation.evidenceIds.length === 0)
      )
        throw new LearningError(
          'ASSESSMENT_EVIDENCE_INVALID',
          '评价必须引用这份原始记录中存在的证据。',
          400,
        );
    }
    this.store.saveApplication(
      {
        requestId: id,
        source: detail.source,
        result: input.result,
        trace: {
          model,
          effort,
          rulesVersion,
          threadId: active.threadId,
          skillHash: active.skillHash,
          promptHash: miniAssessmentHash({ prompt, instructions }),
          inputHash: hash,
          startedAt: active.startedAt,
          assessedAt: swiftTime(this.now()),
        },
      },
      input.requestId,
    );
    this.applySaved(id);
    return { saved: true, jobId: id, receipt: this.store.detail(id).job.receipt };
  }

  async close() {
    if (this.closing) return;
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    for (const active of this.active.values()) active.controller.abort();
    await Promise.allSettled([...this.active.values()].map((active) => active.promise));
    await this.runtime.close();
    this.store.close();
  }
}
