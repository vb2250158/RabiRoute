<!-- docs-language-switch -->
<div align="center">
English | <a href="./README.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Examples

This directory contains public, copyable, and inspectable RabiRoute examples. They use placeholders, localhost addresses, template variables, and sanitized paths. Never add real account IDs, tokens, cookies, private messages, usernames, or runtime `data/` content.

Examples are not runtime dependencies. On first start, if either `data/route` or `data/roles` is absent, the Manager copies the corresponding example tree from [`examples/data/`](./data/README_en.md). Existing directories are not replaced wholesale.

## Start here

To try the main project, copy [`examples/data/`](./data/README_en.md) to the repository's `data/` directory. The pack provides one enabled QQ/NapCat plus heartbeat Route, together with the Rabi persona and sample message rules, plans, and memories.

Only `main` is enabled by default. RabiLink, native Rokid voice, voice-chat, WeCom, personal Weixin, and XiaoAI are opt-in templates that require credentials, hardware, QR login, or external services.

```powershell
xcopy examples\data data /E /I
```

```bash
cp -R examples/data/. data/
```

## Example map

| Directory | Maturity | Purpose |
| --- | --- | --- |
| [`data/`](./data/README_en.md) | Current example | Copyable Routes, personas, plans, and memory structures. |
| [`rabilink-relay/`](./rabilink-relay/README_en.md) | Current example | Sanitized Relay tool-import and authentication templates. |
| [`plugin-bundles/manager-echo/`](./plugin-bundles/manager-echo/README_en.md) | Current example | Controlled Manager Bundle, Profile Patch, and hot-replacement template. |
| [`linux/`](./linux/README_en.md) | Current example | Optional current-user systemd unit draft for running an existing Linux Host build in the foreground; not installed by the startup script. |
| [`rabi-link-vela-probe/`](./rabi-link-vela-probe/README_en.md) | Historical probe | Retained evidence from the vela wearable investigation. |
| `.env.example` | Optional template | Environment-variable startup for a single Gateway without the Manager. |
| `send-webhook-demo.*` | Current example | Sends test text to the generic Webhook endpoint. |

The phone companion and glasses clients are independently buildable, testable, and releasable products under [`apps/`](../apps/README_en.md), not examples.

## Webhook demo

Start a Route with the `webhook` message adapter and copy its currently listening Webhook URL from the page. The service publishes its address; there is no default port.

Pass that address as the first argument, or set `RABIROUTE_WEBHOOK_URL`. A missing URL fails immediately without sending a request.

```powershell
node examples/send-webhook-demo.mjs "$env:RABIROUTE_WEBHOOK_URL" "Test task from an external system"
python examples/send-webhook-demo.py "$env:RABIROUTE_WEBHOOK_URL" "Test task from an external system"
```

## Public-data boundary

Keep every example safe to publish and reproduce. Real device credentials, user messages, and logs belong only in local configuration or runtime directories.
