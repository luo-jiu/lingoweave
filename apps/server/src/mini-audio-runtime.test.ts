import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { z } from 'zod';
import { LocalMiniTtsRuntime } from './mini-audio-runtime.js';

test('speech runtime forwards explicit generation parameters and retains legacy sentence defaults', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lingoweave-runtime-parameters-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'runtime/bin'), { recursive: true });
  await mkdir(join(root, 'models'));
  const weights = Buffer.from('fixture');
  await writeFile(join(root, 'models', 'weights'), weights);
  await writeFile(
    join(root, 'model-manifest.json'),
    JSON.stringify({
      repository: 'test',
      revision: 'a'.repeat(40),
      directory: 'models',
      files: [
        {
          path: 'weights',
          size: weights.length,
          sha256: createHash('sha256').update(weights).digest('hex'),
        },
      ],
    }),
  );
  await writeFile(
    join(root, 'installation.json'),
    JSON.stringify({ mlx_audio: 'test', mlx: 'test' }),
  );
  await writeFile(
    join(root, 'runtime/bin/python'),
    `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const { join } = require('node:path');
const { createInterface } = require('node:readline');
const root = process.argv[4];
process.stdout.write(JSON.stringify({type:'ready',engineVersion:'test/mlx-test'})+'\\n');
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  appendFileSync(join(root,'requests.jsonl'),JSON.stringify(request)+'\\n');
  if (request.text === 'rejected') {
    process.stdout.write(JSON.stringify({type:'error',code:'TTS_WORD_INVALID'})+'\\n');
    return;
  }
  process.stdout.write(JSON.stringify({type:'complete',id:request.id,tokenCount:10,durationSeconds:.8,attempts:1})+'\\n');
});
`,
  );
  await chmod(join(root, 'runtime/bin/python'), 0o700);
  const runtime = new LocalMiniTtsRuntime(root, { timeoutMs: 5000 });
  t.after(() => runtime.close());
  const parameters = {
    kind: 'word' as const,
    temperature: 0.3,
    maxTokens: 64,
    maximumDurationSeconds: 2.5,
  };
  await runtime.generate({
    text: 'bag',
    voice: 'ryan',
    instructions: '',
    outputFile: join(root, 'word.wav'),
    signal: new AbortController().signal,
    parameters,
  });
  await assert.rejects(
    runtime.generate({
      text: 'rejected',
      voice: 'ryan',
      instructions: '',
      outputFile: join(root, 'rejected.wav'),
      signal: new AbortController().signal,
      parameters,
    }),
    { code: 'TTS_WORD_INVALID' },
  );
  await runtime.generate({
    text: 'This is a bag.',
    voice: 'serena',
    instructions: 'Read clearly.',
    outputFile: join(root, 'sentence.wav'),
    signal: new AbortController().signal,
  });
  await assert.rejects(
    runtime.generate({
      text: 'bag',
      voice: 'ryan',
      instructions: '',
      outputFile: join(root, 'invalid.wav'),
      signal: new AbortController().signal,
      parameters: { ...parameters, maxTokens: 0 },
    }),
  );
  const requests: unknown[] = (await readFile(join(root, 'requests.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(requests.length, 3);
  const firstId = z.object({ id: z.uuid() }).parse(requests[0]).id;
  assert.deepEqual(requests[0], {
    type: 'generate',
    id: firstId,
    text: 'bag',
    voice: 'ryan',
    instructions: '',
    outputFile: join(root, 'word.wav'),
    parameters,
  });
  assert.equal(
    Object.hasOwn(z.record(z.string(), z.unknown()).parse(requests[2]), 'parameters'),
    false,
  );
});

test('word worker retries complete candidates and never writes rejected or partial audio', (t) => {
  const worker = fileURLToPath(new URL('../../../scripts/mini-tts-worker.py', import.meta.url));
  const program = String.raw`
import importlib.util, math, pathlib, sys, tempfile, types
spec = importlib.util.spec_from_file_location("mini_worker", sys.argv[1])
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
class Audio:
    ndim = 1
    def __init__(self, values): self.values = values
    def __len__(self): return len(self.values)
    def astype(self, _): return self
    def __pow__(self, power): return Audio([value ** power for value in self.values])
np = types.SimpleNamespace(
    asarray=lambda values: Audio(values),
    concatenate=lambda pieces: Audio([value for piece in pieces for value in piece.values]),
    isfinite=lambda audio: types.SimpleNamespace(all=lambda: all(math.isfinite(value) for value in audio.values)),
    sqrt=math.sqrt, mean=lambda audio: sum(audio.values) / len(audio.values), float64=float)
mx = types.SimpleNamespace(clear_cache=lambda: None)
class Model:
    def __init__(self, candidates): self.candidates = iter(candidates); self.calls = []
    def generate(self, **options):
        self.calls.append(options)
        duration, tokens = next(self.candidates)
        yield types.SimpleNamespace(audio=[.02] * int(duration * 24000), sample_rate=24000, token_count=tokens)
with tempfile.TemporaryDirectory(prefix="lingoweave-word-worker-") as directory:
    destination = pathlib.Path(directory) / "audio.wav"
    request = dict(text="bag", voice="ryan", instructions="A previous caller supplied a long style prompt.",
        outputFile=str(destination), parameters=dict(kind="word",temperature=.3,maxTokens=64,maximumDurationSeconds=2.5))
    writes = []
    def write(path, audio, rate, **options):
        writes.append(len(audio)); pathlib.Path(path).write_bytes(b"accepted")
    model = Model([(1, 64), (.8, 10)])
    result = worker.generate_request(model, request, np, write, mx)
    assert result == dict(tokenCount=10, durationSeconds=.8, attempts=2)
    assert len(model.calls) == 2 and writes == [19200]
    assert [call["text"] for call in model.calls] == ["bag", "bag."]
    assert all(call["instruct"] is None for call in model.calls)
    assert {key:value for key,value in model.calls[0].items() if key != "text"} == {key:value for key,value in model.calls[1].items() if key != "text"}
    assert model.calls[0]["temperature"] == .3 and model.calls[0]["max_tokens"] == 64
    destination.unlink(); writes.clear()
    rejected = Model([(4.08, 51), (1, 64)])
    try: worker.generate_request(rejected, request, np, write, mx)
    except worker.GenerationRejected: pass
    else: raise AssertionError("Rejected word generation was accepted")
    assert len(rejected.calls) == 2 and not writes and not destination.exists()
    punctuated = dict(request); punctuated["text"] = "bag."
    existing_punctuation = Model([(4.08, 51), (.8, 10)])
    worker.generate_request(existing_punctuation, punctuated, np, write, mx)
    assert [call["text"] for call in existing_punctuation.calls] == ["bag.", "bag."]
    destination.unlink(); writes.clear()
    def broken_write(path, *_args, **_options):
        pathlib.Path(path).write_bytes(b"partial"); raise OSError("fixture write failure")
    try: worker.generate_request(Model([(.8, 10)]), request, np, broken_write, mx)
    except OSError: pass
    else: raise AssertionError("Partial write failure was ignored")
    assert not destination.exists()
    legacy = dict(request); legacy.pop("parameters"); legacy["text"] = "This is a bag."
    sentence = Model([(4, 50)])
    worker.generate_request(sentence, legacy, np, write, mx)
    assert len(sentence.calls) == 1
    assert sentence.calls[0]["temperature"] == .7 and sentence.calls[0]["max_tokens"] == 2048
    assert sentence.calls[0]["instruct"] == legacy["instructions"]
`;
  const result = spawnSync('python3', ['-B', '-c', program, worker], { encoding: 'utf8' });
  if (result.error && 'code' in result.error && result.error.code === 'ENOENT') {
    t.skip('Python is unavailable for the optional local speech worker.');
    return;
  }
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
});
