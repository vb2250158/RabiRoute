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

The route points to the role with `agentRoleId`. The current persona file keeps root-level `automationRules`, `speechTriggerKeywords`, and `recentMessageLimits`; it does not require a nested `configs` collection. Legacy `notificationRules` remain readable and migrate into automation rules. Several Routes may reuse the same persona-owned policy.

## `personaConfig.json`

A representative shape:

```json
{
  "recentMessageLimits": {
    "napcat": 100,
    "remoteAgent": 100,
    "heartbeat": 0,
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
  "automationRules": [
    {
      "id": "main-direct",
      "name": "Direct messages",
      "enabled": true,
      "trigger": {
        "type": "message",
        "routeKinds": ["private", "direct_at", "direct_reply"],
        "regex": "",
        "targetGroupId": ""
      },
      "action": {
        "type": "deliver_agent",
        "template": "Keep the reply concise and return it through RabiRoute."
      }
    }
  ]
}
```

Each rule combines one trigger (`message` or `schedule`) and one action (`deliver_agent` or `run_script`). Rules stay inside the active Route profile and cannot select an arbitrary persona. Script actions require Route-local permission and remain inside the bound persona's `scripts/` directory.

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
plan_feedback
voice_transcript
rabilink
wecom_message
weixin_message
wearable_health_alert
```

`role_panel_message` is Manager's built-in persona-message kind. It serves both local role-panel input and authenticated cross-persona delivery; it is not a configurable network listener. Both entry points use one delivery service, which records `sent` only after handler acceptance and records `failed` on rejection. The built-in rule cannot be removed as an ordinary custom rule.

Use the narrowest kind that represents the source event. `group_message` is normally combined with `regex`; explicit mentions/replies use their dedicated kinds.

## Ordinary delivery, scheduled tasks, and endpoint-specific exceptions

- Once an ordinary endpoint message matches a rule, it is delivered directly: `steer` the active Desktop turn or `start` an idle task.
- Scheduled triggers never inject message history and do not enter conversational settling. Agent actions use the heartbeat compatibility event: with Codex Message Agent mode enabled they go immediately to an independent Message Agent, otherwise `heartbeatSkipWhenAgentBusy` may skip them while the fixed task is active. Script actions bypass Agent delivery and require `personaAutomationScriptsEnabled=true` on the local Route.
- `plan_feedback` is a Manager system event emitted only after the plan and Route are explicitly bound. It uses a dedicated built-in rule, neither reads nor writes chat history, and always exposes empty recent-message template values.
- Speech owns Route `speechPushMode`: `hot` delivers every completed ASR segment, while `keyword` records all segments and delivers only after a persona `speechTriggerKeywords` match. An empty list never falls back to hot.
- `weixin_message` is the experimental personal-Weixin OpenClaw/iLink source. Text exposes `weixinSessionId`, `weixinUserId`, and `weixinMessageType`; media is record-only, and replies require the source session's context token.
- Persona `recentMessageLimits` independently configures ordinary endpoint budgets from `0` to `200`, with a schema default of `12`. Zero disables automatic injection only. Heartbeat and `plan_feedback` have no adjustable budget and always omit history.

## Pipelines

`pipelinePreset` and an optional inline `pipeline` belong to `adapterConfig.json`, not the persona rule. They determine the source/output adapters, reply-to-source behavior, prompt-output mode, feedback-loop guard, and optional TTS settings.

The default compatibility pipeline retains output in the Agent session unless the reply carries a source context or explicit external target. See [Pipeline Presets](pipeline-presets_en.md).

## Regex matching

`regex` is matched against the route text produced for the event. Keep expressions understandable and testable. A blank regex means the rule does not require a keyword match.

Message-to-Agent example:

```json
{
  "trigger": {
    "type": "message",
    "routeKinds": ["group_message"],
    "regex": "build failed|release blocker|please record"
  },
  "action": {
    "type": "deliver_agent",
    "template": "Triage the issue and identify evidence, owner, and next action."
  }
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
{sendApiUrl} {sendRequestJson} {replyContextJson}
{pipelinePreset} {inputAdapter} {outputAdapter} {outputPipeline}
{promptOutputMode} {replyToSource}
```

`time` is the event time. `now`/`currentTime` is the local render time.

Role-knowledge indexes are generated by the packet wrapper and are not independent template values. See [Agent Context Injection](agent-context-injection_en.md).
