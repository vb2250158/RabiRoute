<!-- docs-language-switch -->
<div align="center">
English | <a href="./README.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Archive

This directory retains only non-Codex archival material with independent migration value and no runtime dependency. `archive/` is excluded from the TypeScript build and must not be used as a dependency source.

The old Codex Desktop IPC, standalone app-server multi-runtime, and shared-4510 Runtime implementations have been removed from the working tree. Use Git history when they must be traced. The only real-message path is `RabiRoute -> Codex Desktop IPC -> Desktop task owner`; see `../src/codexDesktopBridge.ts` and `../src/codexRuntime.ts`.
