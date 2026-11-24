# LingoWeave · 语织

把词汇、句式与阅读，逐步织成自己的语言能力。

LingoWeave 是给用户自己使用的英语读写学习工具，以 macOS mini 小窗支持碎片时间开始、隐藏和恢复。学习效果与使用体验优先；算法决定今天学什么、复习什么，AI 根据真实记录准备例句、写作练习与反馈。Node.js 保存事实和任务，网页保留备课工作区与交互原型。

mini 已接通学习事实、三层计划、AI 教学、有限偏好、本地语音及后台内容准备。此前版本完成真实文字模型、MLX、HTTP 与原生验证。本轮已补原生单卡默写、显式独立拼写检验及 FSRS、全局快捷键、携带 Node 的应用包，以及牛津 3000 词库与学习计划接口，工程、Node 22、隔离窗口流程与个人牛津词库导入、乱序首组、真实备课及音频已验证，快捷键按键动作仍待人工确认。文字模型保持 `gpt-6.1-sol` / `xhigh`，英语语音复用现有 Qwen3-TTS 1.7B CustomVoice MLX 8-bit。应用内导出、恢复与清理按本轮约定暂缓，声音克隆及跨设备同步仍在后续范围。课程按 A1→B2 进阶，同等级稳定乱序，最终乱序首组与真实备课回执已核对。当前能力与分步证据见 [mini 使用与验收](docs/macos-mini.md)。

## 快速启动

项目声明 Node.js **22.22.0**、pnpm **11.25.0**；既有工程验证使用 Node 24.22.x，本轮应用包内携带 Node 22.22.0，应用包已通过搬移及拒绝读取仓库的 HTTP 验证。生成材料需要本机可执行的 Codex 运行时及登录状态。以下为 PATH 中已有 `codex` 时的网页启动方式：

```sh
nvm install
nvm use
corepack enable
corepack prepare pnpm@11.25.0 --activate
pnpm install
codex login status
pnpm dev
```

未登录时先执行 `codex login`，按 Codex 提示完成登录。若只有 Codex App，可通过 `CODEX_BIN` 指定其内置可执行文件；mini 构建会在默认安装路径自动查找，可用时无需再安装一份 CLI。LingoWeave 使用现有登录状态，不要求把密钥填进网页。

打开 <http://127.0.0.1:5186>，进入学习工作区并点击准备。平台提供 apple、book、water、read、write 五个义项；Agent 查询词条，通过学习工具保存中英例句。材料标为 AI 自拟，词条保留来源入口。已准备材料可以在刷新或服务重启后继续查看；再次打开页面不会自动发起模型调用。

以上为网页启动方式，其数据默认保存到仓库下 `data/`，该目录不进入 Git。macOS mini 开发版运行 `pnpm dev:mini`，自动启动独立的本地服务；学习、文字任务、音频和词库分存四个数据库，WAV 位于同目录的 `audio/`，通过固定业务回执恢复对账。开发版默认进入正常流程首页，启动时不置顶，可用图钉开启。阶段预览的学习、聊天和文字 AI 示例仅在内存，语音试听复用开发服务的真实生成、缓存和播放器，音频会持久保存并与开发正常流程共享当前版本。应用包现携带 Node 22.22.0、服务、生产依赖与 Skill，按包内相对路径启动，Codex 登录和 TTS 继续复用本机已安装环境。默认可用 Control+Option+Space 唤出或隐藏小窗，搬移后的包内 Node 服务已通过鉴权 HTTP 验证，快捷键按键动作仍待人工确认。构建要求、数据位置与停止方式见 [mini 说明](docs/macos-mini.md)。自定义数据目录、端口或 Codex 路径时，参考 `.env.example` 与[开发指南](docs/development.md)。

## 工程结构

```text
apps/
  web/                React + TypeScript + Vite 学习界面
  server/             Fastify、SQLite、备课业务、Codex 与学习 MCP
  macos/              SwiftUI mini 与本地学习服务客户端
packages/
  contracts/          前后端共享 Zod 契约和类型
skills/
  lesson-author/      网页 D0 备课角色说明
  mini-*/             mini 课程、反馈与顾问任务说明
docs/                 产品、架构、开发与验收计划
```

前后端分别建项目，放在同一个 pnpm workspace 中，可以在一次提交中同步修改接口与页面。共享契约既提供 TypeScript 提示，也校验运行时数据。SQLite 使用 Node.js 自带的 `node:sqlite`；当前 Node 22 会显示实验性 API 提示。

| 命令             | 用途                                                   |
| ---------------- | ------------------------------------------------------ |
| `pnpm dev`       | 同时启动前端、后端与共享契约监听                       |
| `pnpm dev:mini`  | 构建并打开 mini 开发版，自动确保其本地服务就绪         |
| `pnpm check`     | 格式、lint、类型、测试与构建检查                       |
| `pnpm test`      | 运行前后端行为测试；默认不调用真实模型                 |
| `pnpm test:mini` | macOS 原生、客户端恢复与学习/AI/音频 HTTP 及持久化验证 |
| `pnpm format`    | 格式化代码和文档                                       |
| `pnpm build`     | 生成网页、服务与共享契约产物                           |
| `pnpm start`     | 从构建产物启动后端，并提供前端页面                     |

生产模式本地验证：

```sh
pnpm build
pnpm start
```

打开 <http://127.0.0.1:4310>。开发与生产运行共用默认数据目录，同一目录只允许一个服务进程；切换前先用 Ctrl+C 停止原服务。

## 开发入口

接手已有功能可按[维护交接](docs/agent/handoff.md)查找专题文档、代码入口与验证方式。

- [文档导航](docs/README.md)：当前规范、完整研究资料与历史方案的统一入口。
- [产品规则](docs/product.md)：学习流程、算法与 AI 的职责。
- [架构说明](docs/architecture.md)：已实现的备课链路与后续模块。
- [开发指南](docs/development.md)：Node.js / TypeScript 后端运行方式、配置与恢复。
- [首个 Demo 计划](docs/demo-plan.md)：实现阶段、业务边界与验收场景。
- [mini 使用与验收](docs/macos-mini.md)、[mini 学习、AI 与语音方案](docs/mini-ai-learning-plan.md)：本机小窗、数据统一与后续方针。
- [词条来源](docs/lexicon-sources.md)与[测量规则](docs/measurement-rules.md)：数据许可和证据分类。
- [通用开发约定](AGENTS.md)：修改前还需阅读对应应用目录的 `AGENTS.md`。

学习事实由平台保存；Agent 自然语言不作为成绩或保存回执。个人数据、导入材料、凭据和构建产物不进入 Git。
