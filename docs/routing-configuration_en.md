<!-- docs-language-switch -->
<div align="center">
English | <a href="./routing-configuration.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Routing Configuration

> Status: current guide. Checked against `personaConfig.json` loading, route kinds, pipelines, and current template values.

## File locations

Operational route configuration:

```text
data/route/<configName>/adapterConfig.json
```

Reusable role rules:

```text
data/roles/<RoleId>/personaConfig.json
```

The route points to the role with `agentRoleId`. The current persona file keeps root-level `notificationRules`, `speechTriggerKeywords`, and `recentMessageLimits`; it does not require a nested `configs` collection. Several Routes may reuse the same role-owned policy.

## `personaConfig.json`

A representative shape:

```json
{
  "recentMessageLimits": {
    "napcat": 100,
    "remoteAgent": 100,
    "heartbeat": 100,
    "rolePanel": 100,
    "speech": 100,
    "fennenote": 100,
    "xiaoai": 100,
    "rabilink": 100,
    "wearable": 100,
    "webhook": 100,
    "wecom": 100
  },
  "speechTriggerKeywords": ["Rabi", "assistant"],
  "notificationRules": [
    {
      "id": "main-direct",
      "name": "Direct messages",
      "enabled": true,
      "routeKinds": ["private", "direct_at", "direct_reply"],
      "regex": "",
      "targetGroupId": "",
      "template": "Keep the reply concise and return it through RabiRoute."
    }
  ]
}
```

Rules are evaluated inside one route profile. They do not select an arbitrary role or start an independent process. The active route already selected the role through `agentRoleId`.

## Route kinds

Current kinds include:

```text
private
group_message
direct_at
direct_reply
indirect_reply
heartbeat
manual_trigger
role_panel_message
voice_transcript
rabilink
wecom_message
wearable_health_alert
```

Use the narrowest kind that represents the source event. `group_message` is normally combined with `regex`; explicit mentions/replies use their dedicated kinds.

## Ordinary delivery and endpoint-specific exceptions

- Once an ordinary endpoint message matches a rule, it is delivered directly: `steer` the active Desktop turn or `start` an idle task.
- Heartbeat owns the separate `heartbeatSkipWhenAgentBusy` exception; it does not suppress ordinary messages.
- Speech owns Route `speechPushMode`: `hot` delivers every completed ASR segment, while `keyword` records all segments and delivers only after a persona `speechTriggerKeywords` match. An empty list never falls back to hot.
- Persona `recentMessageLimits` independently configures 11 endpoint budgets from `0` to `200`, with a schema default of `100`. Zero disables automatic injection only.

## Pipelines

`pipelinePreset` and an optional inline `pipeline` belong to `adapterConfig.json`, not the persona rule. They determine the source/output adapters, reply-to-source behavior, prompt-output mode, feedback-loop guard, and optional TTS settings.

The default compatibility pipeline retains output in the Agent session unless the reply carries a source context or explicit external target. See [Pipeline Presets](pipeline-presets_en.md).

## Regex matching

`regex` is matched against the route text produced for the event. Keep expressions understandable and testable. A blank regex means the rule does not require a keyword match.

Example:

```json
{
  "routeKinds": ["group_message"],
  "regex": "build failed|release blocker|please record",
  "template": "Triage the issue and identify evidence, owner, and next action."
}
```

Do not use an extremely broad ambient-group regex when a direct mention or dedicated endpoint can express the intent.

## Template rules

- Use real line breaks in WebUI text areas.
- Do not type visible `\n` sequences into a template.
- Let JSON serialization escape line breaks once when saving.
- Keep the template as a supplement; event data, role context, logs, and reply requirements are already injected.
- Never put credentials, cookies, tokens, private chat content, or machine-specific secrets in a public template.

## Common template values

```text
{routeKind} {time} {targetType} {targetId} {messageTarget}
{now} {currentTime} {currentDate} {currentClock} {currentIsoTime}
{currentTimestamp} {currentYear} {currentMonth} {currentDay}
{currentWeekday} {currentHour} {currentMinute} {currentSecond}
{groupId} {userId} {selfId} {sender} {senderName}
{message} {rawMessage} {routeText} {repliedRouteText} {messageId}
{repliedMessageId} {repliedMessage}
{wecomReqId} {wecomConversationId} {wecomChatId}
{wecomSenderId} {wecomMessageType}
{botNickname} {routeProfileId} {routeProfileName}
{agentRoleId} {agentRolePath} {agentRoleDir}
{dataDir} {groupLogPath} {privateLogPath} {heartbeatLogPath}
{manualTriggerLogPath} {rolePanelLogPath} {voiceTranscriptLogPath}
{triggerId} {triggerName} {heartbeatIntervalSeconds}
{recentMessages} {recentMessageLimit} {recentMessageEndpoint}
{recentConversationKey} {conversationCurrentPath}
{conversationArchiveDir} {conversationArchiveIndexPath}
{replyApiUrl} {replyContextJson}
{pipelinePreset} {inputAdapter} {outputAdapter} {outputPipeline}
{promptOutputMode} {replyToSource}
```

`time` is the event time. `now`/`currentTime` is the local render time.

Role-knowledge indexes are generated by the packet wrapper and are not independent template values. See [Agent Context Injection](agent-context-injection_en.md).
