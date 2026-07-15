# Codex 共享 Runtime 迁移归档

## 结论

2026-07-15 起，RabiRoute 本机 Codex 集成只有一条正式链路：Rabi Manager 拥有一个 `ws://127.0.0.1:4510` app-server；Rabi gateway、Codex/ChatGPT Desktop 和 Codex CLI 都作为客户端连接它。

不保留 stdio 子进程模式、Desktop 私有 IPC follower 模式或自动 fallback。

## 旧实现位置

旧文件按原目录镜像保存在 `archive/legacy-codex-multi-runtime-2026-07-15/`：

- `src/codexAppServerClient.ts`：每个 gateway 启动独立 stdio app-server。
- `src/codexRuntime.ts`：按名称猜测线程并尝试唤起桌面窗口。
- `src/chatgptDesktopHost.ts`：桌面宿主可见性辅助逻辑。
- `scripts/check-codex-app-server-contract.mjs`：旧 stdio 契约检查。
- `plugin-adapters/remote-agent-rabiroute/codex-app-server-client.mjs`：远端桥独立启动 app-server。
- 对应测试文件。

## 新唯一入口

- Runtime 地址真源：`src/codexSharedRuntime.ts`
- Runtime 所有者：`src/manager/codexSharedRuntimeOwner.ts`
- Rabi 客户端：`src/codexAppServerClient.ts`
- CLI：`npm run codex:shared -- <args>`
- Desktop 配置：`npm run configure:codex-desktop`
- 契约检查：`npm run check:codex-contract`

UI 显示“会话名 + 最后会话时间”，但配置持久化完整 `codexThreadId`，避免同名会话误投递。
