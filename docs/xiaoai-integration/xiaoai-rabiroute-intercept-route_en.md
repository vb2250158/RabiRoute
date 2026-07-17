<!-- docs-language-switch -->
<div align="center">
English | <a href="./xiaoai-rabiroute-intercept-route.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# XiaoAI Speaker Interception Route

> Status: experimental/design path. RabiRoute has named XiaoAI/webhook-like configuration entries, but the complete interception bridge, Tool Gateway, and device-control loop described here are not verified current capabilities.

## Core conclusion

Do not design RabiRoute as firmware or a replacement operating system for a XiaoAI speaker. The stable boundary is:

```text
XiaoAI entry bridge
  -> XiaoAI/Webhook adapter
  -> RabiRoute interception policy
  -> handler
  -> RabiRoute external-action gate
  -> Home Assistant / Mijia / BroadLink / ESPHome / local service
```

Speaker-specific open-source projects are optional bridges, not RabiRoute core dependencies.

## Bridge options

### Account/service-side bridges such as `xiaogpt`

- No speaker firmware modification.
- Can observe/answer through Xiaomi service/account behavior.
- Depends on unofficial compatibility, account state, and upstream changes.
- Must be treated as experimental and isolated behind an adapter.

### Patched/rooted speaker projects such as `open-xiaoai`

- Deeper local control on a limited device set.
- Higher operational and security risk.
- Several related projects are archived or no longer maintained.
- Suitable for research, not a mandatory public integration path.

### Home Assistant / Xiaomi Home

- Best for device control rather than intercepting every XiaoAI conversation.
- Lets RabiRoute call explicit device entities/services after the handler decides.
- Does not automatically provide the speaker's recognized text or conversational reply channel.

Relevant references:

- [idootop/open-xiaoai](https://github.com/idootop/open-xiaoai)
- [yihong0618/xiaogpt](https://github.com/yihong0618/xiaogpt)
- [XiaoMi/ha_xiaomi_home](https://github.com/XiaoMi/ha_xiaomi_home)
- [hass-xiaomi-miot](https://github.com/al-one/hass-xiaomi-miot)

## Interception policy

The bridge should normalize speaker text into a named XiaoAI event. RabiRoute then decides:

- pass through to normal XiaoAI behavior;
- route to a handler;
- ask for clarification;
- create an internal record only;
- request a whitelisted device action;
- return a reply through the bridge when that bridge supports it.

Interception must be narrow and explainable. Use route kind, source/device identity, explicit prefixes/wake phrases, target area, and focused regex/intent rules. Avoid hijacking ordinary household commands by default.

## Recommended MVP

1. Choose one maintained bridge and one supported speaker/account environment.
2. POST normalized text events to the named XiaoAI adapter endpoint.
3. Record input and route decisions without device actions first.
4. Add a narrow explicit trigger that sends an `AgentPacket` to Codex Desktop.
5. Return a text reply only after the bridge's real reply behavior is verified.
6. Add one read-only Home Assistant query.
7. Add one whitelisted low-risk device command behind explicit confirmation.
8. Measure duplicate events, latency, pass-through behavior, and recovery after bridge/account failure.

## Tool Gateway boundary

The design may expose explicit operations such as:

```text
list devices
read entity state
run approved scene
send approved IR command
```

It must not expose arbitrary shell, unrestricted HTTP, raw Home Assistant service calls, or unvalidated device identifiers to a prompt.

Every action request should include:

- source event and user intent;
- target device/entity;
- operation and parameters;
- risk level and confirmation requirement;
- idempotency/audit ID;
- result or observable state check.

## Reply boundary

The handler should submit the response through RabiRoute, not call the bridge or speaker library directly. RabiRoute then applies the configured output path and policy. If the bridge cannot guarantee a speaker reply, report that limitation instead of pretending the message was spoken.

## Security and privacy

- Keep Xiaomi account cookies/tokens and speaker identifiers outside the repository.
- Do not log raw household audio or private transcripts by default.
- Separate conversational reply permission from device-control permission.
- Require confirmation for locks, doors, appliances, purchases, deletion, or other high-impact actions.
- Preserve ordinary XiaoAI behavior when RabiRoute or the bridge is unavailable.

## Current truth

This repository contains configuration and design support for a XiaoAI-style message endpoint, not a production-certified speaker integration. Any selected bridge, speaker model, account region, reply channel, and Home Assistant/device-control path must pass real environment acceptance before maturity can be raised.
