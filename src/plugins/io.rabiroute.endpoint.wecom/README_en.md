# 企业微信

[中文](README.md)

This endpoint package owns its settings card, transport, protocol and lifecycle. Shared routing, history, configuration and API listener owners are host ports.

During replacement, the old activation stops admitting messages, disconnects its WebSocket, and waits for accepted messages to finish direct routing or enter the host's grouping queue. The new activation then connects in the same Gateway. A failed startup uses the same cleanup and can be retried after it finishes. Waiting for direct routing requires the host's `forwardMessageWithCompletion` port. Older hosts use the existing forwarding entry.
