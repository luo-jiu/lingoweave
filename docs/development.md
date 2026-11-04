# 开发指南

## 环境与启动

工程固定 Node.js `22.22.0`、pnpm `11.25.0`，依赖以根目录 `pnpm-lock.yaml` 为准。使用 nvm 时在仓库根目录执行：

```sh
nvm install
nvm use
corepack enable
pnpm install
codex --version
codex login status
pnpm dev
```

真实备课需要 PATH 中存在 Codex CLI 并完成登录；未登录时使用 `codex login`。本轮验证版本为 `0.153.4`。网页展示运行时返回的模型，选择会随准备请求发送；登录和账户管理仍由 Codex 负责。查看已保存材料不要求调用模型。

浏览器打开 <http://127.0.0.1:5173>，服务默认位于 <http://127.0.0.1:4310>。根目录 `dev` 先构建共享契约，再启动契约监听、Vite 和 `tsx watch`。按 Ctrl+C 结束开发进程及其当前 Agent 任务。

## 配置

可选地把 `.env.example` 复制为 `.env`。服务端从仓库根目录加载它，已有进程环境变量优先。`.env` 不提交 Git。

| 名称                 | 默认值                  | 用途                                                       |
| -------------------- | ----------------------- | ---------------------------------------------------------- |
| `NODE_ENV`           | `development`           | 开发、测试或生产方式                                       |
| `HOST`               | `127.0.0.1`             | 服务监听地址                                               |
| `PORT`               | `4310`                  | API 及生产网页端口                                         |
| `DATA_DIR`           | `data`                  | 数据目录；相对路径相对于仓库根目录，也可使用绝对路径       |
| `CODEX_BIN`          | `codex`                 | Codex 可执行文件名称或完整路径，不是 shell 命令            |
| `LINGOWEAVE_API_URL` | `http://127.0.0.1:4310` | Vite 开发/预览代理目标，需作为启动 Vite 的进程环境变量传入 |

修改开发端口时同时设置服务端端口与前端代理，例如：

```sh
PORT=4311 LINGOWEAVE_API_URL=http://127.0.0.1:4311 pnpm dev
```

`LINGOWEAVE_API_URL` 当前直接由 Vite 配置读取 `process.env`；仅写入后端加载的根目录 `.env` 不会自动设置 Vite 进程。前端组件继续使用 `/api` 相对路径。不要将密钥或 MCP 任务凭据放入前端环境变量。

## 常用命令

| 命令                                | 行为                                 |
| ----------------------------------- | ------------------------------------ |
| `pnpm dev`                          | 启动前后端及共享契约监听             |
| `pnpm typecheck`                    | 检查各包 TypeScript 类型             |
| `pnpm lint`                         | 检查代码规范                         |
| `pnpm format` / `pnpm format:check` | 格式化 / 只检查格式                  |
| `pnpm test`                         | 运行前后端行为测试，不调用真实模型   |
| `pnpm build`                        | 按依赖顺序生成契约、网页和服务产物   |
| `pnpm check`                        | 运行格式、lint、类型、测试和构建检查 |
| `pnpm start`                        | 以生产模式运行已构建的服务及网页     |

生产运行使用 `pnpm build` 后执行 `pnpm start`，打开 <http://127.0.0.1:4310>。修改源码后需重新构建；`start` 不监听源码。开发和生产默认共享数据目录，切换前先停掉原服务。

## 数据与中断

SQLite 使用 Node.js 自带的 `node:sqlite`，Node 22 当前会输出实验性 API 提示。数据目录中包含 `lingoweave.sqlite`、运行时 WAL/SHM 文件、进程锁与 Agent 工作目录。当前迁移随服务启动执行，数据库版本为 `user_version = 1`；后续表结构变更必须新增迁移版本，不能靠删除数据库更新。

同一数据目录只允许一个服务实例。遇到“already open in another LingoWeave process”时，先停止仍在使用该目录的进程；独立测试可以设置另一个 `DATA_DIR`。不要在服务运行时删除锁或数据库。进程退出后正常释放锁；异常退出留下的锁会在下次打开时检查原进程是否仍存在。

重启后可重新查看已提交材料。未完成的准备任务显示中断，用户主动重试；不会在启动时自动调用模型。重试复用当前五词组并创建新的尝试。D0 不续接临时 Codex 线程，已保存平台记录负责重建上下文。

当前尚无应用内导出/恢复工具。如需手动备份，先停止服务，再复制整个数据目录；不要只复制仍在写入的 SQLite 主文件。个人数据、来源文件、凭据和生成产物不提交 Git。

## Node.js 与 TypeScript 后端

浏览器运行 React，Node.js 运行 HTTP 服务、保存和 Agent 管理。前后端各有 `package.json` 与构建产物，统一使用根目录依赖锁和开发工具。`@lingoweave/contracts` 的 TypeScript 类型检查开发代码，Zod schema 校验实际网络输入输出。

开发使用 `tsx` 运行 TypeScript；构建时 `tsc` 生成 JavaScript，生产入口由 Node.js 执行。项目采用 ESM，服务端相对导入写 `.js` 扩展名；TypeScript 开发时解析对应 `.ts`，构建后 Node.js 直接解析 `.js`。

主要入口：

- `src/index.ts`：加载环境、打开数据目录、组装运行时并启动/关闭服务。
- `src/app.ts`、`src/learning-routes.ts`：HTTP 边界与统一错误结构。
- `src/learning-store.ts`：事务、迁移和持久化事实；测试使用临时数据库。
- `src/preparation-service.ts`：任务与 Codex 生命周期；测试注入可控运行时。
- `src/codex/`：JSONL 适配与子进程测试。
- `src/learning-mcp.ts`：只调用平台内部业务接口，不另写数据库逻辑。

备课 Skill 通过协议显式传入 `skills/lesson-author/SKILL.md`；不需要安装到用户全局技能目录。平台仅提供当前两个学习工具。更改工具、Skill 或 Codex 协议后，除自动测试外，还需完成一次真实备课并记录结果。

## 增加功能

先明确用户行为、服务端事实与恢复要求，再更新共享契约、业务服务与界面。关键状态和保存边界添加行为测试；前端处理加载、失败、取消和重试，遵守[产品规则](product.md)与[测量规则](measurement-rules.md)。完成后运行 `pnpm check` 并验收实际交互。

新增依赖使用 `pnpm --filter @lingoweave/web add 包名` 或 `pnpm --filter @lingoweave/server add 包名`；开发工具使用 `pnpm add -Dw 包名`。不要混用 npm/yarn 生成另一份锁文件。

修改前阅读根目录和对应应用的 `AGENTS.md`。分支使用 `feat/`、`fix/`、`docs/` 或 `chore/` 前缀。完整产品路线与当前差距见 [Demo 计划](demo-plan.md)。
