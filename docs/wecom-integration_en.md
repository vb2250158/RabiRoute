<!-- docs-language-switch -->
<div align="center">
English | <a href="./wecom-integration.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# WeCom Integration

> Maturity: experimental. The smart-bot WebSocket adapter, normalization, health scan, and Outbox sender exist, but repeated receive/send acceptance still needs to be completed in a real WeCom tenant.

The integration targets group-chat bots. A gateway connects outward to the WeCom smart-bot WebSocket, records inbound messages, evaluates routes, and sends an `AgentPacket` to the selected handler. Replies return through RabiRoute Outbox to the source group or an explicit WeCom chat ID.

This is not the traditional WeCom custom-application HTTP callback flow. It uses `@wecom/aibot-node-sdk` and a long-lived WebSocket because RabiRoute needs a local resident message endpoint similar to NapCat.

## Data flow

```text
WeCom group
  -> WeCom smart-bot WebSocket
  -> RabiRoute wecom adapter
  -> wecom-messages.jsonl / wecom-adapter.log.jsonl
  -> forwarding / RouteDecision
  -> AgentPacket / replyContextJson
  -> handler adapter
  -> POST /api/agent/replies
  -> Outbox
  -> WeCom group
```

`wecom` and `napcat` are both message adapters:

- NapCat connects to RabiRoute's local WebSocket and receives replies through OneBot HTTP.
- The WeCom adapter connects outward to WeCom and sends through the same smart-bot SDK.
- WeCom currently focuses on group chats and reuses NapCat-like variables where possible.

## Configuration

```json
{
  "enabled": true,
  "messageAdapters": ["wecom", "heartbeat"],
  "messageAdapterPolicies": {
    "wecom": {
      "inputEnabled": true,
      "outputEnabled": true,
      "supportedOutputs": ["text", "image", "voice", "file"]
    }
  },
  "pipelinePreset": "wecom_chat",
  "pipeline": {
    "inputAdapter": "wecom",
    "outputAdapter": "wecom",
    "outputPipeline": "wecom",
    "promptOutputMode": "markdown",
    "preventFeedbackLoop": true,
    "replyToSource": true
  },
  "wecomBotId": "${WECOM_BOT_ID}",
  "wecomBotSecret": "${WECOM_BOT_SECRET}",
  "wecomWsUrl": "${WECOM_WS_URL}",
  "codexThreadName": "WeCom message listener",
  "codexCwd": "C:/Path/To/Your/Project",
  "agentAdapters": ["codex"],
  "dataDir": "./data/route/wecom",
  "configName": "wecom",
  "agentRoleId": "Rabi",
  "rolesDir": "./data/roles"
}
```

The credentials may come from the route definition or the environment:

```text
WECOM_BOT_ID=<bot-id>
WECOM_BOT_SECRET=<bot-secret>
WECOM_WS_URL=<optional private/debug WebSocket URL>
```

Public examples must use placeholders. Never commit a real bot ID, secret, employee ID, internal chat ID, or conversation content.

## Fields and template variables

The adapter maps WeCom group data to the common routing vocabulary:

```text
{routeKind} {time} {targetType} {targetId} {messageTarget}
{groupId} {userId} {sender} {senderName}
{message} {rawMessage} {routeText} {messageId}
{repliedMessageId} {repliedMessage}
{botNickname} {routeProfileId} {routeProfileName}
{agentRoleId} {agentRolePath} {agentRoleDir}
{dataDir} {groupLogPath} {privateLogPath}
{replyApiUrl} {replyContextJson}
{inputAdapter} {outputAdapter} {outputPipeline} {replyToSource}
```

WeCom-specific values:

```text
{wecomReqId}
{wecomConversationId}
{wecomChatId}
{wecomSenderId}
{wecomMessageType}
```

Mapping rules:

- `groupId` prefers `chatId`, then `conversationId`.
- `userId` is the sender's WeCom user ID.
- `sender`/`senderName` uses the display name and falls back to `userId`.
- `messageId` prefers the WeCom message ID, then request ID, then a local generated ID.
- `messageTarget` is rendered as a WeCom group label for the handler.

The route kind is:

```text
wecom_message
```

Text, mixed, voice, image, and file messages are eligible for routing. The rule layer may use `regex` and `targetGroupId` just as it does for other message sources.

## Reply and proactive send

Handlers must not call the WeCom SDK directly. Use:

```http
POST /api/agent/replies
```

Reply to the source group:

```json
{
  "text": "Received. I will summarize it.",
  "replyContext": {
    "adapterType": "wecom",
    "routeKind": "wecom_message",
    "targetType": "group",
    "messageId": "wecom-msg-001",
    "groupId": "wrCHATID",
    "userId": "example-user",
    "wecomReqId": "REQ_ID",
    "wecomConversationId": "CONVERSATION_ID",
    "wecomChatId": "wrCHATID",
    "outputAdapter": "wecom",
    "outputPipeline": "wecom",
    "replyToSource": true
  }
}
```

Proactive group send:

```json
{
  "text": "Project reminder: please report blockers before 18:00.",
  "targetType": "group",
  "groupId": "wrCHATID",
  "adapterType": "wecom",
  "replyContext": {
    "outputAdapter": "wecom",
    "outputPipeline": "wecom",
    "replyToSource": false
  }
}
```

Outbox checks `messageAdapterPolicies.wecom.outputEnabled`, `supportedOutputs`, credentials, and an explicit/current group target. It returns `blocked` or `failed` when policy or delivery prevents sending and records the result in `outbox-adapter.log.jsonl`.

## Logs and health

```text
data/route/<configName>/wecom-messages.jsonl
data/route/<configName>/wecom-adapter.log.jsonl
data/route/<configName>/outbox-adapter.log.jsonl
data/route/<configName>/gateway-status.json
```

`gateway-status.json` maintains `messageAdapters.wecom` fields such as `connected`, `authenticated`, `lastMessageAt`, `messageCount`, and `lastError`. The Manager scan reports this adapter as `experimental` and checks the SDK, credentials, authenticated WebSocket, and recent inbound messages.

## Implementation boundaries

- `wecom` is an independent adapter, not an alias for the generic webhook.
- The adapter translates protocol data, logs messages, and calls forwarding; it does not assemble handler prompts.
- `src/routing/agentPacket.ts` creates the prompt and `replyContextJson`.
- All outbound delivery goes through `src/outbox.ts`.
- Real tenant acceptance remains required before treating WeCom as verified.
