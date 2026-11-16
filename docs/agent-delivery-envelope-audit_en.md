> Historical task material, reviewed on 2026-11-14. The current C workspace and installed Host are 0.15.2 (`dcfb8a42`). This document preserves its original task-stage content. Version references, line numbers and completion markers retain their original context. Verify current behavior against the [code architecture](code-architecture_en.md), [Agent integration requirements](agent-adapter-standard-requirements_en.md) and formal acceptance evidence.

<!-- docs-language-switch -->
<div align="center">English | <a href="./agent-delivery-envelope-audit.md">简体中文</a></div>
<!-- /docs-language-switch -->

# Agent delivery envelope audit: markdown format and missing source

This document records the actual format of the delivery envelope RabiRoute prepends to Agent-bound content, every delivery path, and the degradation that occurs when the message source is absent. Conclusions come from source reading and real-device delivery checks, not inference.

## Scope

The delivery envelope is the prefix an Agent sees: who sent it, from which session, and when. It is the only basis for deciding whether a reply is needed; the body can be understood on its own, the source cannot be inferred.

Covered: `src/shared/rabiMessage.ts`, the session task interface in `src/agentThreads.ts` (create / send), each adapter's `deliver(message)` path, and real delivery results.

Not covered: outbound formatting for message channels (QQ / WeChat / Feishu), plan and memory body templates.

## 1. Current envelope format

Conclusion: **markdown is adopted, but only on paths that carry a source.**

Header constants (`src/shared/rabiMessage.ts:55-56`):

```ts
export const RABI_MESSAGE_SOURCE_HEADER = "## 消息源";
export const RABI_MESSAGE_CONTENT_HEADER = "## 消息内容";
```

`stripLeadingRabiEnvelope` (L133-164) still accepts the older `[消息源]` / `[投递源]` bracket form, which shows a past `[...]` to `##` migration.

`renderRabiDelivery` (L183-192) produces:

```markdown
## 消息源
- 类型：Agent｜处理端：codex
- 会话：<session name>
- 会话 ID：<full session id>
- 工作目录：<workspace>
- 投递 ID：<uuid>
- 投递时间：2026/11/13 14:34:25

## 消息内容
<body>
```

Notes:

- The first line is `## 消息源`; every following line gets a `- ` prefix in `rabiMessageSourceLines` (L130), forming a markdown list.
- `deliverySentAt` (L86-89) always has a fallback (`new Date().toLocaleString("zh-CN")`), so any call that reaches `renderRabiDelivery` has a timestamp.
- The `## 消息内容` header is added **only** by `renderRabiDelivery` (L189). `renderRabiDeliveryContent` (L195-213) returns the body alone.

## 2. Delivery path inventory

### Class A: full envelope (`renderRabiDelivery`)

| Entry | Location |
| --- | --- |
| Route delivery | `src/forwarding.ts:44` |
| AgentPacket body | `src/routing/agentPacket.ts:1217`, `:1518` |
| Endpoint delivery | `src/agentRequests/endpointDelivery.ts:218` |
| RabiLink conversation review | `src/rabilinkConversationReviewer.ts:472` |
| Delivery replay | `src/deliveryReplay.ts:22` |
| LAN / remote instance | `src/agentAdapters/lanAgentAdapter.ts:25`, `:34`; `instanceClient.ts:43` |
| Device Agent | `src/agentAdapters/deviceAgentAdapter.ts:22`; `deviceAgentOwner.ts:136` |
| Grok Bot | `src/agentAdapters/grokBotAdapter.ts:213` |
| Per-adapter `deliver(message)` | `pluginImplementations/*.ts` all call `notify*(renderRabiDelivery(envelope))` |

### Class B: conditional envelope (`src/agentThreads.ts`)

| Path | Condition | Result |
| --- | --- | --- |
| `createThread` (L730-738) | `messageSource` present | Full markdown envelope |
| `createThread` (L730-738) | `messageSource` absent | Body only; no source section, no content header, no timestamp |
| `send` (L1583-1603) | `sendSource` present | Full markdown envelope |
| `send` (L1583-1603) | `sendSource` absent | Falls back to `standaloneWorkspacePolicyPrompt`, same degradation |
| DSH `create` | `messageSource` present | Full markdown envelope |

### Class C: the shared fallback

`standaloneWorkspacePolicyPrompt` (`src/agentThreads.ts:390-406`):

```ts
if (!messageSource)
  return [
    ...(deliveryId ? ['[投递编号]\ndeliveryId: ' + deliveryId] : []),
    renderRabiDeliveryContent({ messageContent: rawPrompt, contextBlocks, controlBlocks })
  ].join('\n\n');
return renderRabiDelivery({ messageSource, ... });
```

This single branch is the root cause of every degradation below.

## 3. Defects

### D1: losing one field discards the whole source, silently

`describeAgentThreadMessageSource`:

```ts
const provider  = input.agentAdapter ?? context?.provider;
const sessionId = input.sessionId    ?? context?.sessionId;
if (!provider || !sessionId) return undefined;
```

Passing `agentAdapter` without `sessionId` (or the reverse) turns the entire source into `undefined`, with no error, no warning, and no hint in the response.

### D2: no source means no envelope at all

In the `!messageSource` branch of `standaloneWorkspacePolicyPrompt`, the body starts on the first line. Verified on a real Codex session: the first user message in the rollout begins with the caller's text, with no header of any kind.

Consequences: the Agent cannot tell where the message came from; the same API yields markdown in one case and plain text in another; and because the `## 消息内容` header is also missing, "does this body already carry an envelope" cannot be decided by a single rule, which affects replay and receipt recovery.

### D3: source fields have no fallback, so passing an empty object renders `undefined`

`agentSourceLines` (`src/shared/rabiMessage.ts:76-84`):

```ts
`会话：${source.sessionName}`,
`会话 ID：${source.sessionId}`,
```

Neither line goes through `optionalLine`, while `normalizeAgentIdentity` (L251-265) uses `requiredSourceText` for the same fields and throws on empty values. A fix therefore cannot simply pass an empty object upstream; it must be made in the rendering layer.

### D4 (related): create and send handle the envelope asymmetrically

`createThread`, the DSH create branch, and `send` each assemble the body themselves while sharing one helper, with no single constraint that an envelope must always be present.

## 4. Impact

| Scenario | Affected |
| --- | --- |
| Route delivery (QQ / WeChat / Feishu triggered) | No |
| Plan, memory, heartbeat delivery | No |
| Session task create with source | No |
| Session task create without source | **Yes** |
| Session task send between Agents (`sendSource`) | No |
| Session task send without `sendSource` | **Yes** |
| External caller using raw HTTP against `/api/agent/threads` | **Yes**: raw HTTP has no host context, so the source must be supplied by hand |

## 5. Recommended fixes

1. **Render-layer fallback**: route `会话` and `会话 ID` through `optionalLine` and render missing values as「未知」.
2. **Never drop the envelope**: the `!messageSource` branch must still emit `## 消息源` with「未知」fields, plus timestamp and delivery ID. Format then stays identical whether or not a source exists.
3. **Make the input layer visible**: `describeAgentThreadMessageSource` should not silently return `undefined`; return `{ messageSource, missing }` or at minimum surface `warnings` shaped like the ones `/api/scan/agents` already returns.
4. **Converge the paths**: one assembly function for `createThread`, DSH create, and `send`.
5. **Sync the docs**: `docs/agent-thread-api-contracts.md` currently claims `list`/`read` return native session content; the implementations return session metadata only.

Rejected approach: returning 400 when the source is incomplete. External callers often genuinely cannot supply one, and refusing would make delivery unusable; writing「未知」matches real usage better.

## 6. Field completeness

Principle: **never require a source, but always carry as much known information as possible.** The envelope exists so an Agent can decide who sent this, when, and whether a reply is due, not to serve as an audit log. Fields should be complete without drowning the body.

### Fields present today

| Field | Origin | Always present |
| --- | --- | --- |
| Type | `messageSource.type` | Yes, when a source exists |
| Adapter | `messageSource.agentAdapter` | Yes, when a source exists |
| Role | `messageSource.agentType` | Optional; omitted when the value is `agent` |
| Session name | `messageSource.sessionName` | Yes, when a source exists (no fallback, see D3) |
| Session ID | `messageSource.sessionId` | Yes, when a source exists (no fallback, see D3) |
| Workspace | `messageSource.workspace` | Optional |
| Delivery ID | `envelope.deliveryId` | Optional |
| Delivery time | `envelope.sentAt` | Always, falls back to current time |
| Context blocks | `contextBlocks` | Optional, appended after the body |
| Control blocks | `controlBlocks` | Optional, carries reply parameters |

### Known information not yet in the envelope

| Information | Location | Recommendation |
| --- | --- | --- |
| Target adapter and thread | `agentAdapter`, `threadId` | Add; the Agent needs to confirm the message is addressed to it |
| Model and reasoning effort | `request.model`, `request.reasoningEffort` | Add; helps the Agent calibrate its own output |
| Sandbox | `request.sandbox` | Add; permission expectation should match the execution boundary |
| Reply policy | `responsePolicy`, `responseInstruction` | Already inside the control block; keep as is |
| Related request | `inReplyToRequestId` | Add; makes the reply chain traceable |
| Route | `routeName`, `routeId` | Present for `message_adapter` sources only; consider adding for agent sources |
| Role directory | `agentRolePath` | Keep out; the body already carries the relative path |

### Boundaries

- Credentials, tokens, private message bodies, and sensitive absolute paths never enter the envelope.
- Envelope fields stay single-line and length-capped so the body is not pushed out of view.
- New fields go through `optionalLine`; missing values render as「未知」or are omitted, never as `undefined`.

## 7. Acceptance

- `create` without `messageSource` still starts with `## 消息源`, fields show「未知」, and a timestamp is present.
- `agentAdapter` without `sessionId` produces a visible warning or `missing` field in the response.
- `create` with a full source matches the class A envelope field for field.
- Two consecutive deliveries to the same task keep the same envelope format and create no new task.
- Existing snapshot tests in `src/shared/rabiMessage.test.ts` stay green.

## Related documents

- [Agent session control API contract](agent-thread-api-contracts_en.md)
- [Rabi interfaces for Agents](rabi-agent-interfaces.md)
- [Standard Agent adapter requirements](agent-adapter-standard-requirements_en.md)
