import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { miniAssessmentCommitSchema, miniExpressionBatchSchema } from '@lingoweave/contracts';

const env = z
  .object({
    LINGOWEAVE_MINI_ASSESSMENT_MODE: z.literal('expression').optional(),
    LINGOWEAVE_MINI_ASSESSMENT_URL: z.url(),
    LINGOWEAVE_MINI_ASSESSMENT_TOKEN: z.string().min(32),
  })
  .parse(process.env);
const url = new URL(env.LINGOWEAVE_MINI_ASSESSMENT_URL);
if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1')
  throw new Error('Only a local assessment endpoint is supported.');
const server = new McpServer({ name: 'lingoweave-mini-assessment', version: '1.0.0' });
async function call(action: string, input: unknown = {}) {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.LINGOWEAVE_MINI_ASSESSMENT_TOKEN}`,
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
          text: '保存状态未知；沿用原请求与原结果重试，不能改写原答或声称已经保存。',
        },
      ],
      isError: true,
    };
  }
}
if (env.LINGOWEAVE_MINI_ASSESSMENT_MODE === 'expression') {
  server.registerTool(
    'learning_get_translations',
    {
      description: 'Read only the assigned original questions, answers and existing commentary.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => call('context'),
  );
  server.registerTool(
    'learning_submit_expression_grades',
    {
      description:
        'Save one learner-facing expression grade for every assigned original translation in a single batch. Only identical retries are accepted.',
      inputSchema: miniExpressionBatchSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (input) => call('commit', input),
  );
} else {
  server.registerTool(
    'learning_get_assessment',
    {
      description:
        'Read only the assigned frozen original answer, question, learning evidence and time-scoped discussion. Read this before submission; retain sourceId and inputHash.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => call('context'),
  );
  server.registerTool(
    'learning_submit_assessment',
    {
      description:
        'Save meaning, target spelling and use observations with evidence identifiers and concise Chinese reasons. Missing target evidence is not_tested, uncertain judgments stay uncertain. Nonempty uncertainties require an uncertain dimension; recent support or lack of proof of lasting mastery belongs in explanation, not uncertainties. Never submit learner answers, scores, mastery or due dates. Retry an uncertain save with identical request and content. A rejected invalid result was not saved and may be corrected.',
      inputSchema: miniAssessmentCommitSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (input) => call('commit', input),
  );
}
await server.connect(new StdioServerTransport());
