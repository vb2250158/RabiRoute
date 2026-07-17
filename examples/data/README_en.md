<!-- docs-language-switch -->
<div align="center">
English | <a href="./README.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Example data directory

This is a public `data/` starter pack that can be copied to the repository root.

When either `data/route` or `data/roles` is missing, the Manager copies the corresponding example tree from here. Existing directories are not replaced wholesale.

The pack provides:

- A complete `route/main/adapterConfig.json` for QQ/NapCat and heartbeat input.
- The default `roles/Rabi` persona and the RabiLink-specific `roles/RabiActive` persona.
- `personaConfig.json` message rules and recent-message limits.
- Public plan and memory directory structures.
- A platform-neutral one-plan/one-task tracking skill example.
- A disabled RabiLink Route that demonstrates a record-first observation ledger, idle or periodic review, and proactive downstream replies.
- Relative `rolesDir` configuration suitable for a copied workspace.

Only `main` is enabled after copying the full pack. RabiLink, voice-chat, native Rokid voice, XiaoAI, and WeCom remain disabled until their credentials, working directories, and ports have been checked.

```powershell
xcopy examples\data data /E /I
```

```bash
cp -R examples/data/. data/
```

Do not add runtime logs, real messages, tokens, cookies, account IDs, or private paths to this directory.
