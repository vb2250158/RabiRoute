<!-- docs-language-switch -->
<div align="center">
<a href="./README.md">简体中文</a> | English
</div>
<!-- /docs-language-switch -->

# Rabi Agent

Rabi Agent is a headless LAN worker, not a full RabiRoute client. It opens an outbound connection to Rabi Manager, receives work, and delivers only through Codex Desktop IPC to the task owner selected at bootstrap.

- Requires Node.js 22+ and an open Codex/ChatGPT Desktop.
- Does not include Manager, Gateway, WebGUI, pairing codes, UDP discovery, or device passwords.
- Reuses the LAN connection Token. Bootstrap pins the release public-key SHA-256 fingerprint; updates compare that fingerprint before verifying the Ed25519 signature and each file SHA-256.
- On an update request it downloads, verifies, and switches itself. If the replacement does not connect within 30 seconds, the old version remains active.
- `--bootstrap` writes current-user private configuration and a current-user login startup entry. The startup entry contains no Token.

See [LAN Rabi Agent bootstrap and updates](../../docs/lan-rabi-agent-bootstrap_en.md) for first connection, configuration fields, and the bootstrap prompt.

```bash
node rabi-agent.mjs --bootstrap
```

Before bootstrap, provide only `RABI_MANAGER_URL`, `RABI_LAN_LINK_TOKEN`, `RABI_NODE_ID`, `RABI_AGENT_DEFAULT_CWD`, `RABI_AGENT_ALLOWED_CWDS`, `RABI_AGENT_CODEX_THREAD_ID`, and `RABI_AGENT_RELEASE_PUBLIC_KEY_SHA256` to this process. Do not put the Token on a command line, in logs, in a repository, or in task text.
