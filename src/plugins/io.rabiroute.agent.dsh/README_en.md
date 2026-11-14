[简体中文](./README.md) | English

# DSH（DeepSeek Harness）

This package owns the Agent's settings card, discovery, session operations, and delivery implementation. Manager and Gateway use the same native plugin profile. Disabling rejects new work while admitted operations retain their original leases, sessions, and external execution owners. Package metadata declares supported capabilities and maturity.

The manifest declares `entries.web.module: "./web/client.mjs"` directly. The complete Web build generates this file, re-exporting `activate` from the package's independent `/assets/…` module. The publisher pins the card assets to the same Web release; no additional `web.mjs` forwarding file is needed.

See the [Agent integration requirements](../../../../docs/agent-adapter-standard-requirements_en.md) for configuration switching and shared-task dependencies, and the [SDK](../../../contracts/plugin-sdk/README_en.md) for lifecycle contracts.

When `dshBaseUrl` is omitted, the existing local DSH discovery uses explicit `DSH_WEB_URL` and original startup-log addresses without a fixed-port fallback. Missing owner addresses are reported as unconfigured and RPC is rejected. Discovery does not start, restart or change DSH. Explicit URLs remain supported.
