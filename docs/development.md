# 开发指南

## 环境与启动

工程固定 Node.js `22.22.0`、pnpm `11.25.0`，依赖以根目录 `pnpm-lock.yaml` 为准。使用 nvm 时，在仓库根目录执行：

```sh
nvm install
nvm use
corepack enable
pnpm install
pnpm dev
```

浏览器打开 `http://127.0.0.1:5173`。后端默认地址是 `http://127.0.0.1:4310`，可直接访问 `/api/health` 检查服务。页面中的连接状态来自真实接口，不需要配置模型或登录 Codex。

根目录的 `dev` 命令先构建共享契约，再启动契约监听、前端和后端开发进程。修改 React 页面由 Vite 更新；修改后端 TypeScript 由 `tsx watch` 重启服务。按 Ctrl+C 结束这一组开发进程。

可选地将根目录 `.env.example` 复制为 `.env`。服务端从仓库根目录加载该文件，已设置的进程环境变量优先；`.env` 不提交 Git。当前配置为：

| 名称       | 默认值        | 用途                     |
| ---------- | ------------- | ------------------------ |
| `NODE_ENV` | `development` | 开发、测试或生产运行方式 |
| `HOST`     | `127.0.0.1`   | 服务监听地址             |
| `PORT`     | `4310`        | API 及生产网页端口       |

开发代理目标在 `apps/web/vite.config.ts`，修改后端端口时需要一并调整。前端组件继续使用相对路径 `/api`，不要在组件中写主机或端口。

## 常用命令

以下均从仓库根目录执行。

| 命令                | 行为                                   |
| ------------------- | -------------------------------------- |
| `pnpm dev`          | 启动前后端及共享契约监听               |
| `pnpm typecheck`    | 检查各包 TypeScript 类型               |
| `pnpm lint`         | 检查代码规范                           |
| `pnpm format`       | 格式化工程文件                         |
| `pnpm format:check` | 只检查格式                             |
| `pnpm test`         | 运行后端行为测试                       |
| `pnpm build`        | 按依赖顺序生成契约、网页和服务构建产物 |
| `pnpm check`        | 运行格式、lint、类型、测试和构建检查   |
| `pnpm start`        | 以生产模式运行已构建的服务及网页       |

生产运行：

```sh
pnpm build
pnpm start
```

此时直接打开 `http://127.0.0.1:4310`。无需另开 Vite。修改源码后需要重新构建，`start` 不监听源码变化。

## 为什么同仓库、分两个应用

前端代码由浏览器执行，负责显示与交互；后端代码由 Node.js 执行，负责服务和未来的数据保存、调度与 Agent 管理。它们各有 `package.json`、TypeScript 配置和构建产物，共享根目录的依赖锁文件与开发工具。

workspace 让两端通过 `@lingoweave/contracts` 引用同一套接口结构。TypeScript 类型负责开发时检查，Zod schema 负责运行时验证网络数据。只写一个 TypeScript 接口不能证明服务器实际返回了正确数据。

一次请求的路径是：

```text
React 组件 → /api/health → Vite 开发代理 → Fastify 路由
React 组件 ← 共享 schema 校验 ← JSON 响应 ← 服务
```

生产模式跳过 Vite 代理，网页和 API 都由 Fastify 提供。共享包先编译，两个应用通过它的公开入口消费 JavaScript 和类型，开发与构建使用同样的包边界。

## Node.js 与 TypeScript 后端怎样运行

TypeScript 是源码，Node.js 生产入口是编译后的 JavaScript。开发使用 `tsx` 直接运行 TypeScript 以方便重载；发布前用 `tsc` 生成 `dist`，生产命令运行 `node dist/index.js`。

采用 ESM，服务端相对导入写 `.js` 扩展名，例如 `import { buildApp } from './app.js'`。TypeScript 在开发时找到相应 `.ts` 源文件，构建后 Node.js 可以直接解析生成的 `.js`。不要为了开发可运行而留下生产无法解析的导入路径。

服务端入口按三层组织：

- `src/config.ts`：校验环境配置，给出明确的启动错误。
- `src/app.ts`：组装 Fastify 实例和路由，导入文件本身不监听端口。
- `src/index.ts`：加载配置、启动监听、处理退出信号。

测试通过 `buildApp()` 和 Fastify `inject()` 发送请求，不依赖固定端口。后续业务规则放入独立服务或领域模块，路由只处理输入、调用和输出。网页 HTTP 与 Agent MCP 工具应调用同一业务服务。

## 如何增加功能

1. 明确用户行为、服务端事实和失败恢复要求；参考 [产品约定](product.md)与 [Demo 计划](demo-plan.md)。
2. 在 `packages/contracts` 定义接口输入、输出和运行时 schema。
3. 在服务端实现校验、业务服务和路由；关键状态转换与保存边界添加行为测试。
4. 前端通过 `/api` 调用，校验响应，处理等待、失败、取消和重试。
5. 运行 `pnpm check`，并验证实际启动和相应交互；文档区分已完成与计划能力。

新增依赖使用 `pnpm --filter @lingoweave/web add 包名` 或 `pnpm --filter @lingoweave/server add 包名`；根目录开发工具使用 `pnpm add -Dw 包名`。不要混用 npm/yarn 生成另一份锁文件，也不要提交 `node_modules` 或 `dist`。

根目录 `AGENTS.md` 是通用规则；修改网页或服务前，还需阅读对应应用的 `AGENTS.md`。分支使用 `feat/`、`fix/`、`docs/` 或 `chore/` 前缀。当前基础工程没有数据库迁移或 Codex 配置步骤，后续引入时与实现一起补齐说明。
