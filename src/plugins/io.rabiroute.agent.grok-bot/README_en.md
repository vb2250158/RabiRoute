[简体中文](./README.md) | English

# Grok Bot

This package owns the Agent's settings card, discovery, session operations, and delivery implementation. Manager and Gateway use the same native plugin profile. Disabling rejects new work while admitted operations retain their original leases, sessions, and external execution owners. Package metadata declares supported capabilities and maturity.

The Gateway can activate a new version while admitted deliveries finish. Direct cloud deliveries store receipts by session and delivery ID, with a receipt lock shared across versions. Remote instance deliveries continue to send the same delivery ID to the original receiver. The Manager entry uses a serialized handover.

The manifest declares `entries.web.module: "./web/client.mjs"` directly. The complete Web build generates this file, re-exporting `activate` from the package's independent `/assets/…` module. The publisher pins the card assets to the same Web release; no additional `web.mjs` forwarding file is needed.

See the [Agent integration requirements](../../../../docs/agent-adapter-standard-requirements_en.md) for configuration switching and shared-task dependencies, and the [SDK](../../../contracts/plugin-sdk/README_en.md) for lifecycle contracts.
