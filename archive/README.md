# Archive

这里保存已经退出运行链路、但仍有迁移审计价值的旧实现。`archive/` 不参与 TypeScript 构建，也不能作为新代码的依赖来源。

## 2026-07-10：Codex Desktop IPC

- 归档文件：`src/codexDesktopIpc.ts` 与对应测试。
- 归档原因：它依赖私有桌面 IPC、窗口加载状态和 app-server fallback，把桌面宿主与 Codex transport 混成了同一个故障域。
- 当前实现：`../src/codexRuntime.ts` 负责 Agent/session policy，`../src/codexAppServerClient.ts` 通过官方 `codex app-server` stdio JSONL 通信。
- ChatGPT desktop 只保留为显式 opt-in 的可选查看宿主，不参与投递健康判断。

归档代码仅用于理解旧数据和旧日志；不要修补后重新接回主链。
