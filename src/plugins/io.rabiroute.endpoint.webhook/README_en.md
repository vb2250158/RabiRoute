# 通用 Webhook

[中文](README.md)

This endpoint package owns its settings card, transport, protocol and lifecycle. Shared routing, history, configuration and API listener owners are host ports.

New generic Webhook endpoints default to port `0`, letting the operating system allocate an available port. The native listener publishes its actual address through the Manager API catalog and runtime status. The saved preference remains `0`; rediscover after restart. Explicit nonzero ports retain their original contract and report bind conflicts.
