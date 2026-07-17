<!-- docs-language-switch -->
<div align="center">
English | <a href="./README.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

#Archive

This directory preserves retired implementations that still have migration or audit value. Nothing under `archive/` participates in the TypeScript build, and new code must not depend on it.

## Current implementation (do not push back from archive)

The current formal path is `RabiRoute -> Codex Desktop IPC -> Desktop task owner`. Real messages do not use a standalone app-server or a shared port 4510. Delivery fails closed when Desktop is unavailable; there is no fallback executor. See `../src/codexDesktopBridge.ts` and `../src/codexRuntime.ts`.

## 2026-07-10: Old Desktop IPC attempt

- Archive: `src/codexDesktopIpc.ts` with corresponding tests.
- Reason for filing: It does not use deeplink to reliably load the target owner, and mixes it into the app-server fallback. There is no guarantee that a message has only one executor.
- Reusable lessons: IPC follower start/steer allows Desktop to display messages in real time, but it must be matched with accurate ID, cwd verification, owner wake-up and fail closed.

## 2026-07-15: Independent stdio multiple runtime

- Archive directory: `legacy-codex-multi-runtime-2026-07-15/`.
- Reason for filing: The background app-server shares persistence tasks with Desktop, but does not share real-time events, active turn status, and Desktop tools, and does not meet the product requirement of "messages immediately appear on Desktop".

## 2026-07-15: Shared 4510 Runtime

- Archive directory: `legacy-codex-shared-runtime-2026-07-15/`.
- Archive description: `codex-shared-runtime-migration-2026-07-15.md`.
- Archive reason: User-level `CODEX_APP_SERVER_WS_URL` binds Desktop cold start to RabiRoute Manager; in absence of Manager Desktop directly `ECONNREFUSED 127.0.0.1:4510`.

Archive code is only used to understand old data, logs and incident history; do not import, build or reconnect to the main chain after patching.
