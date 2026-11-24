# 开发交接

日常学习入口是 macOS mini。先按要改的行为找到专题，再沿表中的代码入口核对实际调用。网页 D0 和 mini 使用各自的学习流程。

| 要改的行为                   | 先读                                                                                  | 从哪里追                                                                                                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 词卡、键盘、朗读和窗口切换   | [mini 使用与验收](../macos-mini.md)                                                   | [应用和窗口](../../apps/macos/Sources/LingoWeaveMini/LingoWeaveMiniApp.swift) → [词卡编排](../../apps/macos/Sources/LingoWeaveMini/MiniStudyView.swift)                                 |
| 新词、复习、拼写和翻译的推进 | [学习流程规则](../learning-flow-rules.md)                                             | [共享学习契约](../../packages/contracts/src/mini.ts) → [学习命令与持久化](../../apps/server/src/mini-store.ts) → [分组与窗口](../../apps/server/src/mini-flow.ts)                       |
| 复习排期、单词曲线和复习负荷 | [测量资格](../measurement-rules.md) · [记忆曲线](../mini/memory.md)                   | [分维度排期](../../apps/server/src/mini-flow-scheduler.ts) · [只读曲线投影](../../apps/server/src/mini-memory.ts)                                                                       |
| 数据总览与本机数据位置       | [数据总览](../mini/data-overview.md)                                                  | [服务端统计](../../apps/server/src/mini-data-overview.ts) · [原生窗口](../../apps/macos/Sources/LingoWeaveMini/mini-data-overview-view.swift)                                           |
| 聊天、备课、翻译评价和音频   | [mini AI 与语音方案](../mini-ai-learning-plan.md) · [数据归属](../architecture.md)    | [教学任务](../../apps/server/src/mini-ai-service.ts) · [后台评价](../../apps/server/src/mini-assessment-service.ts) · [语音资产与播放授权](../../apps/server/src/mini-audio-service.ts) |
| 词书、等级与词条来源         | [词条来源](../lexicon-sources.md) · [词书与学习顺序](../macos-mini.md#词书与学习顺序) | [词库契约](../../packages/contracts/src/mini-vocabulary.ts) · [词库存储](../../apps/server/src/mini-vocabulary-store.ts)                                                                |
| 网页备课与学习原型           | [D0 验收](../d0-acceptance.md) · [工作区原型](../study-workspace-prototype.md)        | [网页入口](../../apps/web/src/App.tsx) · [服务路由](../../apps/server/src/app.ts)                                                                                                       |

## 接着做

要判断一项功能做到了哪一步，查[实施计划](../demo-plan.md)和对应专题的验收记录。要启动本机环境、区分开发与正式版数据或重建应用包，查[开发指南](../development.md)。改动完成后，按[评审与验证](review-standard.md)选择能覆盖实际入口的检查。
