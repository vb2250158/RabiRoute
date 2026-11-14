# NapCat / OneBot

[中文](README.md)

This endpoint package owns its settings card, transport, protocol and lifecycle. Shared routing, history, configuration and API listener owners are host ports.

New WS ingress uses automatic port `0`. The original Gateway retains the actual socket and publishes its address; OneBot configuration and launch read and verify that address under the original binding operation. HTTP and WebUI retain explicit external endpoints. See [dynamic WS ingress](../../../docs/napcat-dynamic-ws_en.md) for Host `@3`, startup ordering, saved/runtime ownership and acceptance limits.

Supports read-only merged-forward pages, nested nodes and node attachments. Reads remain scoped to the original message and conversation. The persona plugin owns the cards; the shared message storage format remains unchanged.

When the selected message or forward node already provides an image URL, read it directly under the existing deadline and byte quota instead of waiting for another file lookup. Images without a URL use `get_image`; video, voice and files keep `get_file`. Callers cannot supply the URL, and downloads never carry OneBot credentials.
