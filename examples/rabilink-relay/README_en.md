<!-- docs-language-switch -->
<div align="center">
English | <a href="./README.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# RabiLink Relay examples

> Status: current public configuration templates. The Relay service remains an independently deployed integration that requires environment acceptance.

This directory contains sanitized RabiLink Relay imports. Real domains, server addresses, application tokens, generated OpenAPI documents, and handoff records belong under runtime `data/rabilink-relay/`.

Rizon exposes two similar import paths:

- Use `rokid-rabilink-plugin.*.example.json` when creating or replacing a complete plugin.
- Use `rokid-rabilink-tools-import.example.postman.json` from a plugin's “Import tools” screen.

Complete plugin templates cover three authentication models:

- `CURRENT` declares the `X-RabiLink-Token` security scheme for a private plugin.
- `MANUAL_AUTH` omits the scheme and expects a manually configured plugin header.
- `AGENT_TOKEN` keeps publisher credentials out of a public template and binds each Agent's own token as a tool parameter.

Keep a direct link to the [RabiRoute GitHub repository](https://github.com/vb2250158/RabiRoute) in the plugin description so users can find setup and token-binding instructions.

The tool-import template intentionally exposes only `submitRabiLinkTask` and `getRabiLinkMessages`. If Rizon reports an inconsistent API URL prefix for OpenAPI, use the Postman Collection with literal HTTPS URLs; current imports do not expand `{{base_url}}` variables.

Validate the examples with:

```powershell
npm run relay:rabilink:openapi:check
```

Rizon/Lingzhu submits to `POST /rokid/rabilink/input`. HTTP 202 with `eventId` and a cursor confirms enqueueing; downstream messages establish the Agent response. Native AIUI uses the generic API transport described in the [AIUI client](../../apps/rabilink-aiui/README_en.md). `--examples-only` validates public templates without converting private imports.

## Timeout settings

A standalone Relay reads a WebGUI-exported JSON override snapshot from `RABIROUTE_TIMEOUT_OVERRIDES` at startup. `relay.*` takes precedence over existing `RABILINK_RELAY_*_MS` variables; missing overrides retain previous defaults. Values are integer milliseconds from 1 to 2147483647. Saving a PC configuration does not update a remote Relay: apply the snapshot to that deployment and restart its process.

Authenticated requests may supply `X-Rabi-Timeout-Ms` for their own reply, WebGUI/speech proxy, or long-poll budget. SDK, phone, and glasses clients send their effective budget. Requests retain independent expiration times. A paired tunnel uses the shorter endpoint idle budget. Budgets do not replace authentication, original operation IDs, or uncertain-outcome reconciliation.
