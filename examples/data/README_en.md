<!-- docs-language-switch -->
<div align="center">
English | <a href="./README.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Example data directory

This is a public `data/` starter pack that can be copied to the repository root.

When `data/manager.json`, `data/route`, or `data/roles` is missing, the Manager copies the corresponding safe example. Existing files and directories are not replaced wholesale.

The pack provides:

- A `manager.json` built-in plugin composition. `manager:core` is required; other instances can be disabled and reloaded independently.
- A complete `route/main/adapterConfig.json` named **Rabi Demo** for QQ/NapCat and heartbeat input. Its `agentRoleId: "Rabi"` binds the Rabi persona.
- The default `roles/Rabi` persona and the RabiLink-specific `roles/RabiActive` persona.
- `personaConfig.json` automation rules and recent-message limits. The example includes message-to-Agent and schedule-to-Agent rules and does not run scripts by default.
- Public plan and memory directory structures.
- A platform-neutral one-plan/one-task tracking skill example.
- A disabled RabiLink Route that demonstrates a record-first observation ledger, idle or periodic review, and proactive downstream replies.
- A disabled personal-Weixin Route prototype. Login tokens, sync cursors, and context tokens are created only under local runtime `data/` after opt-in; the public example contains no real account or credential.
- Relative `rolesDir` configuration suitable for a copied workspace.

`manager.json` lists the current 26 built-in Manager plugins by default. Seven publish presentation contributions; the other nineteen still own HTTP, service, process, timer, listener, or reconciliation lifecycles. The presentation Contribution Catalog publishes only `page`, `navigation`, `settings-section`, `status-card`, `command`, `tray-menu`, `hotkey`, and `theme`; Manager plugin `apply` hooks register business HTTP routes. The central HTTP chain is limited to LAN authentication, the read-only write gate, plugin route dispatch, Manager SSE, plugin catalog/reconciliation, static assets, JSON 404 for control paths, and WebGUI HTML fallback for all other paths. WebGUI/Desktop resolve new renderer, route, handler, and resource contracts through host-owned trusted registries; unknown or unregistered contributions fail closed. A controlled Extension Host for arbitrary third-party presentation code remains future work. Unified validation has not been run.

Only `main` is enabled after copying the full pack. RabiLink, voice-chat, native Rokid voice, XiaoAI, WeCom, and personal Weixin remain disabled until credentials or QR login, working directories, and ports have been checked.

```powershell
xcopy examples\data data /E /I
```

```bash
cp -R examples/data/. data/
```

Do not add runtime logs, real messages, tokens, cookies, account IDs, or private paths to this directory.
