import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  miniAiKindSchema,
  miniCommandSchema,
  miniHistoryInputSchema,
  miniWordContextInputSchema,
  miniAudioTargetSchema,
  miniAudioRequestSchema,
} from '@lingoweave/contracts';
import { miniAiActionOptions } from './mini-ai-policy.js';
const env = z
  .object({
    LINGOWEAVE_MINI_AI_URL: z.url(),
    LINGOWEAVE_MINI_AI_TOKEN: z.string().min(32),
    LINGOWEAVE_MINI_AI_KIND: miniAiKindSchema,
    LINGOWEAVE_MINI_AI_AUDIO: z.enum(['0', '1']).default('0'),
  })
  .parse(process.env);
const url = new URL(env.LINGOWEAVE_MINI_AI_URL);
if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1')
  throw new Error('Only the local mini service is supported.');
const server = new McpServer(
  { name: 'lingoweave-mini', version: '0.1.0' },
  {
    instructions:
      'Read current context and its allowedActions before writing. Only a saved receipt confirms a change. The learner owns answers and self-assessments.',
  },
);
async function call(action: string, input?: unknown) {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.LINGOWEAVE_MINI_AI_TOKEN}`,
      },
      body: JSON.stringify({ action, input }),
      signal: AbortSignal.timeout(15000),
    });
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(await response.json()) }],
      isError: !response.ok,
    };
  } catch {
    return {
      content: [
        {
          type: 'text' as const,
          text: '连接中断，保存状态未知。沿用同一请求身份重试，不要声称已经保存。',
        },
      ],
      isError: true,
    };
  }
}
server.registerTool(
  'learning_get_context',
  {
    description:
      'Read the assigned mini task, true plan, activity summary, existing focus and memory, saved conversation and allowed write actions. Read this first; use its revision for commits.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  () => call('context'),
);
server.registerTool(
  'learning_get_history',
  {
    description:
      'Read paginated actual history, including imported records, first answers, corrections, support exposures and plan changes. Missing records mean unknown, not failure.',
    inputSchema: miniHistoryInputSchema.shape,
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  (input) => call('history', input),
);
server.registerTool(
  'learning_get_word',
  {
    description:
      'Read a known word sense, stable senseId, existing focus items, recent original evidence and focus capacity. Prefer reusing an existing focus.',
    inputSchema: miniWordContextInputSchema.shape,
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  (input) => call('word', input),
);
server.registerTool(
  'learning_commit',
  {
    description:
      'Commit only an action in the current context allowedActions. Never submit user answers, self-ratings, mastery or scheduling. Use a UUID requestId and the context revision. Keep identical request identity/content on uncertain retries; re-read context after revision conflicts. Memory must cite sourceMessageId from the saved user message.',
    inputSchema: miniCommandSchema.extend({
      action: z.union(miniAiActionOptions(env.LINGOWEAVE_MINI_AI_KIND)),
    }).shape,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  (input) => call('commit', input),
);
if (env.LINGOWEAVE_MINI_AI_KIND === 'advisor' && env.LINGOWEAVE_MINI_AI_AUDIO === '1') {
  server.registerTool(
    'learning_get_audio',
    {
      description:
        'Read cached audio and generation status for a saved word or sentence without generating or playing anything. Use the exact saved target. A queued job is not a ready recording.',
      inputSchema: { target: miniAudioTargetSchema },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (input) => call('audio_status', input.target),
  );
  server.registerTool(
    'learning_generate_audio',
    {
      description:
        'Ensure a missing English word/sentence recording, or regenerate one recording only when the user requests it. Use a stable UUID requestId. Existing audio is reused; regeneration failure keeps the old recording. This tool never plays audio, submits learner answers or changes scheduling. Report queued/running/completed accurately and query status before claiming audio is ready.',
      inputSchema: miniAudioRequestSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (input) => call('audio_request', input),
  );
}
await server.connect(new StdioServerTransport());
