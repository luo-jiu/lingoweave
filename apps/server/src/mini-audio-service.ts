import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  miniAudioRequestSchema,
  miniAudioPlaybackSchema,
  miniAudioPlaybackStartSchema,
  miniAudioTargetSchema,
  type MiniAudioAsset,
  type MiniAudioContext,
  type MiniAudioPlayback,
  type MiniAudioPlaybackReceipt,
  type MiniAudioPlaybackStart,
  type MiniAudioProfile,
  type MiniAudioRequest,
  type MiniAudioResult,
  type MiniAudioTarget,
  type MiniAudioVoice,
  type MiniCommand,
  type MiniReviewSession,
  type MiniWord,
} from '@lingoweave/contracts';
import { LearningError } from './learning-store.js';
import { MiniAudioStore, type AudioGenerationInput } from './mini-audio-store.js';
import type { MiniTtsRuntime } from './mini-audio-runtime.js';
import type { MiniStore } from './mini-store.js';
import {
  currentLearningWord,
  currentMiniWindow,
  currentTranslation,
  sameWord,
  swiftTime,
} from './mini-study.js';

const voices: MiniAudioVoice[] = ['ryan', 'aiden', 'serena'];
const normalize = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ');
function hasSpellingResult(session: MiniReviewSession | undefined, word: MiniWord) {
  return (
    session?.phase === 'spelling' &&
    session.spellingState !== 'awaitingFirst' &&
    sameWord(session.spellingAttempts.at(-1)?.word, word)
  );
}
function digest(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function wordOf(target: MiniAudioTarget) {
  return target.kind === 'word' ? target.word : target.sentence.word;
}
function identity(target: MiniAudioTarget) {
  const word = wordOf(target);
  return {
    kind: target.kind,
    word: {
      spelling: normalize(word.spelling),
      meaning: normalize(word.meaning),
      phonetic: normalize(word.phonetic),
    },
    ...(target.kind === 'sentence' ? { english: normalize(target.sentence.english) } : {}),
  };
}
function wordMaximumDuration(text: string) {
  return Math.max(2.5, normalize(text).length * 0.12 + 1);
}
function validateDuration(target: MiniAudioTarget, seconds: number) {
  if (target.kind === 'word' && seconds > wordMaximumDuration(target.word.spelling))
    throw new LearningError('AUDIO_WORD_TOO_LONG', '单词音频包含异常长的内容，请重新生成。');
}
function legacyWordInstructions(target: Extract<MiniAudioTarget, { kind: 'word' }>) {
  const word = target.word;
  return `Read only the English word naturally and clearly. Intended meaning: ${normalize(word.meaning)}.${word.phonetic ? ` Pronunciation hint: ${normalize(word.phonetic)}.` : ''} Do not read the meaning, hint, or instructions aloud.`;
}
function generation(target: MiniAudioTarget, profile: MiniAudioProfile): AudioGenerationInput {
  const word = wordOf(target),
    text = normalize(target.kind === 'word' ? word.spelling : target.sentence.english);
  if (!text || text.length > 1000)
    throw new LearningError('AUDIO_TEXT_INVALID', '这段内容暂时无法生成语音。', 400);
  if (target.kind === 'word')
    return {
      target,
      profile: {
        ...profile,
        generationVersion: profile.generationVersion.endsWith('/word-2')
          ? profile.generationVersion
          : `${profile.generationVersion}/word-2`,
        temperature: 0.3,
        maxTokens: Math.max(64, Math.ceil(wordMaximumDuration(text) * 12) + 24),
      },
      text,
      normalizedText: text,
      instructions: '',
    };
  return {
    target,
    profile,
    text,
    normalizedText: text,
    instructions:
      'Read the English sentence naturally and clearly. Do not translate or add commentary.',
  };
}
function keyFor(input: AudioGenerationInput) {
  return digest({
    target: identity(input.target),
    normalizedText: input.normalizedText,
    profile: input.profile,
    instructions: input.instructions,
  });
}
function stableId(value: string) {
  const h = createHash('sha256').update(value).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
function spokenContains(text: string, word: string) {
  const pattern = normalize(word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${pattern}(?:$|[^\\p{L}\\p{N}_])`, 'iu').test(
    normalize(text),
  );
}

export function inspectMiniWav(data: Buffer) {
  if (
    data.length < 44 ||
    data.length > 20 * 1024 * 1024 ||
    data.toString('ascii', 0, 4) !== 'RIFF' ||
    data.toString('ascii', 8, 12) !== 'WAVE' ||
    data.readUInt32LE(4) + 8 !== data.length
  )
    throw new LearningError('AUDIO_FILE_INVALID', '音频文件校验失败，可以重新生成。');
  let position = 12,
    sampleRate = 0,
    channels = 0,
    blockAlign = 0,
    bits = 0,
    format = 0,
    pcm: Buffer | null = null;
  while (position + 8 <= data.length) {
    const name = data.toString('ascii', position, position + 4),
      size = data.readUInt32LE(position + 4),
      start = position + 8;
    if (size > data.length - start)
      throw new LearningError('AUDIO_FILE_INVALID', '音频文件不完整。');
    if (name === 'fmt ') {
      if (size < 16) throw new LearningError('AUDIO_FILE_INVALID', '音频格式不完整。');
      format = data.readUInt16LE(start);
      channels = data.readUInt16LE(start + 2);
      sampleRate = data.readUInt32LE(start + 4);
      blockAlign = data.readUInt16LE(start + 12);
      bits = data.readUInt16LE(start + 14);
    }
    if (name === 'data') pcm = data.subarray(start, start + size);
    position = start + size + (size % 2);
  }
  if (
    format !== 1 ||
    channels !== 1 ||
    sampleRate !== 24000 ||
    bits !== 16 ||
    blockAlign !== 2 ||
    !pcm ||
    pcm.length % 2 !== 0
  )
    throw new LearningError('AUDIO_FILE_INVALID', '音频格式不受支持。');
  const durationSeconds = pcm.length / (sampleRate * blockAlign);
  if (durationSeconds < 0.1 || durationSeconds > 120)
    throw new LearningError('AUDIO_FILE_INVALID', '音频时长不正确。');
  let energy = 0;
  for (let offset = 0; offset < pcm.length; offset += 2) {
    const value = pcm.readInt16LE(offset);
    energy += value * value;
  }
  if (Math.sqrt(energy / (pcm.length / 2)) < 3)
    throw new LearningError('AUDIO_FILE_INVALID', '生成的音频没有有效声音，可以重试。');
  return {
    sampleRate,
    channels,
    durationSeconds,
    bytes: data.length,
    sha256: createHash('sha256').update(data).digest('hex'),
  };
}

export class MiniAudioService {
  private active: { id: string; controller: AbortController; promise: Promise<void> } | null = null;
  private closing = false;
  private readonly now: () => Date;
  constructor(
    readonly study: MiniStore,
    readonly store: MiniAudioStore,
    private readonly runtime: MiniTtsRuntime,
    readonly options: { directory: string; now?: () => Date; random?: () => number },
  ) {
    this.now = options.now ?? (() => new Date());
    for (const pending of store.pendingAuthorizations()) {
      const receipt = pending.command ? study.commandReceipt(pending.command.requestId) : null;
      if (!pending.command || receipt)
        store.confirmAuthorization(pending.receipt.requestId, receipt?.revision ?? null);
    }
    for (const job of store
      .jobs()
      .filter((job) => job.status === 'queued' || job.status === 'running'))
      store.update(job.id, 'interrupted', '服务已重启，已有音频保留，可以重试。');
  }
  status() {
    return this.runtime.status();
  }
  snapshot() {
    return this.store.snapshot();
  }
  job(id: string) {
    return this.store.job(id);
  }
  private async usable(asset: MiniAudioAsset | null) {
    if (!asset) return false;
    try {
      const info = await stat(join(this.options.directory, asset.fileName));
      if (info.size !== asset.bytes || info.size > 20 * 1024 * 1024) return false;
      const data = await readFile(join(this.options.directory, asset.fileName));
      const inspected = inspectMiniWav(data);
      validateDuration(asset.target, inspected.durationSeconds);
      return inspected.sha256 === asset.sha256;
    } catch {
      return false;
    }
  }
  private async fallback(target: MiniAudioTarget) {
    const candidates = this.store
      .assets()
      .filter((asset) => digest(identity(asset.target)) === digest(identity(target)))
      .reverse();
    for (const asset of candidates)
      if (this.store.current(asset.targetKey)?.id === asset.id && (await this.usable(asset)))
        return asset;
    return null;
  }
  private legacyWord(target: MiniAudioTarget, profile: MiniAudioProfile) {
    if (target.kind !== 'word') return null;
    const text = normalize(target.word.spelling);
    return this.store.current(
      keyFor({
        target,
        profile,
        text,
        normalizedText: text,
        instructions: legacyWordInstructions(target),
      }),
    );
  }
  private async currentAsset(target: MiniAudioTarget, profile: MiniAudioProfile) {
    const current = this.store.current(keyFor(generation(target, profile)));
    if (await this.usable(current)) return current;
    const legacy = this.legacyWord(target, profile);
    return (await this.usable(legacy)) ? legacy : null;
  }
  async lookup(raw: MiniAudioTarget): Promise<MiniAudioResult> {
    const target = miniAudioTargetSchema.parse(raw),
      status = await this.runtime.status();
    const asset = status.profile
      ? await this.currentAsset(target, status.profile)
      : await this.fallback(target);
    const targetKey = status.profile
      ? keyFor(generation(target, status.profile))
      : (asset?.targetKey ?? digest(identity(target)));
    const job =
      [...this.store.jobs()]
        .reverse()
        .find(
          (job) =>
            job.targetKey === targetKey && (job.status === 'queued' || job.status === 'running'),
        ) ?? null;
    return { targetKey: asset?.targetKey ?? targetKey, asset, job, reused: true };
  }
  async request(raw: MiniAudioRequest, beforeCommit?: () => void): Promise<MiniAudioResult> {
    if (this.closing) throw new LearningError('AUDIO_CLOSED', '语音服务正在关闭。', 503);
    const input = miniAudioRequestSchema.parse(raw),
      replay = this.store.replayRequest(input);
    if (replay) return replay;
    const status = await this.runtime.status();
    if (!status.available || !status.profile) {
      const existing = await this.fallback(input.target);
      if (input.operation === 'ensure' && existing) {
        beforeCommit?.();
        return this.store.request(
          input,
          existing.targetKey,
          generation(input.target, existing.profile),
          existing.voice,
          existing,
        ).result;
      }
      throw new LearningError(
        'TTS_UNAVAILABLE',
        status.error ?? '本地语音不可用，已有音频仍可播放。',
        503,
      );
    }
    const material = generation(input.target, status.profile),
      targetKey = keyFor(material),
      current = await this.currentAsset(input.target, status.profile);
    const existing = current;
    const random = this.options.random?.() ?? Math.random(),
      voice =
        input.voice ??
        voices[Math.min(2, Math.max(0, Math.floor(random * voices.length)))] ??
        'ryan';
    beforeCommit?.();
    const result = this.store.request(
      input,
      input.operation === 'ensure' && existing ? existing.targetKey : targetKey,
      material,
      voice,
      existing,
    );
    if (result.dispatch) this.drain();
    return result.result;
  }
  private drain() {
    if (this.active || this.closing) return;
    const job = this.store.jobs().find((job) => job.status === 'queued');
    if (!job) return;
    const controller = new AbortController(),
      promise = Promise.resolve().then(() => this.run(job.id, controller.signal));
    this.active = { id: job.id, controller, promise };
    const finish = () => {
      this.active = null;
      this.drain();
    };
    void promise.then(finish, finish);
  }
  private async run(id: string, signal: AbortSignal) {
    const job = this.store.job(id),
      input = this.store.input(id),
      temporary = join(this.options.directory, `${id}.tmp.wav`),
      destination = join(this.options.directory, `${id}.wav`);
    try {
      if (signal.aborted) return;
      await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
      await rm(temporary, { force: true });
      this.store.update(id, 'running', '正在生成本地语音…');
      await this.runtime.generate({
        text: input.text,
        voice: job.voice,
        instructions: input.instructions,
        parameters: {
          kind: input.target.kind,
          temperature: input.profile.temperature,
          maxTokens: input.profile.maxTokens,
          maximumDurationSeconds:
            input.target.kind === 'word' ? wordMaximumDuration(input.text) : 120,
        },
        outputFile: temporary,
        signal,
      });
      if (signal.aborted) throw new Error('Interrupted');
      const info = await stat(temporary);
      if (info.size > 20 * 1024 * 1024) throw new Error('Oversized audio');
      const details = inspectMiniWav(await readFile(temporary));
      validateDuration(input.target, details.durationSeconds);
      await chmod(temporary, 0o600);
      await rename(temporary, destination);
      this.store.complete(id, {
        id,
        targetKey: job.targetKey,
        target: input.target,
        text: input.text,
        normalizedText: input.normalizedText,
        language: 'English',
        voice: job.voice,
        profile: input.profile,
        instructions: input.instructions,
        fileName: `${id}.wav`,
        ...details,
        createdAt: swiftTime(this.now()),
      });
    } catch (error) {
      if (this.store.job(id).status !== 'completed') {
        try {
          this.store.update(
            id,
            signal.aborted ? 'interrupted' : 'failed',
            signal.aborted ? '生成已中断，已有音频保留。' : '生成失败，已有音频保留，可以重试。',
            error instanceof LearningError
              ? error.message
              : '本地音频生成中断，已有音频保留，可以重试。',
          );
        } catch {
          console.error(
            'LingoWeave could not save an audio task failure. Check local storage before retrying.',
          );
        }
        await rm(destination, { force: true }).catch(() => {});
      }
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }
  async file(id: string) {
    const asset = this.store.asset(id);
    try {
      const info = await stat(join(this.options.directory, asset.fileName));
      if (info.size !== asset.bytes || info.size > 20 * 1024 * 1024)
        throw new Error('Invalid asset');
      const data = await readFile(join(this.options.directory, asset.fileName));
      const inspected = inspectMiniWav(data);
      if (inspected.sha256 !== asset.sha256) throw new Error('Invalid checksum');
      validateDuration(asset.target, inspected.durationSeconds);
      return { asset, data };
    } catch (error) {
      if (error instanceof LearningError && error.code === 'AUDIO_WORD_TOO_LONG') throw error;
      throw new LearningError('AUDIO_ASSET_INVALID', '音频文件缺失或损坏，请重新生成。', 404);
    }
  }
  private actual(context?: MiniAudioContext) {
    const state = this.study.snapshot();
    const practice = state.practice.dictations.find(
      (item) => item.id === state.practice.activeDictationId && item.closedAt === undefined,
    );
    if (practice) {
      let expected: MiniAudioContext;
      if (practice.target === 'review') {
        if (!practice.recordId)
          throw new LearningError('AUDIO_TARGET_CHANGED', '当前草稿拼写已变化。');
        expected = { target: 'review', recordId: practice.recordId, session: 'review' };
      } else {
        if (!practice.dayId)
          throw new LearningError('AUDIO_TARGET_CHANGED', '当前草稿拼写已变化。');
        expected = {
          target: 'daily',
          dayId: practice.dayId,
          ...(practice.session ? { session: practice.session } : {}),
        };
      }
      if (
        context &&
        (context.target !== expected.target ||
          (context.target === 'daily' &&
            expected.target === 'daily' &&
            context.dayId !== expected.dayId) ||
          (context.target === 'review' &&
            expected.target === 'review' &&
            context.recordId !== expected.recordId) ||
          (context.session !== undefined && context.session !== expected.session))
      )
        throw new LearningError('AUDIO_TARGET_CHANGED', '当前草稿拼写已变化。');
      return {
        context: expected,
        word: practice.word,
        automatic: practice.attempts.length > 0,
        automaticWord: true,
        sentence: undefined,
        knownSentence: undefined,
      };
    }
    const savedSentence = (word: MiniWord) =>
      state.ledger.days
        .find((day) => day.id === state.planning.activeDayId)
        ?.sentences.find((sentence) => sameWord(sentence.word, word)) ??
      [...state.ledger.days]
        .reverse()
        .flatMap((day) => day.sentences)
        .find((sentence) => sameWord(sentence.word, word));
    if (context?.target === 'review') {
      const record = state.reviewRecord;
      if (
        !record ||
        record.id.toLowerCase() !== context.recordId ||
        record.session.phase === 'finished' ||
        record.paused
      )
        throw new LearningError('AUDIO_TARGET_CHANGED', '当前词卡已变化，未播放旧音频。');
      const word = record.session.queue[0];
      if (!word) throw new LearningError('AUDIO_TARGET_CHANGED', '当前词卡已变化。');
      const judgment = record.session.judgmentEvents.at(-1);
      return {
        context,
        word,
        automatic: record.session.phase === 'judgment' || hasSpellingResult(record.session, word),
        automaticWord: true,
        knownSentence: savedSentence(word),
        sentence:
          record.session.phase === 'judgment' &&
          judgment?.final === undefined &&
          sameWord(judgment?.word, word)
            ? savedSentence(word)
            : undefined,
      };
    }
    const day = state.ledger.days.find(
      (day) =>
        day.id === (context?.target === 'daily' ? context.dayId : state.planning.activeDayId),
    );
    if (
      context?.target === 'daily' &&
      (!day || day.id !== state.planning.activeDayId || day.phase === 'finished' || day.paused)
    )
      throw new LearningError('AUDIO_TARGET_CHANGED', '当前词卡已变化，未播放旧音频。');
    if (day && day.id === state.planning.activeDayId && day.phase !== 'finished') {
      const unseen = day.learningWords.find(
        (word) => !day.studiedWords.some((item) => sameWord(item.word, word)),
      );
      const word =
        day.phase === 'review'
          ? (currentMiniWindow(day)?.visit?.word ?? day.review?.queue[0])
          : day.phase === 'learning'
            ? currentLearningWord(day)
            : currentTranslation(day)?.sentence.word;
      if (
        context?.target === 'daily' &&
        context.session !== undefined &&
        context.session !== day.phase
      )
        throw new LearningError('AUDIO_TARGET_CHANGED', '当前学习阶段已变化，未播放旧音频。');
      if (word) {
        const visit = currentMiniWindow(day)?.visit;
        const judgment = day.review?.judgmentEvents.at(-1);
        const fullLearningCard =
          day.phase === 'learning' &&
          (visit
            ? visit.stage === 0 || visit.initial !== undefined
            : day.flow
              ? false
              : day.memory
                ? day.memory.round <= 3 && (day.memory.round === 1 || day.memory.revealed)
                : day.retainedLearningWord !== undefined || unseen !== undefined);
        const fullReviewCard =
          day.phase === 'review' &&
          (visit
            ? visit.stage === 0 || visit.initial !== undefined
            : day.review?.phase === 'judgment' &&
              judgment?.final === undefined &&
              sameWord(judgment?.word, word));
        const spellingResult =
          (day.phase === 'review' || day.phase === 'learning') &&
          hasSpellingResult(day.phase === 'review' ? day.review : day.learning, word);
        return {
          context: {
            target: 'daily' as const,
            dayId: day.id,
            ...(day.phase === 'translation' ? {} : { session: day.phase }),
          },
          word,
          automatic:
            !day.paused &&
            (spellingResult ||
              (day.phase === 'review'
                ? visit
                  ? true
                  : day.review?.phase === 'judgment'
                : visit !== undefined || fullLearningCard)),
          automaticWord: !visit || visit.stage !== 1 || visit.initial !== undefined,
          knownSentence:
            day.phase === 'translation' ? currentTranslation(day)?.sentence : savedSentence(word),
          sentence:
            !day.paused && (fullLearningCard || fullReviewCard || visit?.stage === 1)
              ? savedSentence(word)
              : undefined,
        };
      }
    }
    const record = state.reviewRecord;
    if (!context && record && record.session.phase !== 'finished' && record.session.queue[0])
      return {
        context: { target: 'review' as const, recordId: record.id, session: 'review' as const },
        word: record.session.queue[0],
        automatic:
          !record.paused &&
          (record.session.phase === 'judgment' ||
            hasSpellingResult(record.session, record.session.queue[0])),
        automaticWord: true,
        knownSentence: savedSentence(record.session.queue[0]),
        sentence:
          !record.paused &&
          record.session.phase === 'judgment' &&
          record.session.judgmentEvents.at(-1)?.final === undefined &&
          sameWord(record.session.judgmentEvents.at(-1)?.word, record.session.queue[0])
            ? savedSentence(record.session.queue[0])
            : undefined,
      };
    return null;
  }
  authorize(raw: MiniAudioPlayback): MiniAudioPlaybackReceipt {
    const input = miniAudioPlaybackSchema.parse(raw),
      previous = this.store.authorization(input);
    if (previous) {
      if (previous.command) {
        const saved = this.study.commandReceipt(previous.command.requestId);
        if (saved) return this.store.confirmAuthorization(input.requestId, saved.revision);
        const state = this.study.aiCommand(previous.command);
        return this.store.confirmAuthorization(input.requestId, state.revision);
      }
      return this.store.confirmAuthorization(input.requestId, null);
    }
    const state = this.study.snapshot();
    if (
      state.scheduling.probes.some(
        (probe) => probe.id === state.scheduling.activeProbeId && probe.status === 'active',
      )
    )
      throw new LearningError('AUDIO_PROBE_ACTIVE', '请先结束独立检验，再试听答案音频。');
    const asset = this.store.asset(input.assetId);
    validateDuration(asset.target, asset.durationSeconds);
    let actual = this.actual(input.context);
    const matchesCurrent =
      actual &&
      (spokenContains(asset.text, actual.word.spelling) ||
        (asset.target.kind === 'sentence' &&
          actual.knownSentence &&
          sameWord(asset.target.sentence.word, actual.word) &&
          normalize(asset.text) === normalize(actual.knownSentence.english)));
    if (!input.context && actual && !matchesCurrent) actual = null;
    if (input.context && (!actual || !matchesCurrent))
      throw new LearningError('AUDIO_TARGET_CHANGED', '音频不属于当前词卡，未播放旧音频。');
    if (
      actual &&
      asset.target.kind === 'word' &&
      (input.context || input.mode === 'automatic') &&
      !sameWord(asset.target.word, actual.word)
    )
      throw new LearningError('AUDIO_TARGET_CHANGED', '音频的词义或读音与当前词卡不同。');
    if (input.mode === 'automatic') {
      if (!actual || !actual.automatic)
        throw new LearningError('AUDIO_AUTOPLAY_FORBIDDEN', '当前阶段不自动播放答案。');
      if (asset.target.kind === 'word' && !actual.automaticWord)
        throw new LearningError('AUDIO_AUTOPLAY_FORBIDDEN', '当前页面自动播放例句。');
      if (
        asset.target.kind === 'sentence' &&
        (!actual.sentence ||
          !sameWord(asset.target.sentence.word, actual.word) ||
          normalize(asset.target.sentence.english) !== normalize(actual.sentence.english))
      )
        throw new LearningError(
          'AUDIO_AUTOPLAY_FORBIDDEN',
          '请先展开当前词卡，再播放已保存的例句。',
        );
    }
    const command: MiniCommand | null = actual
      ? {
          requestId: stableId(`${input.requestId}:audio-help`),
          expectedRevision: this.study.snapshot().revision,
          action: {
            type: 'record_exposure',
            ...actual.context,
            word: actual.word,
            kind: 'potentialHelp',
            source: 'audio',
            audioKind: asset.target.kind,
            focusIds: [],
          },
        }
      : null;
    this.store.prepareAuthorization(input, command);
    const revision = command ? this.study.aiCommand(command).revision : null;
    return this.store.confirmAuthorization(input.requestId, revision);
  }
  started(raw: MiniAudioPlaybackStart) {
    const input = miniAudioPlaybackStartSchema.parse(raw),
      previous = this.store.replayStarted(input);
    if (previous) return previous;
    const playback = this.store.playback(input.playbackId),
      now = swiftTime(this.now());
    if (
      input.occurredAt < playback.authorizedAt - 2 ||
      input.occurredAt > playback.authorizedAt + 60 ||
      input.occurredAt > now + 300
    )
      throw new LearningError(
        'AUDIO_PLAYBACK_TIME_INVALID',
        '播放开始时间不正确，请检查本机时钟。',
        400,
      );
    return this.store.startPlayback(input);
  }
  async close() {
    if (this.closing) return;
    this.closing = true;
    const active = this.active;
    active?.controller.abort();
    await this.runtime.close();
    await active?.promise;
    this.store.close();
  }
}
