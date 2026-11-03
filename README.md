# LingoWeave · 语织

把词汇、句式与阅读，逐步织成自己的语言能力。

LingoWeave 是面向基础薄弱学习者的个人英语读写学习应用。算法决定今天学什么、复习什么；AI 根据真实学习记录组织例句、翻译练习与反馈。日常操作在网页完成，本地 Node.js 服务管理 Codex 运行时和学习数据。

**当前阶段：D0 备课链路。** 已实现 30 个来源可追溯的种子词义、SQLite 保存、Codex 状态与模型选择、备课任务、材料卡片和刷新恢复。当前准备一个固定的五词组；看词自评、总拼写、FSRS 复习与陪伴聊天仍按 [Demo 计划](docs/demo-plan.md)推进。实际验证结果见 [D0 验收记录](docs/d0-acceptance.md)。

## 快速启动

需要 Node.js **22.22.0**、pnpm **11.25.0**。生成例句还需要本机已安装并登录 Codex CLI。使用 nvm 时：

```sh
nvm install
nvm use
corepack enable
corepack prepare pnpm@11.25.0 --activate
pnpm install
codex login status
pnpm dev
```

未登录时先执行 `codex login`，按 Codex 提示完成登录。LingoWeave 使用现有登录状态，不要求把密钥填进网页。

打开 <http://127.0.0.1:5173>，进入学习工作区并点击准备。平台提供 apple、book、water、read、write 五个义项；Agent 查询词条，通过学习工具保存中英例句。材料标为 AI 自拟，词条保留来源入口。已准备材料可以在刷新或服务重启后继续查看；再次打开页面不会自动发起模型调用。

默认配置即可启动。自定义数据目录、端口或 Codex 路径时，参考 `.env.example` 与[开发指南](docs/development.md)。数据默认保存到仓库下 `data/`，该目录不进入 Git。

## 工程结构

```text
apps/
  web/                React + TypeScript + Vite 学习界面
  server/             Fastify、SQLite、备课业务、Codex 与学习 MCP
packages/
  contracts/          前后端共享 Zod 契约和类型
skills/
  lesson-author/      备课角色说明
docs/                 产品、架构、开发与验收计划
```

前后端分别建项目，放在同一个 pnpm workspace 中，可以在一次提交中同步修改接口与页面。共享契约既提供 TypeScript 提示，也校验运行时数据。SQLite 使用 Node.js 自带的 `node:sqlite`；当前 Node 22 会显示实验性 API 提示。

| 命令          | 用途                                   |
| ------------- | -------------------------------------- |
| `pnpm dev`    | 同时启动前端、后端与共享契约监听       |
| `pnpm check`  | 格式、lint、类型、测试与构建检查       |
| `pnpm test`   | 运行前后端行为测试；默认不调用真实模型 |
| `pnpm format` | 格式化代码和文档                       |
| `pnpm build`  | 生成全部生产产物                       |
| `pnpm start`  | 从构建产物启动后端，并提供前端页面     |

生产模式本地验证：

```sh
pnpm build
pnpm start
```

打开 <http://127.0.0.1:4310>。开发与生产运行共用默认数据目录，同一目录只允许一个服务进程；切换前先用 Ctrl+C 停止原服务。

## 开发入口

- [产品规则](docs/product.md)：学习流程、算法与 AI 的职责。
- [架构说明](docs/architecture.md)：已实现的备课链路与后续模块。
- [开发指南](docs/development.md)：Node.js / TypeScript 后端运行方式、配置与恢复。
- [首个 Demo 计划](docs/demo-plan.md)：实现阶段、业务边界与验收场景。
- [词条来源](docs/lexicon-sources.md)与[测量规则](docs/measurement-rules.md)：数据许可和证据分类。
- [通用开发约定](AGENTS.md)：修改前还需阅读对应应用目录的 `AGENTS.md`。

学习事实由平台保存；Agent 自然语言不作为成绩或保存回执。个人数据、导入材料、凭据和构建产物不进入 Git。
