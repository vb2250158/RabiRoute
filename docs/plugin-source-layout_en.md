# Plugin source, versions, and public configuration

[简体中文](plugin-source-layout.md)

Each plugin has one canonical source folder: `src/plugins/<stable-plugin-id>/`. The current tree contains 43 native Rabi plugins and nine extensions for other hosts. Implementation, configuration definitions, UI, translations, tests, documentation, and assets belong to that folder. Shared configuration, routing, identity, and ledgers continue to use their original owners.

Native plugins keep `rabi.plugin.json`, `package.json`, owned `src/`, `web/`, `assets/`, adjacent tests, optional `storage-migrations.json`, and bilingual documentation together. Codex, CodeBuddy, DSH, NapCat, and local services retain their ecosystem manifest formats. `plugins/source-catalog.json` references authoritative version files without copying their version values.

`plugins/contracts/` contains the SDK and public host API. `plugins/profiles/` contains public composition and exact legacy-version migrations. Only distribution artifacts use `dist/plugins/packages/<id>/<version>/`. Source has no per-version copies; published releases remain available through Git history and release archives.

## Versioning and builds

Host architecture, extension-point, and startup contract changes update the host version. Plugin behavior, configuration, and asset changes update that plugin's version. New native plugins start at `0.1.1`; existing published ecosystem extensions continue their own release sequences. Capability major versions and package versions are separate contracts.

```sh
npm run plugin:version -- io.rabiroute.agent.codex 0.1.3
npm run plugin:build -- --package io.rabiroute.agent.codex --output-directory ../codex-plugin-candidate
npm run plugin:export -- io.rabiroute.agent.codex ../codex-plugin-source
```

Versioning updates only the selected plugin's manifests, npm metadata, and exact composition references. Selected builds use a separate output, preserving the full application output. Export prepares reviewable source; it does not create or publish a GitHub repository.

The SDK provides `rabi-plugin-build` for standalone backend builds. Shared dependencies use explicit `@rabiroute/host-api/<moduleId>` imports. Builders consume published export signatures and declarations without copying authoritative host state. Run the workspace's `npm run build`, then `npm pack` the SDK and host-api contract folders for the exported development environment.

The backend build emits code and public API declarations in one TypeScript check, then publishes the required declaration closure. Plugin development can build the selected package; host architecture or shared interface changes require the complete application build.

Plugin Web sources are declared by `package.json.rabi.webSource` and built together with the actual Web release. A standalone backend build does not prove an independently published Web bundle or process worker; each still needs its corresponding resource, process, and host contract validation.

## Public and private files

- Publish source, tests, documentation, icons, schemas, public defaults, and placeholder examples.
- `route-config.json` defines fields and defaults. Actual accounts, tokens, connections, and role settings stay with the runtime configuration owner.
- Keep actual environment files, authentication, sessions, private saves, logs, model caches, and build output outside public source. Each plugin carries its own ignore rules for a future repository.
- Export and packaging share the SDK's public-source filter. Review the final diff and example values before publication.

See [plugin storage](plugin-storage_en.md) for stable namespaces, migration recovery, read-only validation, exact legacy remote sources, and Xiaomi external-resource bindings. Shared role, Route, and delivery ledgers retain their original owners and IDs.

## All plugin sources

The following index points to authoritative manifests. Read their current values or the actual runtime UI for release versions.

<!-- plugin-source-index -->
| Plugin | Source folder | Version authority |
| --- | --- | --- |
| `io.rabiroute.agent.antigravity` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.agent.antigravity) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.agent.antigravity/rabi.plugin.json) |
| `io.rabiroute.agent.astrbot` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.agent.astrbot) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.agent.astrbot/rabi.plugin.json) |
| `io.rabiroute.agent.codex` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.agent.codex) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.agent.codex/rabi.plugin.json) |
| `io.rabiroute.agent.copilot-cli` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.agent.copilot-cli) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.agent.copilot-cli/rabi.plugin.json) |
| `io.rabiroute.agent.device-agent` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.agent.device-agent) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.agent.device-agent/rabi.plugin.json) |
| `io.rabiroute.agent.dsh` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.agent.dsh) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.agent.dsh/rabi.plugin.json) |
| `io.rabiroute.agent.grok-bot` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.agent.grok-bot) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.agent.grok-bot/rabi.plugin.json) |
| `io.rabiroute.agent.marvis` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.agent.marvis) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.agent.marvis/rabi.plugin.json) |
| `io.rabiroute.agent.workbuddy` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.agent.workbuddy) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.agent.workbuddy/rabi.plugin.json) |
| `io.rabiroute.endpoint.feishu` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.endpoint.feishu) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.endpoint.feishu/rabi.plugin.json) |
| `io.rabiroute.endpoint.heartbeat` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.endpoint.heartbeat) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.endpoint.heartbeat/rabi.plugin.json) |
| `io.rabiroute.endpoint.napcat` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.endpoint.napcat) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.endpoint.napcat/rabi.plugin.json) |
| `io.rabiroute.endpoint.rabilink` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.endpoint.rabilink) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.endpoint.rabilink/rabi.plugin.json) |
| `io.rabiroute.endpoint.speech` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.endpoint.speech) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.endpoint.speech/rabi.plugin.json) |
| `io.rabiroute.endpoint.webhook` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.endpoint.webhook) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.endpoint.webhook/rabi.plugin.json) |
| `io.rabiroute.endpoint.wecom` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.endpoint.wecom) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.endpoint.wecom/rabi.plugin.json) |
| `io.rabiroute.endpoint.weixin` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.endpoint.weixin) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.endpoint.weixin/rabi.plugin.json) |
| `io.rabiroute.manager.agent-adapter-catalog` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.manager.agent-adapter-catalog) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.manager.agent-adapter-catalog/rabi.plugin.json) |
| `io.rabiroute.manager.agent-communication` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.manager.agent-communication) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.manager.agent-communication/rabi.plugin.json) |
| `io.rabiroute.manager.agent-state-control` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.manager.agent-state-control) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.manager.agent-state-control/rabi.plugin.json) |
| `io.rabiroute.manager.agent-thread-control` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.manager.agent-thread-control) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.manager.agent-thread-control/rabi.plugin.json) |
| `io.rabiroute.manager.bilibili-history` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.manager.bilibili-history) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.manager.bilibili-history/rabi.plugin.json) |
| `io.rabiroute.manager.core` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.manager.core) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.manager.core/rabi.plugin.json) |
| `io.rabiroute.manager.desktop` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.manager.desktop) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.manager.desktop/rabi.plugin.json) |
| `io.rabiroute.manager.desktop-pet` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.manager.desktop-pet) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.manager.desktop-pet/rabi.plugin.json) |
| `io.rabiroute.manager.diagnostics` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.manager.diagnostics) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.manager.diagnostics/rabi.plugin.json) |
| `io.rabiroute.manager.gateway-runtime` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.manager.gateway-runtime) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.manager.gateway-runtime/rabi.plugin.json) |
| `io.rabiroute.manager.html-shares` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.manager.html-shares) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.manager.html-shares/rabi.plugin.json) |
| `io.rabiroute.manager.memory-consolidation` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.manager.memory-consolidation) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.manager.memory-consolidation/rabi.plugin.json) |
| `io.rabiroute.manager.message-adapter-control` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.manager.message-adapter-control) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.manager.message-adapter-control/rabi.plugin.json) |
| `io.rabiroute.manager.message-processing-automation` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.manager.message-processing-automation) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.manager.message-processing-automation/rabi.plugin.json) |
| `io.rabiroute.manager.message-processing-control` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.manager.message-processing-control) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.manager.message-processing-control/rabi.plugin.json) |
| `io.rabiroute.manager.performance` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.manager.performance) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.manager.performance/rabi.plugin.json) |
| `io.rabiroute.manager.persona` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.manager.persona) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.manager.persona/rabi.plugin.json) |
| `io.rabiroute.manager.plan-feedback-delivery` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.manager.plan-feedback-delivery) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.manager.plan-feedback-delivery/rabi.plugin.json) |
| `io.rabiroute.manager.rabilink-relay` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.manager.rabilink-relay) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.manager.rabilink-relay/rabi.plugin.json) |
| `io.rabiroute.manager.remote-agent` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.manager.remote-agent) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.manager.remote-agent/rabi.plugin.json) |
| `io.rabiroute.manager.route-control` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.manager.route-control) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.manager.route-control/rabi.plugin.json) |
| `io.rabiroute.manager.speech` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.manager.speech) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.manager.speech/rabi.plugin.json) |
| `io.rabiroute.manager.video` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.manager.video) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.manager.video/rabi.plugin.json) |
| `io.rabiroute.manager.wearable-companion` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.manager.wearable-companion) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.manager.wearable-companion/rabi.plugin.json) |
| `io.rabiroute.manager.xiaomi-home` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.manager.xiaomi-home) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.manager.xiaomi-home/rabi.plugin.json) |
| `io.rabiroute.manager.yeyu-gamer` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.manager.yeyu-gamer) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.manager.yeyu-gamer/rabi.plugin.json) |
| `napcat-rabiroute` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/napcat-rabiroute) | [package.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/napcat-rabiroute/package.json) |
| `napcat-stickers` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/napcat-stickers) | [package.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/napcat-stickers/package.json) |
| `rabi-antigravity-context` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/rabi-antigravity-context) | [plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/rabi-antigravity-context/plugin.json) |
| `rabi-codex-context` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/rabi-codex-context) | [.codex-plugin/plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/rabi-codex-context/.codex-plugin/plugin.json) |
| `rabi-dsh-context` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/rabi-dsh-context) | [package.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/rabi-dsh-context/package.json) |
| `rabi-speech` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/rabi-speech) | [rabi-plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/rabi-speech/rabi-plugin.json) |
| `rabi-workbuddy-context` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/rabi-workbuddy-context) | [.codebuddy-plugin/plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/rabi-workbuddy-context/.codebuddy-plugin/plugin.json) |
| `remote-agent-rabiroute` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/remote-agent-rabiroute) | [package.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/remote-agent-rabiroute/package.json) |
| `xiaoai-rabiroute` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/xiaoai-rabiroute) | [package.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/xiaoai-rabiroute/package.json) |
<!-- /plugin-source-index -->
