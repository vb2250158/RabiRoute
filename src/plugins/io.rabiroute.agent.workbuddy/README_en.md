[简体中文](./README.md) | English

# WorkBuddy（腾讯 AI 办公工作台）

Call public `POST /api/agent/threads` with `agentAdapter: "workbuddy"` and `agentTargetId: "local:workbuddy"` to list tasks, read task metadata, and query native transcripts by exact `threadId`. Use `action: "read"` with `history: { limit: 200 }`, then pass the returned cursor unchanged as `history.cursor`. Pages preserve original events in file order. `coverage` and `warnings` report malformed rows and incomplete trailing records. Queries and explicit-ID delivery work independently, while persona bindings select default routing destinations.

Delivery uses `action: "send"` with the target `threadId`, actual task `cwd`, `prompt`, and a stable `deliveryId`. On Windows, the first scan or delivery discovers the original owner's loopback listener and authenticates with that process's temporary gateway credential. Discovery checks the WorkBuddy process, PID, and creation time. Credentials travel over a private child-process pipe into an in-memory cache. The OS must allow Manager to read that process, including the corresponding access level when WorkBuddy is elevated. This integration remains experimental. Older versions can continue using configured local credentials. CodeBuddy HTTP requests include the required `X-CodeBuddy-Request: 1` header. See the [official HTTP API](https://cloud.tencent.com/document/product/1831/137064).

The 0.1.6 candidate uses `POST /api/v1/sessions/{exact-task-ID}/reply` on the original task process. The host checks its current session ID before native queue admission; a mismatch returns 409 without trying another delivery entry. This call chain does not set or change permission mode; the native task retains tool approval handling. HTTP 200 with `data.delivered: true` acknowledges admission, which may only enqueue work. It does not establish completion or live desktop rendering.

Local screenshots preserve the host's existing textual attachment-reference format, listing absolute paths for the original task's Read tool. Files are checked before sending; prepared delivery saves and rechecks image digests. Paths are not transferred across computers, and a reference does not prove that the image was read.

Task creation, renaming and desktop initialization of unloaded tasks remain unimplemented. Static review and the wrong-target 409 protocol check passed; formal adoption and real-task receipt, approval and live desktop rendering for 0.1.6 require separate acceptance. Version 0.1.5 remains verified only for the original process's primary session; its generic gateway prefers that session and temporarily selects `BypassPermissions`. Existing uncertain deliveries retain their original IDs. Network interruption, 5xx or missing native receipts never trigger automatic resend.

This package owns the Agent's settings card, discovery, session operations, and delivery implementation. Manager and Gateway use the same native plugin profile. Disabling rejects new work while admitted operations retain their original leases, sessions, and external execution owners. Package metadata declares supported capabilities and maturity.

The manifest declares `entries.web.module: "./web/client.mjs"` directly. The complete Web build generates this file, re-exporting `activate` from the package's independent `/assets/…` module. The publisher pins the card assets to the same Web release; no additional `web.mjs` forwarding file is needed.

See the [Agent integration requirements](../../../docs/agent-adapter-standard-requirements_en.md) for configuration switching and shared-task dependencies, and the [SDK](../../../plugins/contracts/plugin-sdk/README_en.md) for lifecycle contracts.
