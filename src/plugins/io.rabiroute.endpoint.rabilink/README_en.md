# 手机 / RabiLink

[中文](README.md)

This endpoint package owns its settings card, transport, protocol and lifecycle. Shared routing, history, configuration and API listener owners are host ports.

During an update, the retiring Relay worker stops claiming new tasks and finishes sending results it has already produced. If Relay offers an accepted task again, the replacement in the same Gateway process can acknowledge the original task ID.
