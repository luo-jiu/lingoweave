import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { publishMaterialsSchema } from '@lingoweave/contracts';
import { z } from 'zod';

const environment = z
  .object({
    LINGOWEAVE_MCP_URL: z.url(),
    LINGOWEAVE_MCP_TOKEN: z.string().min(32),
  })
  .parse(process.env);
const url = new URL(environment.LINGOWEAVE_MCP_URL);
if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
  throw new Error('The learning MCP must connect to the local LingoWeave service.');
}

const server = new McpServer(
  { name: 'lingoweave-learning', version: '0.1.0' },
  {
    instructions:
      'Query the current group before preparing examples. Publish a complete validated set through the platform. The returned receipt is the only evidence that saving succeeded.',
  },
);

async function callPlatform(action: 'context' | 'publish', input?: unknown) {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${environment.LINGOWEAVE_MCP_TOKEN}`,
      },
      body: JSON.stringify({ action, input }),
      signal: AbortSignal.timeout(15_000),
    });
    const payload: unknown = await response.json();
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
      isError: !response.ok,
    };
  } catch {
    return {
      content: [
        {
          type: 'text' as const,
          text: '平台连接中断，提交状态未知。请使用相同请求身份查询或重试，不要宣称已经保存。',
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
      'Read the exact current five-word group, dictionary sources, preparation state and available history.',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async () => callPlatform('context'),
);

server.registerTool(
  'learning_publish_materials',
  {
    description:
      'Atomically save one simple bilingual example for every current target. Requires a previous context read. Repeating the same requestId and content returns the saved receipt.',
    inputSchema: publishMaterialsSchema.shape,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (input) => callPlatform('publish', input),
);

await server.connect(new StdioServerTransport());
