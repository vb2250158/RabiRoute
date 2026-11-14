[简体中文](./README.md) | English

# DSH（DeepSeek Harness）

This package owns the Agent's settings card, discovery, session operations, and delivery implementation. Manager and Gateway use the same native plugin profile. Disabling rejects new work while admitted operations retain their original leases, sessions, and external execution owners. Package metadata declares supported capabilities and maturity.

The manifest declares `entries.web.module: "./web/client.mjs"` directly. The complete Web build generates this file, re-exporting `activate` from the package's independent `/assets/…` module. The publisher pins the card assets to the same Web release; no additional `web.mjs` forwarding file is needed.

See the [Agent integration requirements](../../../../docs/agent-adapter-standard-requirements_en.md) for configuration switching and shared-task dependencies, and the [SDK](../../../contracts/plugin-sdk/README_en.md) for lifecycle contracts.

When `dshBaseUrl` is omitted, the existing local DSH discovery uses explicit `DSH_WEB_URL` and original startup-log addresses without a fixed-port fallback. Missing owner addresses are reported as unconfigured and RPC is rejected. Discovery does not start, restart or change DSH. Explicit URLs remain supported.
## Native DSH sessions and plugins

This package publishes native DSH session listings, metadata and `sessions/:sessionId/history` under `/api/agent/providers/dsh`. History calls the current DSH `session/events` owner and preserves native records, message/tool IDs, `seq`, `cursor` and `hasMore`. Queries accept `beforeSeq/throughSeq/maxMessages`. Subagent history accepts its original `parentSessionId` and `mode`; DSH verifies the durable parent/child address. Native history and Rabi delivery correspondence remain separately discoverable.

`plugins` and `bundles` read DSH runtime plugins and installed bundles. `plugin-market` lists market sources and `POST plugin-market/search` takes native `url/query`. `POST plugins/install` takes `spec/options`, `POST plugins/:name/update` takes `version/options`, and `DELETE plugins/:name` removes the original bundle. Encode a scoped package name as one URL segment. All operations use the existing authenticated DSH RPC to its original `pluginManager` / `pluginMarket`. DSH owns installation, dependencies, configuration, activation and the native result. Preserve `options.requestId` for native progress and cancellation; it does not imply idempotent installation. Reconcile an uncertain result against the original bundle/request before any manual retry.
