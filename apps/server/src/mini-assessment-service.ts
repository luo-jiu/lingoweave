import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  assessmentMcp,
  feedbackSkill,
  type MiniExpressionGrades,
} from './mini-expression-grades.js';
import {
  defaultMiniAiSelection,
  miniAssessmentCommitSchema,
  miniAssessmentReceiptSchema,
  type MiniAssessmentApplication,
  type MiniAssessmentReceipt,
  type MiniAssessmentSource,
} from '@lingoweave/contracts';
import { translationRubric, validateTranslationGrade } from './mini-translation-rubric.js';
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

const rulesVersion = 'mini-assessment-v1';
const prompt =
  'Read learning_get_assessment and evaluate the assigned frozen version of the translation. Submit one learning_submit_assessment with its exact sourceId and inputHash. Judge the entire translation in source.answer for expressionGrade independently of the target-word observations. The learner will read this grade, summary, strengths, improvements and referenceTranslation together with this version of their answer. Explain the wording in beginner-friendly Chinese, offering a specific revision where helpful. If one reusable English expression from this question or feedback would help the learner, include reusablePhrase with its Chinese explanation. Keep evidence about meaning, spelling and use in the separate internal observations with evidence identifiers. Do not request learner input or change scheduling.';
const instructions =
  translationRubric +
  '只使用本任务冻结的原题、待评价版本的译文、学习事实和相关讨论。selfReportedFamiliar 表示学习者在完整词卡上点了「已认识」。这次自报跳过了后续两次回忆，判断该词的掌握表现须看实际拼写首答、订正和翻译原答。答后讨论不是首答；参考译法不是唯一答案。无法测到目标词时标记not_tested，目标判定存在真实歧义或缺失证据才用uncertain。近期学习、支持、eligibility=false、不能证明长期掌握都不是语义或拼写不确定，应在explanation中说明并由程序处理资格；不得因此填写uncertainties。uncertainties非空必须对应至少一个uncertain维度；如果三个维度都明确或not_tested，uncertainties必须为空。英译中没有英文产出时拼写与英文运用not_tested。保留本版译文中可明确判断的目标词拼写错误，其他词或风格问题不等于目标词遗忘。提交结构化评价，不给due、掌握或完成命令，不输出隐式推理。后台工作不向翻译页或聊天发送进度。';

function failure(error: unknown) {
  return error instanceof LearningError || error instanceof CodexError
    ? error.message
    : '评价暂未完成，原答案与已完成学习已保存，可在首页重试。';
}

function instructionsFor(source: MiniAssessmentSource) {
  if (source.id === source.attemptId) return instructions;
  return (
    instructions +
    '本任务评价修改稿：只按 source.answer 的当前文字给出表达档次、优点和改进建议；首答仅作背景。这份点评不调整复习排期。请用 source.id 引用本稿。'
  );
}

function evidenceIds(source: MiniAssessmentSource): Set<string> {
  const ids = new Set([
    source.id,
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
  readonly expressions: MiniExpressionGrades;
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
    this.expressions = store.expressionGrades(runtime);
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
    this.expressions.setBaseUrl(url);
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
      const { source } = this.store.detail(id);
      const { model, effort } = source.aiSelection ?? defaultMiniAiSelection;
      this.store.status(id, 'running');
      const status = await this.runtime.status();
      if (controller.signal.aborted) return;
      if (!status.available || !status.authenticated)
        throw new LearningError('CODEX_UNAVAILABLE', status.error ?? '请先在本机 Codex 完成登录。');
      const selected = status.models.find((item) => item.id === model);
      if (!selected)
        throw new LearningError('MODEL_UNAVAILABLE', '所选评价模型当前不可用，未更换模型。');
      if (!selected.supportedReasoningEfforts?.includes(effort))
        throw new LearningError(
          'EFFORT_UNAVAILABLE',
          `所选评价模型不支持 ${effort}，已保留原配置。`,
        );
      const active = this.active.get(id);
      if (!active || !this.baseUrl) return;
      active.skillHash = miniAssessmentHash(readFileSync(feedbackSkill.path, 'utf8'));
      const result = await this.runtime.prepare({
        jobId: id,
        model,
        effort,
        tools: ['learning_get_assessment', 'learning_submit_assessment'],
        prompt,
        instructions: instructionsFor(source),
        skill: feedbackSkill,
        mcp: assessmentMcp(this.baseUrl, id, active.token),
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
    if (this.expressions.handles(id)) return this.expressions.tool(id, token, action, raw);
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
          source.id === source.attemptId
            ? 'Every correct or incorrect observation must cite source.id (the original attemptId). Discussion and learning facts can supplement it.'
            : 'Evaluate source.answer as the revised answer and cite its source.id. The first answer and discussion are background; scheduling is based on the first answer alone.',
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
    validateTranslationGrade(
      source.question.direction,
      input.result.expressionGrade,
      input.result.improvements,
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
      if (
        (observation.outcome === 'correct' || observation.outcome === 'incorrect') &&
        !observation.evidenceIds.includes(source.id)
      )
        throw new LearningError(
          'ASSESSMENT_EVIDENCE_INVALID',
          '判断译文对错须引用本次提交的 source.id。讨论、题干和学习记录只能作为补充。',
          400,
        );
    }
    this.store.saveApplication(
      {
        requestId: id,
        source: detail.source,
        result: input.result,
        trace: {
          ...(detail.source.aiSelection ?? defaultMiniAiSelection),
          rulesVersion,
          threadId: active.threadId,
          skillHash: active.skillHash,
          promptHash: miniAssessmentHash({ prompt, instructions: instructionsFor(source) }),
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
    await this.expressions.close();
    await this.runtime.close();
    this.store.close();
  }
}
