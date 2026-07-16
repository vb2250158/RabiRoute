# Codex 共享 Runtime 失败方案归档

## 结论

这份文件记录 2026-07-15 曾经实施、随后撤销的方案，不代表当前架构。

当时让 Rabi Manager 拥有 `ws://127.0.0.1:4510` app-server，并把 Rabi gateway、Codex/ChatGPT Desktop 和 Codex CLI 都改成其客户端。该方案通过用户级 `CODEX_APP_SERVER_WS_URL` 反转了所有权：Manager 未启动时 Desktop 无法冷启动，并报 `ECONNREFUSED 127.0.0.1:4510`。

当前正式链路是：

```text
RabiRoute -> Codex Desktop IPC -> Desktop task owner
```

实际消息没有独立 app-server、共享端口或 fallback。只有用户输入新名称时，项目固定 app-server 才短暂创建空任务并维护名称；它不接收真实 prompt，也不执行 turn。

## 旧实现位置

旧文件按原目录镜像保存在 `archive/legacy-codex-multi-runtime-2026-07-15/`：

- `src/codexAppServerClient.ts`：每个 gateway 启动独立 stdio app-server。
- `src/codexRuntime.ts`：按名称猜测线程并尝试唤起桌面窗口。
- `src/chatgptDesktopHost.ts`：桌面宿主可见性辅助逻辑。
- `scripts/check-codex-app-server-contract.mjs`：旧 stdio 契约检查。
- `plugin-adapters/remote-agent-rabiroute/codex-app-server-client.mjs`：远端桥独立启动 app-server。
- 对应测试文件。

## 当时的入口（均已退出运行链）

- Runtime 地址真源：`src/codexSharedRuntime.ts`
- Runtime 所有者：`src/manager/codexSharedRuntimeOwner.ts`
- Rabi 客户端：`src/codexAppServerClient.ts`
- CLI：`npm run codex:shared -- <args>`
- Desktop 配置：`npm run configure:codex-desktop`
- 契约检查：`npm run check:codex-contract`

原文件保存在 `legacy-codex-shared-runtime-2026-07-15/`，仅供审计。当前同名 npm scripts 已移除；当前契约检查验证 Desktop IPC 唯一 owner 和无 fallback。
