# NapCat / OneBot

The sign-in card reads the current account state as it opens and retains an existing QR code during background checks. Native QQ failures, such as account security restrictions or an expired QR code, appear directly on the card. Follow any instructions in QQ on your phone. A timed-out read releases the loading state and checks continue; closing the card cancels its read without repeating sign-in actions or messages.

Failed sends expose `deliveryError.code` for `NAPCAT_LOGIN_REQUIRED`, `QQ_PERMISSION_DENIED`, `NAPCAT_AUTHENTICATION_FAILED`, `NAPCAT_CONNECTION_FAILED`, and `RABI_ROUTE_PERMISSION_DENIED`, with a Chinese `message` and a machine-readable `recoveryAction`. A login error requires verified expired login on the same instance and a connection failure proving that the request was not sent. Timeouts retain `platformResult=unknown`. The initial response and original-ID receipt preserve the same diagnostics. Restoring login does not resend a completed failed delivery.

[中文](README.md)

This endpoint package owns its settings card, transport, protocol and lifecycle. Shared routing, history, configuration and API listener owners are host ports.

New WS ingress uses automatic port `0`. The original Gateway retains the actual socket and publishes its address; OneBot configuration and launch read and verify that address under the original binding operation. HTTP and WebUI retain explicit external endpoints. See [dynamic WS ingress](../../../docs/napcat-dynamic-ws_en.md) for Host `@3`, startup ordering, saved/runtime ownership and acceptance limits.

Supports read-only merged-forward pages, nested nodes and node attachments. Reads remain scoped to the original message and conversation. The persona plugin owns the cards; the shared message storage format remains unchanged.

A compatible Manager advertises `napcat.group-forward` in the send capability catalog. Specify the exact group and instance and provide text entries in `data.nodes`. Entries use the authenticated bot's attribution. Read the receipt with the original `deliveryId`.

When the selected message or forward node already provides an image URL, read it directly under the existing deadline and byte quota instead of waiting for another file lookup. Images without a URL use `get_image`; video, voice and files keep `get_file`. Callers cannot supply the URL, and downloads never carry OneBot credentials.

When NapCat reports an expired message lookup, first read history around the original ID. If that anchor is also unavailable, read one recent page from the same conversation (at most 100 messages) and require the original message ID and target to match. The existing request deadline, cancellation and concurrency budget remain in force. A page miss does not establish absence from the full history.

See [API coverage](../../../docs/napcat-api-coverage_en.md) for versioned contracts, calls and execution boundaries.
