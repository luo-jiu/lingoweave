# LingoWeave · 语织

把词汇、句式与阅读，逐步织成自己的语言能力。

LingoWeave 是面向基础薄弱学习者的个人英语读写学习应用。算法决定今天学什么、复习什么；AI 根据真实学习记录组织例句、翻译练习与反馈。日常操作都在网页完成，后续由本地 Node.js 服务管理 Codex 运行时。

**当前阶段：基础工程已建立，完整学习 Demo 尚在开发计划中。** 现在可以运行前端、后端和真实健康检查。词库、SQLite、复习调度、背词流程与 Agent 接入还未实现。

## 快速启动

需要 Node.js **22.22.0** 和 pnpm **11.25.0**。使用 nvm 时：

```sh
nvm install
nvm use
corepack enable
corepack prepare pnpm@11.25.0 --activate
pnpm install
pnpm dev
```

打开 <http://localhost:5173>。开发服务器将 `/api` 转发到 <http://127.0.0.1:4310>，首页会显示实际连接结果。

默认配置即可启动；自定义配置时复制 `.env.example` 为 `.env`。修改后端端口后也要调整前端代理，详见[开发指南](docs/development.md)。

## 工程结构

```text
apps/
  web/                React + TypeScript + Vite
  server/             Node.js + TypeScript + Fastify
packages/
  contracts/          前后端共享 Zod 契约和类型
docs/                 产品、架构、开发与 Demo 计划
```

前后端分别建项目，放在同一个 pnpm workspace 中：可以独立开发，也能在一次提交中同步修改接口与页面。共享契约既提供 TypeScript 提示，也验证实际收到的数据。当前没有引入数据库、消息队列或额外部署服务。

| 命令          | 用途                               |
| ------------- | ---------------------------------- |
| `pnpm dev`    | 同时启动前端、后端与共享契约监听   |
| `pnpm check`  | 格式、lint、类型、测试与构建检查   |
| `pnpm format` | 格式化代码和文档                   |
| `pnpm build`  | 生成全部生产产物                   |
| `pnpm start`  | 从构建产物启动后端，并提供前端页面 |

生产模式本地验证：

```sh
pnpm build
pnpm start
```

打开 <http://127.0.0.1:4310>。服务默认只监听本机回环地址；当前工程面向本地单用户使用。

## 开发入口

- [产品规则](docs/product.md)：学习流程、算法与 AI 的职责。
- [架构说明](docs/architecture.md)：当前结构和后续接入方向。
- [开发指南](docs/development.md)：Node.js / TypeScript 后端的运行方式与常用操作。
- [首个 Demo 计划](docs/demo-plan.md)：实现阶段、业务边界与验收场景。
- [通用开发约定](AGENTS.md)：修改前还需阅读对应应用目录的 `AGENTS.md`。

学习事实由平台保存；AI 的自然语言回复不作为成绩或保存回执。个人学习数据、导入材料、密钥和构建产物不进入 Git。
