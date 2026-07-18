<!-- docs-language-switch -->
<div align="center">
English | <a href="./rabi-agent-interfaces.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Rabi Interfaces for Handlers

> Status: current Agent-interface guide. The Remote Agent device path remains experimental; other interfaces have been checked against the current Manager API and tests.

These are local RabiRoute interfaces used by a handler after it receives an `AgentPacket`. They let the handler return a normal reply, work with Codex threads, maintain role plans and memories, read role skills, and optionally delegate to a connected Remote Agent device.

RabiRoute owns storage, policy checks, delayed plan archiving, explicit memory-consolidation runs, context injection, and Outbox delivery. The handler decides when a plan or memory should change and what response or task is appropriate.

## Context supplied to the handler

The packet normally includes:

```text
Rabi interface guide: docs/rabi-agent-interfaces.md
Reply API: http://127.0.0.1:8790/api/agent/replies
Current reply context: {...}
```

It also includes active-plan, recent-memory, and skill indexes plus `[Pre-action context confirmation]`. The handler must fetch every required-read item before replying, modifying role knowledge, publishing a task, or taking an external action.

## Normal reply API

Handlers should return user-facing chat replies through RabiRoute:

```http
POST /api/agent/replies
```

```json
{
  "text": "Received. I will investigate.",
  "replyContext": {
    "routeProfileId": "main",
    "targetType": "group",
    "messageId": "example-message-id",
    "groupId": "example-group-id",
    "instanceId": "default"
  }
}
```

The safest path is to pass the injected `replyContextJson` back unchanged. RabiRoute resolves the route, source record, output pipeline, adapter policy, and target.

Outbox returns one of:

```text
sent    delivered, queued to a supported local endpoint, or intentionally retained in the Agent session
draft   a non-sendable draft result
blocked rejected by policy, missing target, or missing configuration
failed  a real delivery attempt failed
```

There is no generic persistent approval center or automatic retry queue. Callers must inspect the returned status.

### NapCat source reply

Set `replyToSource: true` with the source `messageId` to add a OneBot reply segment for group messages. RabiRoute avoids adding a duplicate reply segment.

```json
{
  "text": "I have taken the issue and will update this thread.",
  "replyContext": {
    "routeProfileId": "main",
    "targetType": "group",
    "groupId": "example-group-id",
    "messageId": "example-message-id",
    "instanceId": "default",
    "replyToSource": true
  }
}
```

Local QQ group-file upload uses the same endpoint with `payloadType: "file"`, an allowed `filePath`, and a route policy whose NapCat `supportedOutputs` includes `file`. The real path must stay under `messageAdapterPolicies.napcat.allowedFileRoots`.

### WeCom

For a source reply, preserve WeCom fields such as `adapterType`, `wecomConversationId`, and `wecomChatId`. For a proactive group send, provide an explicit `adapterType=wecom`, `targetType=group`, and `groupId`/chat ID. The WeCom adapter remains experimental.

### RabiLink proactive output

An explicit `targetType: "rabilink"` and `proactive: true` can enqueue a device message when the selected route enables RabiLink output and has a Relay configured. The local handler still goes through Outbox; it must not bypass RabiRoute and call the Relay directly.

## Codex thread bridge

Background Codex turns may not receive Codex Desktop thread-management tools. RabiRoute therefore exposes a local bridge:

```http
GET  /api/agent/threads?action=list&query=<text>&limit=20
POST /api/agent/threads
```

POST actions:

- `list`: list matching threads, optionally restricted by a configured cwd.
- `read`: read a thread by `threadId`.
- `resolve`: reuse a valid saved ID only when its saved visible name and workspace still match. When the ID is empty, missing, stale, or paired with a different name, resolve by visible name plus cwd. One or more exact matches bind the unique latest `updatedAt`; create one empty task only when no match exists. A tied or unusable maximum returns candidates for selection.
- `create`: bootstrap an empty task in a configured workspace, then deliver any initial prompt to that task's Desktop owner through Desktop IPC.
- `send`: ask the existing Desktop task owner to start or steer the real turn through Desktop IPC.

```json
{
  "action": "resolve",
  "threadId": "019f0000-0000-7000-8000-000000000001",
  "title": "Rabi",
  "cwd": "C:/Path/To/Your/Project",
  "createIfMissing": true
}
```

Callers must not edit UUIDs manually. Selecting a different task supplies its ID; typing a new name must explicitly clear the previous ID before `resolve` performs name lookup or creation.

```json
{
  "action": "create",
  "title": "[Example][Research] Compare two integrations",
  "cwd": "C:/Path/To/Your/Project",
  "prompt": "Inspect the implementation and produce an evidence-backed comparison without modifying files.",
  "sandbox": "workspace-write"
}
```

```json
{
  "action": "send",
  "threadId": "019f0000-0000-7000-8000-000000000001",
  "cwd": "C:/Path/To/Your/Project",
  "prompt": "Continue with the new constraints and evidence.",
  "sandbox": "workspace-write"
}
```

`create` and `send` accept only a workspace already configured in RabiRoute. The `sandbox` field remains for interface compatibility; it does not override the target Desktop task's model, tools, sandbox, or approvals. Those capabilities belong to the Desktop owner. If Desktop is unavailable, IPC is not ready, or the task cannot be loaded, the call fails closed and does not fall back to app-server, CLI, or another Runtime.

## Plan API

Statuses:

```text
`未开始`  not started
`进行中`  in progress
`已完成`  completed
`已归档`  archived
```

```http
GET   /api/roles/:roleId/plans
GET   /api/roles/:roleId/plans/:planId
POST  /api/roles/:roleId/plans
PATCH /api/roles/:roleId/plans/:planId
```

```json
{
  "title": "Refresh routing documentation",
  "focus": "routing documentation accuracy",
  "status": "进行中",
  "priority": "medium",
  "kind": "documentation",
  "currentStep": "verify the active configuration schema",
  "nextAction": "update the bilingual guide",
  "keywords": ["routing", "configuration", "documentation"],
  "source": {
    "kind": "agent",
    "summary": "Created from the current documentation review"
  }
}
```

Completed plans are archived by a role-knowledge snapshot after their latest `updatedAt` is more than the current fixed 72-hour window old. This window is not yet a public `personaConfig.json` field.

## Recent-memory API

```http
GET   /api/roles/:roleId/memory/recent
GET   /api/roles/:roleId/memory/recent/:memoryId
POST  /api/roles/:roleId/memory/recent
PATCH /api/roles/:roleId/memory/recent/:memoryId
```

```json
{
  "title": "Documentation must follow implementation",
  "focus": "documentation fact-source rule",
  "content": "Verify code, schemas, APIs, WebGUI, and tests before translating or publishing a guide.",
  "keywords": ["documentation", "fact source", "tests"],
  "source": {
    "kind": "agent",
    "summary": "Confirmed during the documentation audit"
  }
}
```

`focus` must be a single line and `keywords` must contain at least one item. Reading by ID refreshes `viewedAt`; updating refreshes both `updatedAt` and `viewedAt`. Recent memory can be edited only inside the current fixed 24-hour activity window. That window is not yet a public persona configuration field.

## Write limits and validation

Plan and memory writes are validated for one focused subject, title/body lengths, source-summary length, per-keyword length, keyword count, and total text. Defaults can be overridden through `personaConfig.json` under `knowledgeLimits.plan` and `knowledgeLimits.memory`.

Validate all existing role knowledge with:

```http
GET /api/roles/:roleId/knowledge-validation
```

Old hand-written files remain readable, but a later write must satisfy the active limits.

## Consolidated memory

```http
GET /api/roles/:roleId/memory/consolidated
GET /api/roles/:roleId/memory/consolidated/:memoryId
```

Consolidated memories have no normal PATCH endpoint. If a stable memory is wrong, write a corrective recent memory and let a later consolidation produce a new stable record. Reading a consolidated item by ID refreshes `viewedAt`.

## Explicit memory consolidation

Current entry points:

- Trigger the built-in `manual_trigger` item with `triggerId=memory-consolidation`.
- Call the Manager API:

```http
POST /api/roles/:roleId/memory/consolidation-requests
```

```json
{
  "triggerOlderThanHours": 72,
  "includeOlderThanHours": 24,
  "force": false
}
```

The default request is due only when an unconsolidated recent memory has been inactive for more than 72 hours. Its input contains unconsolidated memories inactive for more than 24 hours. `force` skips the due check but does not include memories still inside the editable window. Time passing alone does not launch a resident background job.

Submit the handler result to:

```http
POST /api/roles/:roleId/memory/consolidation-runs/:runId/result
```

```json
{
  "type": "memory_consolidation_result",
  "memories": [
    {
      "title": "Stable documentation rule",
      "focus": "documentation fact-source rule",
      "content": "Public guides are calibrated against implementation before their English versions are maintained.",
      "keywords": ["documentation", "fact source"]
    }
  ]
}
```

RabiRoute writes the consolidated items, completes the run, and marks input memories with `consolidatedAt` and `consolidationRunId`.

## Remote Agent device API

> Maturity: experimental. The protocol and Manager API are implemented and tested, while real LAN/VPN/TLS/device environments still need end-to-end acceptance.

```http
GET  /api/remote-agent/devices
POST /api/remote-agent/tasks
```

The Manager discovers a remote `plugin-adapters/remote-agent-rabiroute` bridge and connects after the user supplies its password. Protocol v3 uses per-connection role-separated HMAC-SHA256 challenges and does not send the plaintext password over the WebSocket. Plain `ws://` authenticates peers but does not encrypt the link; use a trusted VPN or properly terminated `wss://` across untrusted networks.

Remote tasks are restricted to `REMOTE_AGENT_ALLOWED_CWDS`, use workspace-write behavior, and do not expose a danger-full-access path. File transfers have default single-file and per-task limits. Results return to the local RabiRoute personality thread; the remote device must not reply to QQ directly.

## Role skills

Role skills live under:

```text
data/roles/<RoleId>/skills/*.md
```

```http
GET /api/roles/:roleId/skills
GET /api/roles/:roleId/skills/:skillId
```

The list returns metadata; the item endpoint returns the complete Markdown body. Skill bodies are not injected into every packet. If a skill appears in required reads, the handler must fetch it before acting.

## Error boundary

Handlers should not directly modify consolidated memory, copy raw chat logs into memory, fetch all historical context without need, bypass Outbox, or treat RabiRoute as an Agent OS or executor queue. They should maintain focused plans and recent memories, read required evidence by ID, return consolidation results through the run API, and submit ordinary replies through `/api/agent/replies`.
