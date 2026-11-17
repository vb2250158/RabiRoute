[简体中文](./README.md) | English

# WorkBuddy（腾讯 AI 办公工作台）

Call public `POST /api/agent/threads` with `agentAdapter: "workbuddy"` and `agentTargetId: "local:workbuddy"` to list tasks, read task metadata, and query native transcripts by exact `threadId`. Use `action: "read"` with `history: { limit: 200 }`, then pass the returned cursor unchanged as `history.cursor`. Pages preserve original events in file order. `coverage` and `warnings` report malformed rows and incomplete trailing records. Queries and explicit-ID delivery work independently, while persona bindings select default routing destinations.

Delivery uses `action: "send"` with the target `threadId`, actual task `cwd`, `prompt`, and a stable `deliveryId`. On Windows, the first scan or delivery discovers the original owner's loopback listener and authenticates with that process's temporary gateway credential. Discovery checks the WorkBuddy process, PID, and creation time. Credentials travel over a private child-process pipe into an in-memory cache. The OS must allow Manager to read that process, including the corresponding access level when WorkBuddy is elevated. This integration remains experimental. Older versions can continue using configured local credentials. CodeBuddy HTTP requests include the required `X-CodeBuddy-Request: 1` header. See the [official HTTP API](https://cloud.tencent.com/document/product/1831/137064).

Local screenshots use the same session gateway’s `payload.attachments`: `{ type: "image", urlType: "local-path", url, name }`. The host presents references for the task’s Read tool, preserving the task and runtime. Prepared delivery saves the image digest and checks it before dispatch. Local image paths are not transferred to another computer.

This package owns the Agent's settings card, discovery, session operations, and delivery implementation. Manager and Gateway use the same native plugin profile. Disabling rejects new work while admitted operations retain their original leases, sessions, and external execution owners. Package metadata declares supported capabilities and maturity.

The manifest declares `entries.web.module: "./web/client.mjs"` directly. The complete Web build generates this file, re-exporting `activate` from the package's independent `/assets/…` module. The publisher pins the card assets to the same Web release; no additional `web.mjs` forwarding file is needed.

See the [Agent integration requirements](../../../../docs/agent-adapter-standard-requirements_en.md) for configuration switching and shared-task dependencies, and the [SDK](../../../contracts/plugin-sdk/README_en.md) for lifecycle contracts.
