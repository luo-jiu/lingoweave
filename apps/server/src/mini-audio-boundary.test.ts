import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  miniAudioRequestSchema,
  miniCommandSchema,
  miniSentenceSchema,
  type MiniAudioAsset,
  type MiniAudioRuntime,
  type MiniAudioTarget,
  type MiniWord,
} from '@lingoweave/contracts';
import { buildApp } from './app.js';
import { LearningError } from './learning-store.js';
import { MiniAudioService } from './mini-audio-service.js';
import { MiniAudioStore } from './mini-audio-store.js';
import type { MiniTtsRuntime } from './mini-audio-runtime.js';
import { MiniStore } from './mini-store.js';
import { calendarDue, currentTranslation, swiftTime } from './mini-study.js';

const timezone = 'Asia/Shanghai';
const apple: MiniWord = { spelling: 'apple', meaning: '苹果', phonetic: '/ˈæpəl/' };
const book: MiniWord = { spelling: 'book', meaning: '书', phonetic: '/bʊk/' };
const hasCode = (code: string) => (error: unknown) =>
  error instanceof LearningError && error.code === code;

test('target-form metadata selects complete English forms and rejects missing spans', () => {
  const sentence = {
    word: { ...apple, spelling: 'give' },
    english: 'She gave me a book.',
    chinese: '她给了我一本书。',
    targetForms: ['gave'],
  };
  assert.deepEqual(miniSentenceSchema.parse(sentence).targetForms, ['gave']);
  assert.equal(miniSentenceSchema.safeParse({ ...sentence, targetForms: ['give'] }).success, false);
  assert.equal(miniSentenceSchema.safeParse({ ...sentence, targetForms: ['GAVE'] }).success, true);
  assert.equal(
    miniSentenceSchema.safeParse({
      ...sentence,
      english: 'I have a notebook.',
      targetForms: ['book'],
    }).success,
    false,
  );
});

function waveFile() {
  const samples = 4800;
  const data = Buffer.alloc(44 + samples * 2);
  data.write('RIFF');
  data.writeUInt32LE(data.length - 8, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(24000, 24);
  data.writeUInt32LE(48000, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++)
    data.writeInt16LE(Math.round(2000 * Math.sin((index * Math.PI) / 20)), 44 + index * 2);
  return data;
}

class BoundaryRuntime implements MiniTtsRuntime {
  available = true;
  readonly calls: Parameters<MiniTtsRuntime['generate']>[0][] = [];
  async status(): Promise<MiniAudioRuntime> {
    return this.available
      ? {
          available: true,
          profile: {
            modelId: 'isolated-audio-test',
            modelRevision: 'a'.repeat(40),
            engine: 'mlx-audio',
            engineVersion: 'isolated-test',
            generationVersion: 'boundary-1',
            language: 'English',
            temperature: 0.7,
            maxTokens: 2048,
          },
          error: null,
        }
      : { available: false, profile: null, error: 'The isolated runtime is unavailable.' };
  }
  async generate(input: Parameters<MiniTtsRuntime['generate']>[0]) {
    this.calls.push(input);
    await writeFile(input.outputFile, waveFile());
  }
  async close() {}
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'lingoweave-audio-boundary-'));
  let date = new Date('2026-11-16T04:00:00Z');
  const now = () => date;
  const study = new MiniStore(join(directory, 'mini.sqlite'), { now, timezone });
  study.importLegacy({
    requestId: randomUUID(),
    ledger: { days: [] },
    reviewRecord: null,
    reviewHistory: [],
    timezone,
  });
  const store = new MiniAudioStore(join(directory, 'mini-audio.sqlite'), now);
  const runtime = new BoundaryRuntime();
  const audioDirectory = join(directory, 'audio');
  const service = new MiniAudioService(study, store, runtime, {
    directory: audioDirectory,
    now,
    random: () => 0,
  });
  let app: FastifyInstance | undefined;
  t.after(async () => {
    if (app) await app.close();
    else {
      await service.close();
      study.close();
    }
    await rm(directory, { recursive: true, force: true });
  });
  const act = (action: z.input<typeof miniCommandSchema>['action']) =>
    study.command(
      miniCommandSchema.parse({
        requestId: randomUUID(),
        expectedRevision: study.snapshot().revision,
        action,
      }),
    );
  const day = () => {
    const value = study
      .snapshot()
      .ledger.days.find((item) => item.id === study.snapshot().planning.activeDayId);
    assert.ok(value);
    return value;
  };
  const begin = (words = [apple], flowVersion?: 'memory-rounds-v1' | 'sliding-window-v2') => {
    act({ type: 'begin', target: 'daily', deck: words, timezone, flowVersion });
    const current = day();
    act({
      type: 'add_sentences',
      target: 'daily',
      dayId: current.id,
      sentences: current.learningWords.map((word) => ({
        word,
        english: `I see an ${word.spelling}.`,
        chinese: `我看见${word.meaning}。`,
      })),
    });
  };
  const ready = async (target: MiniAudioTarget): Promise<MiniAudioAsset> => {
    const initial = await service.request(
      miniAudioRequestSchema.parse({ requestId: randomUUID(), target }),
    );
    if (initial.asset) return initial.asset;
    assert.ok(initial.job);
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const job = service.job(initial.job.id);
      if (!['queued', 'running'].includes(job.status)) {
        assert.equal(job.status, 'completed', job.error ?? job.progress);
        const asset = service.snapshot().assets.find((item) => item.id === job.assetId);
        assert.ok(asset);
        return asset;
      }
      await setImmediate();
    }
    assert.fail('The isolated audio job did not settle.');
  };
  return {
    directory,
    audioDirectory,
    study,
    store,
    runtime,
    service,
    now,
    act,
    day,
    begin,
    ready,
    setDate(value: string) {
      date = new Date(value);
    },
    http() {
      app = buildApp({ mini: { store: study, token: 'a'.repeat(64), audio: service } });
      return app;
    },
  };
}

test('cached audio remains available without the model and keeps its saved voice without learning writes', async (t) => {
  const data = await fixture(t);
  const asset = await data.ready({ kind: 'word', word: apple });
  const before = data.study.snapshot();
  data.runtime.available = false;
  const input = miniAudioRequestSchema.parse({
    requestId: randomUUID(),
    target: { kind: 'word', word: apple },
    voice: 'serena',
  });
  const cached = await data.service.request(input);
  assert.equal(cached.asset?.id, asset.id);
  assert.equal(cached.asset?.voice, 'ryan');
  assert.deepEqual(await data.service.request(input), cached);
  assert.deepEqual((await data.service.file(asset.id)).data, waveFile());
  assert.equal(data.runtime.calls.length, 1);
  assert.deepEqual(data.study.snapshot(), before);
});

test('v2 reserve audio stays separate and sentence recall autoplays only its saved sentence', async (t) => {
  const data = await fixture(t);
  const words = [
    apple,
    book,
    ...Array.from({ length: 4 }, (_, index) => ({
      spelling: `word${index}`,
      meaning: `词义${index}`,
      phonetic: '',
    })),
  ];
  data.begin(words, 'sliding-window-v2');
  const reserve = data.day().flow?.candidates[5];
  assert.ok(reserve);
  const before = data.study.snapshot();
  const reserveAudio = await data.ready({ kind: 'word', word: reserve });
  assert.deepEqual(data.study.snapshot(), before);
  const context = { target: 'daily' as const, dayId: data.day().id, session: 'learning' as const };
  assert.throws(
    () =>
      data.service.authorize({
        requestId: randomUUID(),
        assetId: reserveAudio.id,
        visitId: randomUUID(),
        mode: 'automatic',
        context,
      }),
    hasCode('AUDIO_TARGET_CHANGED'),
  );
  for (let i = 0; i < 4; i++) {
    const visit = data.day().flow?.window.visit;
    assert.ok(visit);
    data.act({
      ...context,
      type: 'window_advance',
      word: visit.word,
      visitId: visit.id,
      remembered: true,
    });
  }
  const visit = data.day().flow?.window.visit;
  assert.ok(visit);
  assert.equal(visit.stage, 1);
  const sentence = data.day().sentences.find((item) => item.word.spelling === visit.word.spelling);
  assert.ok(sentence);
  const asset = await data.ready({ kind: 'sentence', sentence });
  const play = () =>
    data.service.authorize({
      requestId: randomUUID(),
      assetId: asset.id,
      visitId: randomUUID(),
      mode: 'automatic',
      context,
    });
  assert.equal(play().status, 'authorized');
  const wordAudio = await data.ready({ kind: 'word', word: visit.word });
  assert.throws(
    () =>
      data.service.authorize({
        requestId: randomUUID(),
        assetId: wordAudio.id,
        visitId: randomUUID(),
        mode: 'automatic',
        context,
      }),
    hasCode('AUDIO_AUTOPLAY_FORBIDDEN'),
  );
  data.act({
    ...context,
    type: 'window_choose',
    word: visit.word,
    visitId: visit.id,
    remembered: true,
  });
  assert.equal(play().status, 'authorized');
  assert.equal(data.study.snapshot().teaching.exposures.at(-1)?.word.spelling, visit.word.spelling);
});

test('inflected sentence audio follows all three v2 pages and reuses its cached recording', async (t) => {
  const data = await fixture(t);
  const word = { spelling: 'give', meaning: '给', phonetic: '' };
  data.act({
    type: 'begin',
    target: 'daily',
    deck: [word],
    timezone,
    flowVersion: 'sliding-window-v2',
  });
  const context = { target: 'daily' as const, dayId: data.day().id, session: 'learning' as const };
  const sentence = {
    word,
    english: 'She gave me a book.',
    chinese: '她给了我一本书。',
    targetForms: ['gave'],
  };
  data.act({ ...context, type: 'add_sentences', sentences: [sentence] });
  const wordAudio = await data.ready({ kind: 'word', word });
  const audio = await data.ready({ kind: 'sentence', sentence });
  const cached = await data.ready({
    kind: 'sentence',
    sentence: { ...sentence, targetForms: ['GAVE'] },
  });
  assert.equal(cached.id, audio.id, 'Display metadata does not regenerate identical speech');
  const play = (asset: MiniAudioAsset) =>
    data.service.authorize({
      requestId: randomUUID(),
      assetId: asset.id,
      visitId: randomUUID(),
      mode: 'automatic',
      context,
    });
  assert.equal(play(wordAudio).status, 'authorized');
  assert.equal(play(audio).status, 'authorized');
  const advance = () => {
    const visit = data.day().flow?.window.visit;
    assert.ok(visit);
    data.act({
      ...context,
      type: 'window_advance',
      word,
      visitId: visit.id,
      ...(visit.stage === 0 ? { remembered: true } : {}),
    });
  };
  advance();
  assert.equal(data.day().flow?.window.visit?.stage, 1);
  assert.equal(play(audio).status, 'authorized');
  assert.throws(() => play(wordAudio), hasCode('AUDIO_AUTOPLAY_FORBIDDEN'));
  const visit = data.day().flow?.window.visit;
  assert.ok(visit);
  data.act({ ...context, type: 'window_choose', word, visitId: visit.id, remembered: true });
  advance();
  assert.equal(data.day().flow?.window.visit?.stage, 2);
  assert.equal(play(wordAudio).status, 'authorized');
  assert.throws(() => play(audio), hasCode('AUDIO_AUTOPLAY_FORBIDDEN'));
});

test('scratch result pronunciation starts after either answer and cannot autoplay a sentence', async (t) => {
  const data = await fixture(t);
  data.begin([apple], 'sliding-window-v2');
  const context = { target: 'daily' as const, dayId: data.day().id, session: 'learning' as const };
  const word = await data.ready({ kind: 'word', word: apple });
  const sentence = data.day().sentences[0];
  assert.ok(sentence);
  const example = await data.ready({ kind: 'sentence', sentence });
  data.act({ ...context, type: 'open_dictation', word: apple });
  const id = data.study.snapshot().practice.activeDictationId;
  assert.ok(id);
  const play = (asset: MiniAudioAsset) =>
    data.service.authorize({
      requestId: randomUUID(),
      assetId: asset.id,
      visitId: randomUUID(),
      mode: 'automatic',
      context,
    });
  assert.throws(() => play(word), hasCode('AUDIO_AUTOPLAY_FORBIDDEN'));
  for (const answer of ['aple', 'apple']) {
    data.act({ ...context, type: 'submit_dictation', dictationId: id, answer });
    const before = data.study.snapshot().practice.dictations.at(-1)?.attempts;
    assert.equal(play(word).status, 'authorized');
    assert.throws(() => play(example), hasCode('AUDIO_AUTOPLAY_FORBIDDEN'));
    assert.deepEqual(
      data.study.snapshot().practice.dictations.at(-1)?.attempts,
      before,
      'Audio support preserves the already submitted answer and correctness',
    );
  }
});

function beginV2Review(data: Awaited<ReturnType<typeof fixture>>) {
  data.begin([apple], 'sliding-window-v2');
  const learning = { target: 'daily' as const, dayId: data.day().id, session: 'learning' as const };
  for (let i = 0; i < 3; i++) {
    const visit = data.day().flow?.window.visit;
    assert.ok(visit);
    const context = { ...learning, word: visit.word, visitId: visit.id };
    if (visit.stage === 0) data.act({ ...context, type: 'window_advance', remembered: true });
    else {
      data.act({ ...context, type: 'window_choose', remembered: true });
      data.act({ ...context, type: 'window_advance' });
    }
  }
  data.act({
    ...learning,
    type: 'submit_spelling',
    word: apple,
    answer: apple.spelling,
    advanceOnCorrect: false,
  });
  data.act({ ...learning, type: 'advance_spelling', word: apple });
  data.act({
    target: 'daily',
    dayId: data.day().id,
    type: 'publish_writing',
    prompts: [
      {
        id: randomUUID(),
        sentence: {
          word: apple,
          english: 'Please bring an apple today.',
          chinese: '请今天带一个苹果。',
        },
        direction: 'englishToChinese',
        focusIds: [],
      },
    ],
  });
  data.act({ target: 'daily', dayId: data.day().id, type: 'complete_learning' });
  const task = currentTranslation(data.day());
  assert.ok(task);
  data.act({
    target: 'daily',
    dayId: data.day().id,
    type: 'submit_translation',
    taskId: task.id,
    answer: '请今天带个苹果。',
  });
  data.act({ target: 'daily', dayId: data.day().id, type: 'advance_translation', taskId: task.id });
  const memory = data.study.wordContext({ word: apple }).flowMemory;
  assert.ok(memory);
  assert.equal(memory.meaning, null);
  assert.equal(memory.spelling, null);
  assert.equal(memory.dueAt, calendarDue(swiftTime(data.now()), 1, timezone));
  data.setDate('2026-11-17T04:00:00Z');
  data.act({
    target: 'daily',
    type: 'begin',
    deck: [apple],
    timezone,
    flowVersion: 'sliding-window-v2',
  });
  const review = { target: 'daily' as const, dayId: data.day().id, session: 'review' as const };
  return review;
}

test('spelling result autoplay follows committed answers in learning and both review contexts', async (t) => {
  for (const scope of ['learning', 'daily-review', 'legacy-review'] as const) {
    await t.test(scope, async (current) => {
      const data = await fixture(current);
      let context;
      if (scope === 'daily-review') {
        context = beginV2Review(data);
        data.act({ ...context, type: 'choose_judgment', word: apple, judgment: 'clear' });
        data.act({ ...context, type: 'advance_judgment', word: apple, markWrong: false });
      } else {
        data.begin();
        if (scope === 'learning') {
          context = {
            target: 'daily' as const,
            dayId: data.day().id,
            session: 'learning' as const,
          };
          data.act({ ...context, type: 'mark_studied', word: apple });
        } else {
          data.act({ type: 'begin', target: 'review', deck: [apple], timezone });
          const record = data.study.snapshot().reviewRecord;
          assert.ok(record);
          context = { target: 'review' as const, recordId: record.id, session: 'review' as const };
          data.act({ ...context, type: 'choose_judgment', word: apple, judgment: 'clear' });
          data.act({ ...context, type: 'advance_judgment', word: apple, markWrong: false });
        }
      }
      const asset = await data.ready({ kind: 'word', word: apple });
      const other = await data.ready({ kind: 'word', word: book });
      const sentence = data.day().sentences[0];
      assert.ok(sentence);
      const sentenceAsset = await data.ready({ kind: 'sentence', sentence });
      const automatic = (value = asset) =>
        data.service.authorize({
          requestId: randomUUID(),
          assetId: value.id,
          visitId: randomUUID(),
          mode: 'automatic',
          context,
        });
      const session = () =>
        context.target === 'review'
          ? data.study.snapshot().reviewRecord?.session
          : context.session === 'review'
            ? data.day().review
            : data.day().learning;
      assert.throws(() => automatic(), hasCode('AUDIO_AUTOPLAY_FORBIDDEN'));
      for (const answer of ['aple', 'appl', 'apple']) {
        data.act({
          ...context,
          type: 'submit_spelling',
          word: apple,
          answer,
          advanceOnCorrect: false,
        });
        const original = structuredClone(session()?.spellingAttempts);
        assert.equal(automatic().status, 'authorized');
        assert.throws(() => automatic(other), hasCode('AUDIO_TARGET_CHANGED'));
        assert.throws(() => automatic(sentenceAsset), hasCode('AUDIO_AUTOPLAY_FORBIDDEN'));
        assert.deepEqual(session()?.spellingAttempts, original);
        assert.equal(
          data.study.snapshot().teaching.exposures.at(-1)?.beforeAttemptCount,
          original?.length,
        );
      }
      data.act({ ...context, type: 'advance_spelling', word: apple });
      assert.equal(session()?.spellingState, 'awaitingFirst');
      assert.throws(() => automatic(), hasCode('AUDIO_AUTOPLAY_FORBIDDEN'));
    });
  }
});

test('v2 review card relearning authorizes its actual word and sentence after the judgment queue empties', async (t) => {
  const data = await fixture(t);
  const review = beginV2Review(data);
  for (let i = 0; i < 3; i++) {
    data.act({ ...review, type: 'choose_judgment', word: apple, judgment: 'forgotten' });
    data.act({ ...review, type: 'advance_judgment', word: apple, markWrong: false });
  }
  assert.equal(data.day().review?.queue.length, 0);
  assert.equal(data.day().review?.relearning?.visit?.stage, 0);
  const sentence = data.day().sentences.find((item) => item.word.spelling === apple.spelling);
  assert.ok(sentence);
  for (const target of [
    { kind: 'word' as const, word: apple },
    { kind: 'sentence' as const, sentence },
  ]) {
    const asset = await data.ready(target);
    const receipt = data.service.authorize({
      requestId: randomUUID(),
      assetId: asset.id,
      visitId: randomUUID(),
      mode: 'automatic',
      context: review,
    });
    assert.equal(receipt.status, 'authorized');
  }
  assert.ok(
    data.study
      .snapshot()
      .teaching.exposures.filter((item) => item.dayId === review.dayId)
      .every((item) => item.session === 'review' && item.word.spelling === 'apple'),
  );
});

test('v2 real automatic word audio before a clear judgment preserves meaning Good and still exposes spelling', async (t) => {
  const data = await fixture(t);
  const review = beginV2Review(data);
  const asset = await data.ready({ kind: 'word', word: apple });
  const playback = data.service.authorize({
    requestId: randomUUID(),
    assetId: asset.id,
    visitId: randomUUID(),
    mode: 'automatic',
    context: review,
  });
  data.service.started({
    requestId: randomUUID(),
    playbackId: playback.id,
    occurredAt: swiftTime(data.now()),
  });
  const exposure = data.study.snapshot().teaching.exposures.at(-1);
  assert.equal(exposure?.audioKind, 'word');
  assert.equal(exposure?.beforeJudgmentCount, 0);
  assert.throws(() =>
    data.act({
      ...review,
      type: 'record_exposure',
      word: apple,
      kind: 'potentialHelp',
      source: 'chat',
      audioKind: 'word',
      focusIds: [],
    }),
  );
  data.act({ ...review, type: 'choose_judgment', word: apple, judgment: 'clear' });
  data.act({ ...review, type: 'advance_judgment', word: apple, markWrong: false });
  data.act({
    ...review,
    type: 'submit_spelling',
    word: apple,
    answer: apple.spelling,
    advanceOnCorrect: false,
  });
  data.act({ ...review, type: 'advance_spelling', word: apple });
  data.act({ target: 'daily', dayId: review.dayId, type: 'complete_review' });
  const events = data.study
    .snapshot()
    .scheduling.flow.events.filter(
      (event) => event.kind === 'review' && event.sourceId === review.dayId,
    );
  assert.equal(events.find((event) => event.evidence === 'self_report')?.meaning, 'Good');
  assert.equal(events.find((event) => event.id.endsWith('/spelling'))?.spelling, null);
  assert.equal(data.day().review?.spellingAttempts[0]?.lastPotentialHelpAt, exposure?.at);
});

test('play authorization and actual started receipts are separate, immutable and case-insensitive', async (t) => {
  const data = await fixture(t);
  data.begin();
  const asset = await data.ready({ kind: 'word', word: apple });
  const input = {
    requestId: randomUUID(),
    assetId: asset.id,
    visitId: randomUUID(),
    mode: 'automatic' as const,
    context: { target: 'daily' as const, dayId: data.day().id, session: 'learning' as const },
  };
  const authorized = data.service.authorize(input);
  assert.equal(authorized.status, 'authorized');
  assert.equal(authorized.startedAt, null);
  assert.equal(data.service.snapshot().playbacks[0]?.startedAt, null);
  assert.equal(data.study.snapshot().teaching.exposures.length, 1);
  const beforeStart = data.study.snapshot();
  assert.deepEqual(
    data.service.authorize({
      ...input,
      requestId: input.requestId.toUpperCase(),
      assetId: input.assetId.toUpperCase(),
      visitId: input.visitId.toUpperCase(),
    }),
    authorized,
  );
  data.setDate('2026-11-16T04:00:01Z');
  const start = {
    requestId: randomUUID(),
    playbackId: authorized.id,
    occurredAt: swiftTime(data.now()),
  };
  const started = data.service.started(start);
  assert.equal(started.status, 'started');
  assert.equal(started.startedAt, start.occurredAt);
  assert.deepEqual(
    data.service.started({
      ...start,
      requestId: start.requestId.toUpperCase(),
      playbackId: start.playbackId.toUpperCase(),
    }),
    started,
  );
  assert.throws(
    () =>
      data.service.started({ ...start, requestId: randomUUID(), occurredAt: start.occurredAt + 1 }),
    hasCode('AUDIO_PLAYBACK_CONFLICT'),
  );
  assert.throws(
    () =>
      data.service.started({
        ...start,
        requestId: randomUUID(),
        occurredAt: authorized.authorizedAt - 10,
      }),
    hasCode('AUDIO_PLAYBACK_TIME_INVALID'),
  );
  assert.throws(
    () =>
      data.service.started({
        ...start,
        requestId: randomUUID(),
        occurredAt: start.occurredAt + 301,
      }),
    hasCode('AUDIO_PLAYBACK_TIME_INVALID'),
  );
  assert.deepEqual(data.study.snapshot(), beforeStart);
});

test('browsing an answer word or another target sentence containing it still records support for the active spelling', async (t) => {
  for (const kind of ['word', 'sentence'] as const) {
    await t.test(kind, async (subtest) => {
      const data = await fixture(subtest);
      data.begin([apple, book]);
      for (const word of data.day().learningWords)
        data.act({ type: 'mark_studied', target: 'daily', dayId: data.day().id, word });
      const target: MiniAudioTarget =
        kind === 'word'
          ? { kind, word: apple }
          : {
              kind,
              sentence: {
                word: book,
                english: 'The book is beside an apple.',
                chinese: '书在一个苹果旁边。',
              },
            };
      const asset = await data.ready(target);
      data.service.authorize({
        requestId: randomUUID(),
        assetId: asset.id,
        visitId: randomUUID(),
        mode: 'manual',
      });
      assert.equal(data.study.snapshot().teaching.exposures.at(-1)?.word.spelling, 'apple');
      data.act({
        type: 'submit_spelling',
        target: 'daily',
        dayId: data.day().id,
        session: 'learning',
        word: apple,
        answer: 'apple',
      });
      const first = data
        .day()
        .learning?.spellingAttempts.find((item) => item.word.spelling === 'apple');
      assert.ok(first?.correct);
      assert.equal(first.lastPotentialHelpAt, swiftTime(data.now()));
      while (data.day().learning?.queue[0]) {
        const word = data.day().learning?.queue[0];
        assert.ok(word);
        data.act({
          type: 'submit_spelling',
          target: 'daily',
          dayId: data.day().id,
          session: 'learning',
          word,
          answer: word.spelling,
        });
      }
      data.act({ type: 'complete_learning', target: 'daily', dayId: data.day().id });
      assert.equal(
        data.day().scheduleUpdates.find((item) => item.word.spelling === 'apple')?.dueAt,
        calendarDue(swiftTime(data.now()), 1, timezone),
      );
    });
  }
});

test('audio after a saved first answer does not rewrite that answer or its original help condition', async (t) => {
  const data = await fixture(t);
  data.begin();
  data.act({ type: 'mark_studied', target: 'daily', dayId: data.day().id, word: apple });
  data.act({
    type: 'submit_spelling',
    target: 'daily',
    dayId: data.day().id,
    session: 'learning',
    word: apple,
    answer: 'appl',
  });
  const original = structuredClone(data.day().learning?.spellingAttempts[0]);
  assert.ok(original);
  assert.equal(original.lastPotentialHelpAt, undefined);
  const asset = await data.ready({ kind: 'word', word: apple });
  const authorization = data.service.authorize({
    requestId: randomUUID(),
    assetId: asset.id,
    visitId: randomUUID(),
    mode: 'manual',
    context: { target: 'daily', dayId: data.day().id, session: 'learning' },
  });
  data.service.started({
    requestId: randomUUID(),
    playbackId: authorization.id,
    occurredAt: swiftTime(data.now()),
  });
  assert.deepEqual(data.day().learning?.spellingAttempts[0], original);
  assert.equal(data.study.snapshot().teaching.exposures.at(-1)?.beforeAttemptCount, 1);
});

test('automatic playback, stale sessions and homograph pronunciation identities cannot bypass the current card', async (t) => {
  const data = await fixture(t);
  const current: MiniWord = { spelling: 'read', meaning: '阅读，原形', phonetic: '/riːd/' };
  const previous: MiniWord = { spelling: 'read', meaning: '读过，过去式', phonetic: '/red/' };
  data.begin([current]);
  const originalAsset = await data.ready({ kind: 'word', word: current });
  const wrongPronunciation = await data.ready({ kind: 'word', word: previous });
  const context = { target: 'daily' as const, dayId: data.day().id, session: 'learning' as const };
  const before = data.study.snapshot();
  assert.throws(
    () =>
      data.service.authorize({
        requestId: randomUUID(),
        assetId: wrongPronunciation.id,
        visitId: randomUUID(),
        mode: 'manual',
        context,
      }),
    hasCode('AUDIO_TARGET_CHANGED'),
  );
  assert.throws(
    () =>
      data.service.authorize({
        requestId: randomUUID(),
        assetId: originalAsset.id,
        visitId: randomUUID(),
        mode: 'automatic',
        context: { ...context, session: 'review' },
      }),
    hasCode('AUDIO_TARGET_CHANGED'),
  );
  assert.deepEqual(data.study.snapshot(), before);
  data.act({ type: 'mark_studied', target: 'daily', dayId: data.day().id, word: current });
  assert.throws(
    () =>
      data.service.authorize({
        requestId: randomUUID(),
        assetId: originalAsset.id,
        visitId: randomUUID(),
        mode: 'automatic',
        context,
      }),
    hasCode('AUDIO_AUTOPLAY_FORBIDDEN'),
  );
});

test('new-word automatic sequences follow the memory target and require a full visible card', async (t) => {
  const data = await fixture(t);
  data.begin([apple, book], 'memory-rounds-v1');
  const context = { target: 'daily' as const, dayId: data.day().id, session: 'learning' as const };
  const sentence = data.day().sentences.find((item) => item.word.spelling === apple.spelling);
  assert.ok(sentence);
  const wordAsset = await data.ready({ kind: 'word', word: apple });
  const sentenceAsset = await data.ready({ kind: 'sentence', sentence });
  const bookAsset = await data.ready({ kind: 'word', word: book });
  const visitId = randomUUID();
  const automatic = (asset: MiniAudioAsset) =>
    data.service.authorize({
      requestId: randomUUID(),
      assetId: asset.id,
      visitId,
      mode: 'automatic',
      context,
    });
  const wordReceipt = automatic(wordAsset);
  const sentenceReceipt = automatic(sentenceAsset);
  assert.equal(wordReceipt.visitId, sentenceReceipt.visitId);
  assert.notEqual(wordReceipt.id, sentenceReceipt.id);
  for (const receipt of [wordReceipt, sentenceReceipt])
    assert.equal(
      data.service.started({
        requestId: randomUUID(),
        playbackId: receipt.id,
        occurredAt: swiftTime(data.now()),
      }).status,
      'started',
    );
  const advance = (word: MiniWord, round: number) =>
    data.act({
      type: 'memory_advance',
      target: 'daily',
      dayId: context.dayId,
      word,
      round,
      remembered: true,
    });
  advance(apple, 1);
  assert.equal(
    automatic(bookAsset).status,
    'authorized',
    'Memory target takes precedence over the first unstudied word.',
  );
  advance(book, 1);
  for (const asset of [wordAsset, sentenceAsset])
    assert.throws(() => automatic(asset), hasCode('AUDIO_AUTOPLAY_FORBIDDEN'));
  data.act({ type: 'memory_reveal', target: 'daily', dayId: context.dayId, word: apple, round: 2 });
  assert.equal(automatic(sentenceAsset).status, 'authorized');
  advance(apple, 2);
  advance(book, 2);
  assert.equal(data.day().memory?.round, 3);
  assert.throws(() => automatic(sentenceAsset), hasCode('AUDIO_AUTOPLAY_FORBIDDEN'));
  data.act({ type: 'memory_reveal', target: 'daily', dayId: context.dayId, word: apple, round: 3 });
  assert.equal(automatic(wordAsset).status, 'authorized');
  assert.equal(automatic(sentenceAsset).status, 'authorized');
  advance(apple, 3);
  advance(book, 3);
  assert.equal(data.day().memory?.round, 4);
  assert.throws(() => automatic(wordAsset), hasCode('AUDIO_AUTOPLAY_FORBIDDEN'));
  assert.throws(() => automatic(sentenceAsset), hasCode('AUDIO_AUTOPLAY_FORBIDDEN'));
});

test('review sentence autoplay requires a selected judgment and the exact displayed saved example', async (t) => {
  for (const judgment of ['clear', 'fuzzy', 'forgotten'] as const) {
    await t.test(judgment, async (current) => {
      const data = await fixture(current);
      data.begin();
      const sentence = data.day().sentences[0];
      assert.ok(sentence);
      const asset = await data.ready({ kind: 'sentence', sentence });
      const different = await data.ready({
        kind: 'sentence',
        sentence: { ...sentence, english: 'This apple is red.' },
      });
      data.act({ type: 'begin', target: 'review', deck: [apple], timezone });
      const record = data.study.snapshot().reviewRecord;
      assert.ok(record);
      const context = { target: 'review' as const, recordId: record.id };
      const automatic = (value = asset) =>
        data.service.authorize({
          requestId: randomUUID(),
          assetId: value.id,
          visitId: randomUUID(),
          mode: 'automatic',
          context,
        });
      const before = data.study.snapshot();
      assert.throws(() => automatic(), hasCode('AUDIO_AUTOPLAY_FORBIDDEN'));
      assert.deepEqual(data.study.snapshot(), before);
      data.act({
        type: 'choose_judgment',
        target: 'review',
        recordId: record.id,
        word: apple,
        judgment,
      });
      assert.equal(automatic().status, 'authorized');
      assert.throws(() => automatic(different), hasCode('AUDIO_AUTOPLAY_FORBIDDEN'));
      data.act({ type: 'clear_judgment', target: 'review', recordId: record.id, word: apple });
      assert.throws(() => automatic(), hasCode('AUDIO_AUTOPLAY_FORBIDDEN'));
    });
  }
});

test('automatic sentence playback rejects foreign targets and requires an active matching card', async (t) => {
  const data = await fixture(t);
  const foreign = await data.ready({
    kind: 'sentence',
    sentence: { word: book, english: 'An apple is on the book.', chinese: '一个苹果在书上。' },
  });
  const asset = await data.ready({ kind: 'word', word: apple });
  assert.throws(
    () =>
      data.service.authorize({
        requestId: randomUUID(),
        assetId: asset.id,
        visitId: randomUUID(),
        mode: 'automatic',
      }),
    hasCode('AUDIO_AUTOPLAY_FORBIDDEN'),
  );
  data.begin();
  const before = data.study.snapshot();
  assert.throws(
    () =>
      data.service.authorize({
        requestId: randomUUID(),
        assetId: foreign.id,
        visitId: randomUUID(),
        mode: 'automatic',
        context: { target: 'daily', dayId: data.day().id, session: 'learning' },
      }),
    hasCode('AUDIO_AUTOPLAY_FORBIDDEN'),
  );
  assert.deepEqual(data.study.snapshot(), before);
});

test('autoplay reuses matching English audio when its cached Chinese translation differs', async (t) => {
  const data = await fixture(t);
  const cached = await data.ready({
    kind: 'sentence',
    sentence: { word: apple, english: 'I  see an apple.', chinese: '旧译文。' },
  });
  data.begin();
  const sentence = data.day().sentences[0];
  assert.ok(sentence);
  const current = await data.ready({ kind: 'sentence', sentence });
  assert.equal(current.id, cached.id);
  assert.equal(current.target.kind, 'sentence');
  if (current.target.kind === 'sentence')
    assert.notEqual(current.target.sentence.chinese, sentence.chinese);
  const receipt = data.service.authorize({
    requestId: randomUUID(),
    assetId: current.id,
    visitId: randomUUID(),
    mode: 'automatic',
    context: { target: 'daily', dayId: data.day().id, session: 'learning' },
  });
  assert.equal(receipt.status, 'authorized');
  assert.equal(data.runtime.calls.length, 1);
});

test('audio files use authenticated binary routes and corrupted files never masquerade as playable assets', async (t) => {
  const data = await fixture(t);
  const asset = await data.ready({ kind: 'word', word: apple });
  const app = data.http();
  const url = `/api/mini/audio/assets/${asset.id}/file`;
  const headers = { authorization: `Bearer ${'a'.repeat(64)}` };
  const forbidden = await app.inject({ method: 'GET', url });
  assert.equal(forbidden.statusCode, 401);
  const browser = await app.inject({
    method: 'GET',
    url,
    headers: { ...headers, origin: 'https://example.com' },
  });
  assert.equal(browser.statusCode, 403);
  const response = await app.inject({ method: 'GET', url, headers });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-type'] ?? '', /^audio\/wav/);
  assert.deepEqual(response.rawPayload, waveFile());
  await writeFile(join(data.directory, 'private-token'), 'isolated-secret-must-not-be-served');
  const traversal = await app.inject({
    method: 'GET',
    url: '/api/mini/audio/assets/..%2Fprivate-token/file',
    headers,
  });
  assert.ok(traversal.statusCode === 400 || traversal.statusCode === 404);
  assert.ok(!traversal.body.includes('isolated-secret-must-not-be-served'));
  const path = join(data.audioDirectory, asset.fileName);
  const corrupted = await readFile(path);
  corrupted.write('not-wave', 0);
  await writeFile(path, corrupted);
  const broken = await app.inject({ method: 'GET', url, headers });
  assert.equal(broken.statusCode, 404);
  assert.ok(!broken.body.includes(data.audioDirectory));
});
