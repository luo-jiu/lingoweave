import { mkdir } from 'node:fs/promises';
import type { RuntimeStatus } from '@lingoweave/contracts';
import { z } from 'zod';
import { CodexError, CodexTransport, cancelledError } from './transport.js';

const accountSchema = z.object({
  account: z.object({ type: z.string() }).passthrough().nullable(),
  requiresOpenaiAuth: z.boolean(),
});
const modelPageSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      model: z.string(),
      displayName: z.string(),
      isDefault: z.boolean(),
      hidden: z.boolean().optional(),
    }),
  ),
  nextCursor: z.string().nullable(),
});
const configSchema = z.object({ config: z.record(z.string(), z.unknown()) });
const dictionarySchema = z.record(z.string(), z.unknown());
const threadSchema = z.object({
  thread: z.object({ id: z.string() }),
  model: z.string(),
  approvalPolicy: z.literal('never'),
  sandbox: z.object({ type: z.literal('readOnly') }),
});
const inventorySchema = z.object({
  data: z.array(
    z.object({
      name: z.string(),
      runtimeStatus: z.string().nullable(),
      tools: z.record(z.string(), z.unknown()),
    }),
  ),
  nextCursor: z.string().nullable(),
});
const deltaSchema = z.object({
  threadId: z.string(),
  turnId: z.string(),
  itemId: z.string(),
  delta: z.string(),
});
const completedSchema = z.object({
  threadId: z.string(),
  turn: z.object({
    id: z.string(),
    status: z.enum(['completed', 'interrupted', 'failed', 'inProgress']),
  }),
});
const itemSchema = z.object({
  threadId: z.string(),
  turnId: z.string(),
  item: z.object({
    type: z.string(),
    id: z.string(),
    text: z.string().optional(),
    server: z.string().optional(),
    tool: z.string().optional(),
  }),
});

const processConfig = [
  'features.apps=false',
  'features.shell_tool=false',
  'features.unified_exec=false',
  'features.hooks=false',
  'features.memories=false',
  'features.remote_plugin=false',
  'features.multi_agent=false',
  'features.view_image=false',
  'features.tool_suggest=false',
  'skills.include_instructions=false',
  'skills.bundled.enabled=false',
  'web_search="disabled"',
];

export interface CodexBridgeOptions {
  executable?: string;
  cwd: string;
  requestTimeoutMs?: number;
  turnTimeoutMs?: number;
}

export interface PrepareOptions {
  jobId: string;
  model?: string;
  instructions: string;
  skill?: { name: string; path: string };
  mcp: { command: string; args: string[]; env: Record<string, string> };
  onThread?: (thread: { threadId: string; model: string }) => void;
  onText: (text: string) => void;
  onProgress: (message: string) => void;
  signal: AbortSignal;
}

/** Version-scoped app-server adapter. Learning results are committed through MCP. */
export class CodexBridge {
  private readonly processes = new Set<CodexTransport>();
  private statusCache: { value: RuntimeStatus; expiresAt: number } | null = null;
  private pendingStatus: Promise<RuntimeStatus> | null = null;
  private closed = false;

  constructor(private readonly options: CodexBridgeOptions) {}

  status(): Promise<RuntimeStatus> {
    if (this.statusCache && this.statusCache.expiresAt > Date.now())
      return Promise.resolve(this.statusCache.value);
    if (this.pendingStatus) return this.pendingStatus;
    this.pendingStatus = this.inspect()
      .then((value) => {
        this.statusCache = { value, expiresAt: Date.now() + 10_000 };
        return value;
      })
      .finally(() => {
        this.pendingStatus = null;
      });
    return this.pendingStatus;
  }

  async prepare(options: PrepareOptions): Promise<{ threadId: string; model: string }> {
    if (options.signal.aborted) throw cancelledError();
    const process = await this.createProcess();
    const cancel = () => {
      void process.abort();
    };
    options.signal.addEventListener('abort', cancel, { once: true });
    try {
      if (options.signal.aborted) throw cancelledError();
      options.onProgress('正在连接本机 Codex…');
      await this.initialize(process);
      const account = accountSchema.parse(
        await process.request('account/read', { refreshToken: false }),
      );
      if (!account.account && account.requiresOpenaiAuth)
        throw new CodexError('CODEX_LOGIN_REQUIRED', '请先在本机 Codex 完成登录，再准备学习材料。');
      const models = await this.models(process);
      const selected = options.model
        ? models.find((model) => model.id === options.model || model.model === options.model)
        : (models.find((model) => model.isDefault) ?? models[0]);
      if (!selected)
        throw new CodexError(
          'CODEX_MODEL_UNAVAILABLE',
          '所选模型当前不可用，请刷新模型列表后重试。',
        );
      const effective = configSchema.parse(
        await process.request('config/read', { includeLayers: false }),
      );
      const config = isolatedThreadConfig(effective.config, options.mcp);
      const started = threadSchema.parse(
        await process.request('thread/start', {
          model: selected.model,
          cwd: this.options.cwd,
          approvalPolicy: 'never',
          sandbox: 'read-only',
          ephemeral: true,
          serviceName: 'lingoweave',
          config,
          baseInstructions:
            'You prepare English learning materials for LingoWeave. Use only the scoped lingoweave learning tools. The platform owns all learning state; natural-language claims never save results. Do not use shell, files, web, other apps, or other MCP servers. Give only short public progress updates and a concise final summary; do not reveal private reasoning.',
          developerInstructions: options.instructions,
        }),
      );
      await this.verifyTools(process, started.thread.id);
      if (options.signal.aborted) throw cancelledError();
      const result = { threadId: started.thread.id, model: started.model };
      options.onThread?.(result);
      if (options.signal.aborted) throw cancelledError();
      options.onProgress('已连接，正在读取词组并准备例句…');
      await this.runTurn(process, started.thread.id, started.model, options);
      return result;
    } catch (error) {
      if (options.signal.aborted) throw cancelledError();
      if (error instanceof CodexError) throw error;
      throw new CodexError('CODEX_PROTOCOL', 'Codex 接口与当前版本不兼容，请检查运行配置后重试。');
    } finally {
      options.signal.removeEventListener('abort', cancel);
      this.processes.delete(process);
      await process.close();
    }
  }

  async close() {
    this.closed = true;
    await Promise.all([...this.processes].map((process) => process.close()));
    this.processes.clear();
  }

  private async createProcess() {
    if (this.closed) throw new CodexError('CODEX_CLOSED', '学习服务正在关闭，请重新打开后再试。');
    await mkdir(this.options.cwd, { recursive: true });
    if (this.closed) throw new CodexError('CODEX_CLOSED', '学习服务正在关闭，请重新打开后再试。');
    const process = new CodexTransport({
      executable: this.options.executable ?? 'codex',
      args: [
        'app-server',
        '--listen',
        'stdio://',
        ...processConfig.flatMap((value) => ['-c', value]),
      ],
      cwd: this.options.cwd,
      requestTimeoutMs: this.options.requestTimeoutMs,
    });
    this.processes.add(process);
    return process;
  }

  private async initialize(process: CodexTransport) {
    const value = z.object({ userAgent: z.string() }).parse(
      await process.request('initialize', {
        clientInfo: { name: 'lingoweave', title: 'LingoWeave', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      }),
    );
    process.notify('initialized', {});
    return value.userAgent.match(/\/(\d+\.\d+\.\d+)/)?.[1] ?? null;
  }

  private async models(process: CodexTransport) {
    const models: z.infer<typeof modelPageSchema>['data'] = [];
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      const page = modelPageSchema.parse(
        await process.request('model/list', { limit: 100, includeHidden: false, cursor }),
      );
      models.push(...page.data.filter((model) => !model.hidden));
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor))
        throw new CodexError('CODEX_PROTOCOL', 'Codex 模型列表未能完整加载。');
      if (cursor) seen.add(cursor);
      if (models.length > 1_000)
        throw new CodexError('CODEX_PROTOCOL', 'Codex 模型列表超出预期大小。');
    } while (cursor);
    return models;
  }

  private async inspect(): Promise<RuntimeStatus> {
    let process: CodexTransport | null = null;
    let version: string | null = null;
    try {
      process = await this.createProcess();
      version = await this.initialize(process);
      const account = accountSchema.parse(
        await process.request('account/read', { refreshToken: false }),
      );
      const authenticated = account.account !== null || !account.requiresOpenaiAuth;
      const models = authenticated ? await this.models(process) : [];
      return {
        available: true,
        authenticated,
        version,
        models: models.map((model) => ({
          id: model.model,
          name: model.displayName,
          isDefault: model.isDefault,
        })),
        error: authenticated ? null : '请先在本机 Codex 完成登录。',
      };
    } catch (error) {
      return {
        available: false,
        authenticated: false,
        version,
        models: [],
        error:
          error instanceof CodexError ? error.message : '无法读取 Codex 状态，请检查安装与登录。',
      };
    } finally {
      if (process) {
        this.processes.delete(process);
        await process.close();
      }
    }
  }

  private async verifyTools(process: CodexTransport, threadId: string) {
    const inventory = inventorySchema.parse(
      await process.request('mcpServerStatus/list', { threadId, limit: 100 }),
    );
    if (inventory.nextCursor)
      throw new CodexError('CODEX_TOOL_SCOPE', '无法确认备课工具范围，请检查 Codex 配置。');
    const own = inventory.data.find((server) => server.name === 'lingoweave');
    const foreignActive = inventory.data.some(
      (server) =>
        server.name !== 'lingoweave' &&
        (server.runtimeStatus !== 'disabled' || Object.keys(server.tools).length > 0),
    );
    const tools = own ? Object.keys(own.tools) : [];
    if (
      foreignActive ||
      own?.runtimeStatus !== 'connected' ||
      !tools.includes('learning_get_context') ||
      !tools.includes('learning_publish_materials') ||
      tools.some((tool) => !['learning_get_context', 'learning_publish_materials'].includes(tool))
    ) {
      throw new CodexError(
        'CODEX_TOOL_SCOPE',
        '学习工具未正确连接，备课尚未开始。请检查本地服务后重试。',
      );
    }
  }

  private runTurn(
    process: CodexTransport,
    threadId: string,
    model: string,
    options: PrepareOptions,
  ) {
    return new Promise<void>((resolve, reject) => {
      let finished = false;
      let turnId: string | null = null;
      let lastItem: string | null = null;
      let outputBytes = 0;
      const emitted = new Map<string, string>();
      let removeNotifications = () => {};
      let removeFailure = () => {};
      const cleanup = () => {
        clearTimeout(timeout);
        removeNotifications();
        removeFailure();
      };
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const output = (itemId: string, delta: string) => {
        if (finished || options.signal.aborted || !delta) return;
        outputBytes += Buffer.byteLength(delta);
        if (outputBytes > 65_536) {
          finish(new CodexError('CODEX_OUTPUT_LIMIT', '备课回复超出预期长度，已停止，可以重试。'));
          return;
        }
        if (lastItem && lastItem !== itemId) options.onText('\n\n');
        lastItem = itemId;
        emitted.set(itemId, (emitted.get(itemId) ?? '') + delta);
        options.onText(delta);
      };
      const timeout = setTimeout(() => {
        if (turnId)
          void process.request('turn/interrupt', { threadId, turnId }, 1_000).catch(() => {});
        finish(
          new CodexError(
            'CODEX_TURN_TIMEOUT',
            '本次备课等待过久，已停止。已保存的材料会保留，可以重试。',
          ),
        );
      }, this.options.turnTimeoutMs ?? 180_000);
      removeNotifications = process.onNotification((method, params) => {
        if (finished || options.signal.aborted) return;
        if (method === 'item/agentMessage/delta') {
          const event = deltaSchema.parse(params);
          if (event.threadId !== threadId || (turnId && event.turnId !== turnId)) return;
          output(event.itemId, event.delta);
        } else if (method === 'item/started' || method === 'item/completed') {
          const event = itemSchema.parse(params);
          if (event.threadId !== threadId || (turnId && event.turnId !== turnId)) return;
          if (
            event.item.type === 'mcpToolCall' &&
            event.item.server === 'lingoweave' &&
            method === 'item/started'
          ) {
            options.onProgress(
              event.item.tool === 'learning_publish_materials'
                ? '正在校验并保存学习材料…'
                : '正在读取当前词组…',
            );
          }
          if (
            event.item.type === 'agentMessage' &&
            method === 'item/completed' &&
            event.item.text
          ) {
            const sent = emitted.get(event.item.id) ?? '';
            if (event.item.text.startsWith(sent))
              output(event.item.id, event.item.text.slice(sent.length));
          }
        } else if (method === 'turn/completed') {
          const event = completedSchema.parse(params);
          if (event.threadId !== threadId || (turnId && event.turn.id !== turnId)) return;
          finish(
            event.turn.status === 'completed'
              ? undefined
              : new CodexError(
                  'CODEX_TURN_FAILED',
                  'Codex 本次备课未完成。已保存的内容会保留，可以重试。',
                ),
          );
        }
      });
      removeFailure = process.onFailure(finish);
      const input: Array<
        | { type: 'text'; text: string; text_elements: [] }
        | { type: 'skill'; name: string; path: string }
      > = [
        {
          type: 'text',
          text: `Prepare the assigned learning group for job ${options.jobId}. Read learning_get_context, then submit all five bilingual example sentences using learning_publish_materials. Do not claim success before the tool confirms its receipt.`,
          text_elements: [],
        },
      ];
      if (options.skill) input.push({ type: 'skill', ...options.skill });
      void process
        .request('turn/start', { threadId, model, input })
        .then((value) => {
          const started = z.object({ turn: z.object({ id: z.string() }) }).parse(value);
          turnId = started.turn.id;
        })
        .catch((error: unknown) =>
          finish(
            error instanceof CodexError
              ? error
              : new CodexError('CODEX_PROTOCOL', 'Codex 未能开始备课。'),
          ),
        );
    });
  }
}

/** Empty tables merge with user config; explicitly disable every inherited entry. */
export function isolatedThreadConfig(
  effective: Record<string, unknown>,
  mcp: PrepareOptions['mcp'],
) {
  const inheritedServers = dictionarySchema.safeParse(effective.mcp_servers);
  const inheritedPlugins = dictionarySchema.safeParse(effective.plugins);
  const servers: Record<string, unknown> = Object.fromEntries(
    Object.keys(inheritedServers.success ? inheritedServers.data : {}).map((name) => [
      name,
      { enabled: false },
    ]),
  );
  const plugins: Record<string, unknown> = Object.fromEntries(
    Object.keys(inheritedPlugins.success ? inheritedPlugins.data : {}).map((name) => [
      name,
      { enabled: false },
    ]),
  );
  plugins._default = { enabled: false };
  servers.lingoweave = {
    ...mcp,
    enabled: true,
    required: true,
    startup_timeout_sec: 15,
    tool_timeout_sec: 20,
    enabled_tools: ['learning_get_context', 'learning_publish_materials'],
    default_tools_approval_mode: 'auto',
  };
  return { mcp_servers: servers, plugins };
}
