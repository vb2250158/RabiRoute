# Archive

这里保存已经退出运行链路、但仍有迁移审计价值的旧实现。`archive/` 不参与 TypeScript 构建，也不能作为新代码的依赖来源。

## 当前实现（不要从归档反推）

当前正式链路是：`RabiRoute -> Codex Desktop IPC -> Desktop task owner`。实际消息不经过独立 app-server 或共享 4510；Desktop 缺席时失败，没有 fallback。实现见 `../src/codexDesktopBridge.ts` 与 `../src/codexRuntime.ts`。

## 2026-07-10：旧 Desktop IPC 尝试

- 归档文件：`src/codexDesktopIpc.ts` 与对应测试。
- 归档原因：它没有用 deeplink 可靠加载目标 owner，并混入 app-server fallback，无法保证一条消息只有一个执行者。
- 可复用教训：IPC follower start/steer 能让 Desktop 实时显示消息，但必须配合精确 ID、cwd 校验、owner 唤醒和 fail closed。

## 2026-07-15：独立 stdio 多 Runtime

- 归档目录：`legacy-codex-multi-runtime-2026-07-15/`。
- 归档原因：后台 app-server 与 Desktop 共享持久化任务，但不共享实时事件、active turn 状态和 Desktop 工具，不满足“消息立即出现在 Desktop”的产品要求。

## 2026-07-15：共享 4510 Runtime

- 归档目录：`legacy-codex-shared-runtime-2026-07-15/`。
- 归档说明：`codex-shared-runtime-migration-2026-07-15.md`。
- 归档原因：用户级 `CODEX_APP_SERVER_WS_URL` 把 Desktop 冷启动绑定到 RabiRoute Manager；Manager 缺席时 Desktop 直接 `ECONNREFUSED 127.0.0.1:4510`。

归档代码仅用于理解旧数据、日志和事故历史；不要 import、构建或修补后重新接回主链。
