[简体中文](./README.md) | English

# AstrBot

This package owns the Agent's settings card, discovery, session operations, and delivery implementation. Manager and Gateway use the same native plugin profile. Disabling rejects new work while admitted operations retain their original leases, sessions, and external execution owners. Package metadata declares supported capabilities and maturity.

The manifest declares `entries.web.module: "./web/client.mjs"` directly. The complete Web build generates this file, re-exporting `activate` from the package's independent `/assets/…` module. The publisher pins the card assets to the same Web release; no additional `web.mjs` forwarding file is needed.

See the [Agent integration requirements](../../../../docs/agent-adapter-standard-requirements_en.md) for configuration switching and shared-task dependencies, and the [SDK](../../../contracts/plugin-sdk/README_en.md) for lifecycle contracts.

AstrBot requires a Route `astrbotUrl` or explicit `ASTRBOT_URL`; no default port is guessed. Catalogs contain only projects and sessions returned by the selected Dashboard API. Empty results are never filled from a local database without that native owner identity. Environment passwords apply only when both the endpoint and account match the environment configuration. Scans with multiple targets do not choose an account for login. Delivery tokens are cached per URL and account credentials, so changing the endpoint requires a new login.
