import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { z } from 'zod';
import { MiniMaterialLibrary } from './mini-materials.js';
import { MiniStore } from './mini-store.js';
import { MiniAiStore } from './mini-ai-store.js';
import { MiniAiService } from './mini-ai-service.js';
import type { PreparationRuntime } from './preparation-service.js';

const word = { spelling: 'book', meaning: '书', phonetic: '' };
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'lingoweave-materials-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'sources'));
  const raw =
    'Header\n*** START OF THE PROJECT GUTENBERG EBOOK FIXTURE ***\n\n' +
    'I have a book. I read my book every day.\n\n' +
    'This unrelated sentence has four words.\n\n' +
    '*** END OF THE PROJECT GUTENBERG EBOOK FIXTURE ***\nLicense';
  writeFileSync(join(directory, 'sources', 'fixture.txt'), raw);
  writeFileSync(
    join(directory, 'catalog.json'),
    JSON.stringify({
      schemaVersion: 1,
      books: [
        {
          id: 'fixture',
          title: '测试原文',
          url: 'https://example.com/fixture',
          fileName: 'fixture.txt',
          sha256: createHash('sha256').update(raw).digest('hex'),
        },
      ],
    }),
  );
  return directory;
}

test('material candidates retain verified source identity and reject changed wording or book titles', (t) => {
  const directory = fixture(t);
  const library = new MiniMaterialLibrary(directory);
  const context = library.context([word], 'A1');
  assert.equal(context.error, null);
  assert.equal(context.books.length, 1);
  const quote = context.candidates[0]?.quotes[0];
  assert.ok(quote);
  assert.equal(quote.english, 'I have a book.');
  library.validate({ word, ...quote, chinese: '我有一本书。' });
  assert.throws(
    () => library.validate({ word, ...quote, english: 'I have a red book.', chinese: '' }),
    { code: 'MATERIAL_SOURCE_INVALID' },
  );
  assert.throws(
    () =>
      library.validate({
        word,
        ...quote,
        source: { ...quote.source, title: '伪造书名' },
        chinese: '',
      }),
    { code: 'MATERIAL_SOURCE_INVALID' },
  );
  assert.deepEqual(new MiniMaterialLibrary(directory).context([word], 'A1'), context);
  library.validate({ word, english: 'My own example.', chinese: '自拟句子。' });
});

test('missing or changed source files yield explicit unavailable material without accepting a quotation', (t) => {
  const directory = fixture(t);
  const before = new MiniMaterialLibrary(directory).context([word], 'A1').candidates[0]?.quotes[0];
  assert.ok(before);
  writeFileSync(join(directory, 'sources', 'fixture.txt'), 'Changed text');
  const changed = new MiniMaterialLibrary(directory);
  assert.ok(changed.context([word], 'A1').error);
  assert.equal(changed.context([word], 'A1').candidates[0]?.quotes.length, 0);
  assert.throws(() => changed.validate({ word, ...before, chinese: '' }), {
    code: 'MATERIAL_SOURCE_INVALID',
  });
  rmSync(join(directory, 'sources', 'fixture.txt'));
  assert.ok(new MiniMaterialLibrary(directory).context([word], 'A1').error);
  assert.equal(
    new MiniMaterialLibrary(join(directory, 'absent')).context([word], 'A1').error,
    null,
  );
});

test('AI context supplies quotations and commits validate their provenance before saving', async (t) => {
  const directory = fixture(t);
  const library = new MiniMaterialLibrary(directory);
  const study = new MiniStore(':memory:');
  const ai = new MiniAiStore(':memory:');
  ai.importLegacy({ requestId: randomUUID(), conversations: [] });
  const timezone = 'Asia/Shanghai';
  study.importLegacy({
    requestId: randomUUID(),
    timezone,
    ledger: { days: [] },
    reviewRecord: null,
    reviewHistory: [],
  });
  study.command({
    requestId: randomUUID(),
    expectedRevision: study.snapshot().revision,
    action: { type: 'begin', target: 'daily', deck: [word], timezone },
  });
  const dayId = study.snapshot().planning.activeDayId;
  assert.ok(dayId);
  const runtime: PreparationRuntime = {
    status: async () => ({
      available: true,
      authenticated: true,
      version: 'fixture',
      models: [
        {
          id: 'gpt-6.1-sol',
          name: 'Fixture',
          isDefault: true,
          supportedReasoningEfforts: ['xhigh'],
        },
      ],
      error: null,
    }),
    close: async () => {},
    prepare: async (options) => {
      const token = options.mcp.env.LINGOWEAVE_MINI_AI_TOKEN;
      assert.ok(token);
      const context = z
        .object({
          revision: z.number(),
          materials: z.object({
            candidates: z.array(
              z.object({
                quotes: z.array(
                  z.object({
                    english: z.string(),
                    source: z.object({
                      id: z.string(),
                      title: z.string(),
                      url: z.string(),
                      locator: z.string(),
                    }),
                  }),
                ),
              }),
            ),
          }),
        })
        .parse(service.tool(options.jobId, token, 'context', {}));
      const quote = context.materials.candidates[0]?.quotes[0];
      assert.ok(quote);
      const command = {
        requestId: randomUUID(),
        expectedRevision: context.revision,
        action: {
          type: 'add_sentences',
          target: 'daily',
          dayId,
          sentences: [{ word, ...quote, chinese: '我有一本书。' }],
        },
      };
      const fake = structuredClone(command);
      const fakeSentence = fake.action.sentences[0];
      assert.ok(fakeSentence);
      fakeSentence.source.title = '伪造书名';
      assert.throws(() => service.tool(options.jobId, token, 'commit', fake), {
        code: 'MATERIAL_SOURCE_INVALID',
      });
      assert.equal(study.snapshot().revision, context.revision);
      service.tool(options.jobId, token, 'commit', command);
      return { threadId: 'fixture', model: options.model ?? 'gpt-6.1-sol' };
    },
  };
  const service = new MiniAiService(study, ai, runtime, undefined, undefined, library);
  service.setBaseUrl('http://127.0.0.1:12345');
  t.after(async () => {
    await service.close();
    study.close();
  });
  const job = service.start({
    requestId: randomUUID(),
    kind: 'prepare',
    timezone,
    dayId,
    conversationId: 'lesson',
    model: 'gpt-6.1-sol',
    effort: 'xhigh',
  });
  for (let index = 0; index < 100 && ['queued', 'running'].includes(ai.job(job.id).status); index++)
    await setImmediate();
  assert.equal(ai.job(job.id).status, 'completed');
  assert.equal(ai.job(job.id).receipts.length, 1);
  assert.equal(study.snapshot().ledger.days[0]?.sentences[0]?.source?.title, '测试原文');
});
