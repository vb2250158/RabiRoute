<!-- docs-language-switch -->
<div align="center">
English | <a href="./codex-shared-runtime-migration-2026-07-15.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Codex shared Runtime failure scenario archive

## Conclusion

This document records a design that was implemented and then withdrawn on 2026-07-15. It is not the current architecture.

The retired design made the Rabi Manager own an app-server at `ws://127.0.0.1:4510` and turned the gateway, Codex/ChatGPT Desktop, and Codex CLI into its clients. A user-level `CODEX_APP_SERVER_WS_URL` inverted lifecycle ownership: Desktop could not cold-start while the Manager was stopped and reported `ECONNREFUSED 127.0.0.1:4510`.

The current formal path is:

```text
RabiRoute -> Codex Desktop IPC -> Desktop task owner
```

Real messages use no standalone app-server, shared port, or fallback executor. When a user explicitly enters a new task name, the project-pinned app-server may briefly create and name an empty task. It never receives the routed prompt and never executes the turn.

## Old implementation location

The old files are preserved under `archive/legacy-codex-multi-runtime-2026-07-15/` using their original relative layout:

- `src/codexAppServerClient.ts`: started one independent stdio app-server per gateway.
- `src/codexRuntime.ts`: guessed threads by name and tried to bring the Desktop window forward.
- `src/chatgptDesktopHost.ts`: Desktop-host visibility helpers.
- `scripts/check-codex-app-server-contract.mjs`: retired stdio contract check.
- `plugin-adapters/remote-agent-rabiroute/codex-app-server-client.mjs`: remote bridge that started its own app-server.
- Corresponding test files.

## Retired entry points

- Runtime-address source of truth: `src/codexSharedRuntime.ts`
- Runtime owner: `src/manager/codexSharedRuntimeOwner.ts`
- Rabi client: `src/codexAppServerClient.ts`
- CLI: `npm run codex:shared -- <args>`
- Desktop configuration: `npm run configure:codex-desktop`
- Contract Check: `npm run check:codex-contract`

The shared-Runtime implementation is preserved under `legacy-codex-shared-runtime-2026-07-15/` for audit only. The corresponding npm scripts have been removed. Current contract checks enforce Desktop IPC, one task owner, and no fallback executor.
