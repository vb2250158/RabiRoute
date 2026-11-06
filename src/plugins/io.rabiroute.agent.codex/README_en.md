[简体中文](./README.md) | English

# Codex（ChatGPT 中的编码 Agent）

This package owns the Agent's settings card, discovery, session operations, and delivery implementation. Manager and Gateway use the same native plugin profile. Disabling rejects new work while admitted operations retain their original leases, sessions, and external execution owners. Package metadata declares supported capabilities and maturity.

The manifest declares `entries.web.module: "./web/client.mjs"` directly. The complete Web build generates this file, re-exporting `activate` from the package's independent `/assets/…` module. The publisher pins the card assets to the same Web release; no additional `web.mjs` forwarding file is needed.

See the [Agent integration requirements](../../../../docs/agent-adapter-standard-requirements_en.md) for configuration switching and shared-task dependencies, and the [SDK](../../../contracts/plugin-sdk/README_en.md) for lifecycle contracts.

## 0.1.3: delivery receipt reading

Receipt lookup continues past large tool output, image records, and complete user messages without a fixed per-record size cutoff. It still verifies the original task identity and accepted user messages. Incomplete JSONL tails, cancellation, and read errors retain the original receipt contract; they do not trigger a resend.
