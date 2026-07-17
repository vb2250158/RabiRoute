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

Only `main` is enabled by default. RabiLink, native Rokid voice, voice-chat, WeCom, and XiaoAI are opt-in templates that require credentials, hardware, or external services.

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
| [`rabilink-aiui/`](./rabilink-aiui/README_en.md) | Experimental integration | Rokid AIUI foreground app, Relay integration, configuration assistant, and acceptance scripts. |
| [`rabilink-relay/`](./rabilink-relay/README_en.md) | Current example | Sanitized Relay tool-import and authentication templates. |
| [`android-rabi-link-probe/`](./android-rabi-link-probe/README_en.md) | Hardware research tool | Android, Rokid, and Xiaomi Health probes; not required by the main runtime. |
| [`rabi-link-vela-probe/`](./rabi-link-vela-probe/README_en.md) | Historical probe | Retained evidence from the vela wearable investigation. |
| `.env.example` | Optional template | Environment-variable startup for a single Gateway without the Manager. |
| `send-webhook-demo.*` | Current example | Sends test text to the generic Webhook endpoint. |

## Webhook demo

Start a Route with the `webhook` message adapter and confirm its endpoint, for example:

```text
http://127.0.0.1:8791/webhook
```

Run either standard-library example:

```powershell
node examples/send-webhook-demo.mjs
python examples/send-webhook-demo.py
```

You can also pass the endpoint and message explicitly:

```bash
node examples/send-webhook-demo.mjs http://127.0.0.1:8791/webhook "Test task from an external system"
python examples/send-webhook-demo.py http://127.0.0.1:8791/webhook "Test task from an external system"
```

## Public-data boundary

Keep every example safe to publish and reproduce. Real device credentials, user messages, and logs belong only in local configuration or runtime directories.
