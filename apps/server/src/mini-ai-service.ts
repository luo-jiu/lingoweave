import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  miniAiStartSchema,
  miniAiControlSchema,
  miniCommandSchema,
  miniHistoryInputSchema,
  miniWordContextInputSchema,
  miniAudioTargetSchema,
  miniAudioRequestSchema,
  type MiniAiStart,
  type MiniAudioTarget,
  type MiniCommand,
  type MiniWord,
} from '@lingoweave/contracts';
import { MiniAiStore } from './mini-ai-store.js';
import type { MiniStore } from './mini-store.js';
import type { PreparationRuntime } from './preparation-service.js';
import type { MiniAudioService } from './mini-audio-service.js';
import type { MiniVocabularyStore } from './mini-vocabulary-store.js';
import { LearningError } from './learning-store.js';
import { CodexError } from './codex/transport.js';
import {
  currentLearningWord,
  currentTranslation,
  miniPreparationWords,
  miniWritingWords,
  sameWord,
  wordKey,
} from './mini-study.js';
import { miniAiActions as allowed, miniAiTools } from './mini-ai-policy.js';
import { MiniMaterialLibrary } from './mini-materials.js';
function stableId(value: string) {
  const h = createHash('sha256').update(value).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
function failure(error: unknown) {
  return error instanceof LearningError || error instanceof CodexError
    ? error.message
    : 'AI 任务中断，已保存的学习与工具结果保留，可以重试。';
}
export class MiniAiService {
  private baseUrl: string | null = null;
  private closing = false;
  private readonly active = new Map<
    string,
    {
      token: string;
      controller: AbortController;
      promise: Promise<void>;
      readRevision: number | null;
      exposed: Set<string>;
    }
  >();
  constructor(
    readonly study: MiniStore,
    readonly store: MiniAiStore,
    private readonly runtime: PreparationRuntime,
    private readonly audio?: MiniAudioService,
    private readonly vocabulary?: MiniVocabularyStore,
    private readonly materials = new MiniMaterialLibrary(),
  ) {
    // A business commit may precede a process crash while the AI receipt is being saved.
    // Reconcile the fixed command identity before deciding whether a task needs another run.
    for (const call of store.pendingTools()) {
      const receipt = study.commandReceipt(call.command.requestId);
      if (receipt) {
        if (
          !store.job(call.jobId).receipts.some((item) => item.requestId === call.command.requestId)
        )
          store.update(call.jobId, (job) =>
            job.receipts.push({
              requestId: call.command.requestId,
              tool: call.command.action.type,
              revision: receipt.revision,
              summary: '业务结果已保存。',
            }),
          );
        store.completeTool(call.command.requestId);
      }
    }
    for (const job of store
      .jobs()
      .filter((job) => job.status === 'running' || job.status === 'queued'))
      store.finish(
        job.id,
        this.resultReady(store.input(job.id)) ? 'completed' : 'interrupted',
        '服务已重启；已保存内容保留。',
      );
  }
  setBaseUrl(url: string) {
    this.baseUrl = url;
  }
  status() {
    return this.runtime.status();
  }
  snapshot() {
    return this.store.snapshot();
  }
  start(raw: MiniAiStart) {
    if (this.closing || !this.baseUrl)
      throw new LearningError('SERVICE_NOT_READY', '学习服务尚未就绪。', 503);
    const input = miniAiStartSchema.parse(raw);
    this.validateInput(input);
    const result = this.store.start(input);
    if (result.dispatch) this.dispatch(result.job.id);
    return result.job;
  }
  private validateInput(input: MiniAiStart) {
    const state = this.study.snapshot();
    if (!state.imported) throw new LearningError('MINI_IMPORT_REQUIRED', '请先迁入学习记录。');
    if (input.kind === 'advisor') return;
    const day = state.ledger.days.find((day) => day.id === input.dayId);
    if (!day) throw new LearningError('AI_TARGET_INVALID', '学习任务已不存在，请刷新。');
    if (
      input.kind === 'feedback' &&
      !day.translation.some((attempt) => attempt.id === input.attemptId)
    )
      throw new LearningError('AI_TARGET_INVALID', '请先保存真实作答，再请求反馈。');
    if (input.kind === 'writing' && day.writingRequired === false)
      throw new LearningError('AI_TARGET_INVALID', '这组只复习，不安排写作。');
  }
  cancel(input: { requestId: string; jobId: string }) {
    const result = this.store.control(input, 'cancel');
    if (result.job.status === 'cancelled') this.active.get(result.job.id)?.controller.abort();
    return result.job;
  }
  retry(raw: { requestId: string; jobId: string }) {
    const input = miniAiControlSchema.parse(raw);
    this.validateInput(this.store.input(input.jobId));
    const result = this.store.control(input, 'retry');
    if (result.dispatch) this.dispatch(result.job.id);
    return result.job;
  }
  clear(input: { requestId: string; conversationId: string }) {
    const result = this.store.clear(input);
    for (const job of this.store
      .jobs()
      .filter((job) => job.conversationId === input.conversationId && job.status === 'cancelled'))
      this.active.get(job.id)?.controller.abort();
    return result;
  }
  private dispatch(id: string) {
    if (this.closing || this.active.has(id) || this.active.size >= 2) return;
    const token = randomBytes(32).toString('hex'),
      controller = new AbortController();
    const promise = Promise.resolve().then(() => this.run(id, token, controller));
    this.active.set(id, { token, controller, promise, readRevision: null, exposed: new Set() });
    const finish = () => {
      this.active.delete(id);
      if (!this.closing)
        for (const job of this.store.jobs().filter((job) => job.status === 'queued'))
          this.dispatch(job.id);
    };
    void promise.then(finish, finish);
  }
  private resultReady(input: MiniAiStart): boolean {
    const day = this.study.snapshot().ledger.days.find((day) => day.id === input.dayId);
    if (!day) return false;
    if (input.kind === 'prepare')
      return miniPreparationWords(day).every((word) =>
        day.sentences.some((sentence) => wordKey(sentence.word) === wordKey(word)),
      );
    if (input.kind === 'writing')
      return (
        day.writingMode !== 'prepared' ||
        (miniWritingWords(day).every((word, index) =>
          day.writingPrompts?.some(
            (prompt) =>
              wordKey(prompt.sentence.word) === wordKey(word) &&
              prompt.direction === day.directions[index],
          ),
        ) &&
          (day.flow !== undefined || day.writingPrompts?.length === miniWritingWords(day).length))
      );
    if (input.kind === 'feedback')
      return day.translation.some(
        (attempt) => attempt.id === input.attemptId && attempt.feedback !== undefined,
      );
    return false;
  }
  private completeExisting(id: string, input: MiniAiStart) {
    if (this.resultReady(input)) {
      this.store.update(id, (job) => (job.text = '已有内容可继续使用。'));
      this.store.finish(id, 'completed');
      return true;
    }
    return false;
  }
  private async run(id: string, token: string, controller: AbortController) {
    const input = this.store.input(id),
      { signal } = controller;
    try {
      if (signal.aborted) return;
      if (this.completeExisting(id, input)) return;
      this.store.update(id, (job) => {
        job.status = 'running';
        job.progress = '正在连接学习助手…';
      });
      const status = await this.runtime.status();
      if (signal.aborted) return;
      if (!status.available || !status.authenticated)
        throw new LearningError('CODEX_UNAVAILABLE', status.error ?? '请先在本机 Codex 完成登录。');
      const model = status.models.find((model) => model.id === input.model);
      if (!model)
        throw new LearningError(
          'MODEL_UNAVAILABLE',
          '所选模型当前不可用，已保留选择，请刷新后重试。',
        );
      if (!model.supportedReasoningEfforts?.includes(input.effort))
        throw new LearningError('EFFORT_UNAVAILABLE', '所选模型当前不支持该推理强度，已保留选择。');
      const compiled = import.meta.url.endsWith('.js');
      const entry = fileURLToPath(
        new URL(compiled ? './mini-ai-mcp.js' : './mini-ai-mcp.ts', import.meta.url),
      );
      const result = await this.runtime.prepare({
        jobId: id,
        model: input.model,
        effort: input.effort,
        tools: miniAiTools(input.kind, this.audio !== undefined),
        prompt: `Task ${id}, kind ${input.kind}. Read learning_get_context first. Use only the allowed actions returned there. For prepare, publish missing examples for day.preparationWords, prioritizing currentWord and activeWindowWords in small usable batches before reserve candidates. For writing, publish independent prompts only for day.writingWords and their matching directions; previous groups' prompts remain immutable. For feedback, publish qualitative feedback for the saved original answer. For advisor, answer the saved user message; apply explicit requested plan or memory changes through learning_commit. A tool receipt, not chat text, confirms saving.`,
        instructions:
          '使用本任务 Skill，通过语织工具读取真实事实、按需查询历史并完成任务。只用简短中文对用户说明。不能替用户作答、自评、过关或修改排期；新反馈只定性解释，不给等级。没有记录表示未知。工具返回的allowedActions是本任务写权限；非本任务不能写。',
        skill: {
          name:
            input.kind === 'advisor'
              ? 'mini-advisor'
              : input.kind === 'feedback'
                ? 'mini-feedback'
                : 'mini-lesson',
          path: fileURLToPath(
            new URL(
              `../../../skills/${input.kind === 'advisor' ? 'mini-advisor' : input.kind === 'feedback' ? 'mini-feedback' : 'mini-lesson'}/SKILL.md`,
              import.meta.url,
            ),
          ),
        },
        mcp: {
          command: process.execPath,
          args: compiled ? [entry] : ['--import', import.meta.resolve('tsx'), entry],
          env: {
            LINGOWEAVE_MINI_AI_URL: `${this.baseUrl}/api/internal/mini-ai/${id}`,
            LINGOWEAVE_MINI_AI_TOKEN: token,
            LINGOWEAVE_MINI_AI_KIND: input.kind,
            LINGOWEAVE_MINI_AI_AUDIO: this.audio ? '1' : '0',
          },
        },
        onThread: ({ threadId, model }) => {
          if (!signal.aborted)
            this.store.update(id, (job) => {
              job.threadId = threadId;
              job.model = model;
            });
        },
        onProgress: (progress) => {
          if (!signal.aborted) this.store.update(id, (job) => (job.progress = progress));
        },
        onText: (text) => {
          if (!signal.aborted) {
            if (input.kind === 'advisor') this.recordChatExposure(id, input);
            this.store.update(id, (job) => (job.text += text));
          }
        },
        signal,
      });
      if (signal.aborted) return;
      this.store.update(id, (job) => {
        job.threadId = result.threadId;
        job.model = result.model;
      });
      const job = this.store.job(id);
      if (input.kind !== 'advisor' && !this.resultReady(input))
        throw new LearningError(
          'AI_RESULT_NOT_SAVED',
          'AI 未提交有效结果，已保存进度保留，可以重试。',
        );
      if (input.kind === 'advisor' && !job.text.trim() && job.receipts.length === 0)
        throw new LearningError('AI_EMPTY_RESULT', '助手没有返回内容，可以重试。');
      this.store.finish(id, 'completed');
    } catch (error) {
      const job = this.store.job(id);
      if (job.status === 'cancelled' || (signal.aborted && job.status === 'queued')) return;
      this.store.finish(
        id,
        this.resultReady(input) ? 'completed' : signal.aborted ? 'interrupted' : 'failed',
        failure(error),
      );
    }
  }
  private recordChatExposure(id: string, input: MiniAiStart) {
    const state = this.study.snapshot();
    const active = this.active.get(id);
    if (!active) return;
    const probe = state.scheduling.probes.find(
      (probe) => probe.id === state.scheduling.activeProbeId && probe.status === 'active',
    );
    const day = state.ledger.days.find(
      (day) => day.id === state.planning.activeDayId && day.phase !== 'finished',
    );
    let target:
      { target: 'daily'; dayId: string } | { target: 'review'; recordId: string } | undefined;
    let word: MiniWord | undefined;
    if (day) {
      target = { target: 'daily', dayId: day.id };
      if (day.phase === 'review') word = day.review?.queue[0];
      if (day.phase === 'learning') word = currentLearningWord(day);
      if (day.phase === 'translation') word = currentTranslation(day)?.sentence.word;
    } else if (state.reviewRecord && state.reviewRecord.session.phase !== 'finished') {
      target = { target: 'review', recordId: state.reviewRecord.id };
      word = state.reviewRecord.session.queue[0];
    }
    let key: string;
    let action: MiniCommand['action'];
    if (probe) {
      key = `probe:${probe.id}`;
      action = {
        type: 'record_probe_help',
        target: 'daily',
        probeId: probe.id,
        source: 'chat',
        sourceMessageId: input.requestId,
      };
    } else {
      if (!target || !word) return;
      key = `${target.target}:${'dayId' in target ? target.dayId : target.recordId}:${wordKey(word)}`;
      action = {
        type: 'record_exposure',
        ...target,
        word,
        kind: 'potentialHelp',
        source: 'chat',
        sourceMessageId: input.requestId,
        focusIds: [],
      };
    }
    if (active.exposed.has(key)) return;
    const requestId = stableId(`${id}:chat-exposure:${key}`);
    if (this.study.commandReceipt(requestId)) {
      active.exposed.add(key);
      return;
    }
    const command: MiniCommand = {
      requestId,
      expectedRevision: state.revision,
      action,
    };
    const fixed = this.store.toolCommand(id, 'chat-exposure', command);
    this.study.aiCommand(fixed);
    this.store.completeTool(requestId);
    active.exposed.add(key);
  }

  tool(id: string, token: string, action: string, raw: unknown) {
    const active = this.active.get(id);
    if (
      !active ||
      active.controller.signal.aborted ||
      active.token !== token ||
      this.store.job(id).status !== 'running'
    )
      throw new LearningError('AI_TASK_EXPIRED', '这项 AI 任务已经停止，不能再读取或保存。', 403);
    const input = this.store.input(id);
    if (action === 'context') {
      const context = this.study.aiContext({
        timezone: input.timezone,
        ...(input.dayId ? { dayId: input.dayId } : {}),
      });
      active.readRevision = context.revision;
      const day = context.day;
      const sentenceLevel =
        [...context.memories]
          .reverse()
          .find((memory) => memory.key === 'english_level')
          ?.value.match(/\b(A1|A2|B1|B2|C1|C2)\b/i)?.[1]
          ?.toUpperCase() ?? 'A1';
      return {
        ...context,
        curriculum: {
          ...(this.vocabulary?.lessonContext(
            day ? [...day.reviewWords, ...miniPreparationWords(day)] : [],
          ) ?? {}),
          sentenceLevel,
          guidance:
            'Use sentenceLevel for sentence length, grammar and supporting vocabulary. Target word CEFR describes the word, not the learner. Prefer already learned words and focus items. Keep examples natural and useful.',
        },
        materials: this.materials.context(day ? miniPreparationWords(day) : [], sentenceLevel),
        planning: {
          longTerm: context.planning.longTerm,
          dailyOverrides: context.planning.dailyOverrides.slice(-3),
          nextSessionOverride: context.planning.nextSessionOverride,
          currentSession:
            context.planning.sessions.find((session) => session.endedAt === undefined) ?? null,
        },
        day: day
          ? {
              id: day.id,
              phase: day.phase,
              paused: day.paused,
              reviewWords: day.reviewWords,
              learningWords: day.learningWords,
              preparationWords: miniPreparationWords(day),
              writingWords: miniWritingWords(day),
              currentWord: currentLearningWord(day) ?? null,
              activeWindowWords: day.flow?.window.members.map((member) => member.word) ?? [],
              directions: day.directions,
              sentences: day.sentences,
              writingMode: day.writingMode,
              writingPrompts: day.writingPrompts,
              translationIndex: day.translationIndex,
              attempt: day.translation.find((attempt) => attempt.id === input.attemptId) ?? null,
            }
          : null,
        job: { id, kind: input.kind, word: input.word ?? null, attemptId: input.attemptId ?? null },
        allowedActions: allowed[input.kind],
        audioTools:
          this.audio && input.kind === 'advisor'
            ? ['learning_get_audio', 'learning_generate_audio']
            : [],
        messages: input.kind === 'advisor' ? this.store.messages(input.conversationId) : [],
        sourceMessageId: this.store.userMessage(id)?.id ?? null,
      };
    }
    if (action === 'history') return this.study.history(miniHistoryInputSchema.parse(raw ?? {}));
    if (action === 'word') {
      const query = miniWordContextInputSchema.parse(raw);
      return {
        ...this.study.wordContext(query),
        dictionary: this.vocabulary?.wordContext(query.word) ?? [],
      };
    }
    if (action === 'audio_status' || action === 'audio_request') {
      if (input.kind !== 'advisor' || !this.audio)
        throw new LearningError('AI_ACTION_FORBIDDEN', '本任务没有语音工具。', 403);
      if (active.readRevision === null)
        throw new LearningError('AI_CONTEXT_REQUIRED', '请先读取当前学习上下文。');
      if (action === 'audio_status') {
        const target = miniAudioTargetSchema.parse(raw);
        this.validateAudioTarget(input, target);
        return this.audio.lookup(target);
      }
      const request = miniAudioRequestSchema.parse(raw);
      this.validateAudioTarget(input, request.target);
      return this.requestAudio(id, token, request);
    }
    if (action !== 'commit') throw new LearningError('AI_TOOL_INVALID', '未知学习工具。', 400);
    const command = miniCommandSchema.parse(raw);
    if (active.readRevision === null)
      throw new LearningError('AI_CONTEXT_REQUIRED', '请先读取当前学习上下文。');
    if (!allowed[input.kind].includes(command.action.type))
      throw new LearningError('AI_ACTION_FORBIDDEN', '本任务无权执行这项学习操作。', 403);
    if (
      'dayId' in command.action &&
      command.action.dayId !== undefined &&
      command.action.dayId !== (input.dayId ?? this.study.snapshot().planning.activeDayId)
    )
      throw new LearningError('AI_TARGET_INVALID', '不能写入本任务以外的学习组。', 403);
    if (
      command.action.type === 'qualitative_feedback' &&
      command.action.attemptId !== input.attemptId
    )
      throw new LearningError('AI_TARGET_INVALID', '反馈不属于本次原答。', 403);
    const source = this.store.userMessage(id);
    if (command.action.type === 'add_sentences')
      command.action.sentences.forEach((sentence) => this.materials.validate(sentence));
    if (command.action.type === 'publish_writing')
      command.action.prompts.forEach((prompt) => this.materials.validate(prompt.sentence));
    if (
      (command.action.type === 'remember_preference' ||
        command.action.type === 'forget_preference') &&
      command.action.sourceMessageId !== source?.id
    )
      throw new LearningError('AI_MESSAGE_SOURCE_INVALID', '偏好必须关联真实用户消息。', 403);
    const fixed = this.store.toolCommand(id, 'learning_commit', command);
    const snapshot = this.study.aiCommand(
      fixed,
      source ? { sourceMessageId: source.id } : undefined,
    );
    this.store.update(id, (job) => {
      if (!job.receipts.some((receipt) => receipt.requestId === command.requestId))
        job.receipts.push({
          requestId: command.requestId,
          tool: command.action.type,
          revision: snapshot.revision,
          summary: '已按学习规则保存。',
        });
    });
    this.store.completeTool(command.requestId);
    active.readRevision = snapshot.revision;
    return {
      requestId: command.requestId,
      revision: snapshot.revision,
      saved: true,
      action: command.action.type,
    };
  }
  private validateAudioTarget(input: MiniAiStart, target: MiniAudioTarget) {
    const state = this.study.snapshot();
    const word = target.kind === 'word' ? target.word : target.sentence.word;
    const knownWords = [
      ...state.ledger.days.flatMap((day) => [...day.reviewWords, ...miniPreparationWords(day)]),
      ...[state.reviewRecord, ...state.reviewHistory].flatMap(
        (record) => record?.session.words ?? [],
      ),
    ];
    if (
      !knownWords.some((known) => sameWord(known, word)) ||
      (input.word && !sameWord(input.word, word))
    )
      throw new LearningError(
        'AI_TARGET_INVALID',
        '只能处理这次对话相关且已有记录的单词语音。',
        403,
      );
    if (target.kind === 'sentence') {
      const english = target.sentence.english.trim().replace(/\s+/g, ' ');
      const sentences = state.ledger.days.flatMap((day) => [
        ...day.sentences,
        ...(day.writingPrompts ?? []).map((prompt) => prompt.sentence),
        ...day.translation.map((attempt) => attempt.task.sentence),
      ]);
      if (
        !sentences.some(
          (sentence) =>
            sameWord(sentence.word, word) &&
            sentence.english.trim().replace(/\s+/g, ' ') === english &&
            sentence.chinese === target.sentence.chinese,
        )
      )
        throw new LearningError('AI_TARGET_INVALID', '请使用已保存的例句或写作材料生成语音。', 403);
    }
  }
  private async requestAudio(
    id: string,
    token: string,
    request: ReturnType<typeof miniAudioRequestSchema.parse>,
  ) {
    const audio = this.audio;
    if (!audio) throw new LearningError('AI_ACTION_FORBIDDEN', '语音工具未连接。', 403);
    const check = () => {
      const current = this.active.get(id);
      if (
        !current ||
        current.token !== token ||
        current.controller.signal.aborted ||
        this.store.job(id).status !== 'running'
      )
        throw new LearningError('AI_TASK_EXPIRED', '这项 AI 任务已经停止，不能再创建音频。', 403);
    };
    const result = await audio.request(request, check);
    check();
    this.store.update(id, (job) => {
      if (!job.receipts.some((receipt) => receipt.requestId === request.requestId))
        job.receipts.push({
          requestId: request.requestId,
          tool: 'learning_generate_audio',
          revision: this.study.snapshot().revision,
          summary:
            result.job && result.job.status !== 'completed'
              ? '语音任务已保存，生成状态可查询。'
              : '已有语音可复用。',
        });
    });
    return result;
  }
  async close() {
    this.closing = true;
    for (const active of this.active.values()) active.controller.abort();
    await Promise.allSettled([...this.active.values()].map((active) => active.promise));
    await this.runtime.close();
    this.store.close();
  }
}
