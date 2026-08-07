<!-- docs-language-switch -->
<div align="center">
English | <a href="./routing-and-personas.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Routing and Personas

> Status: current guide. Describes the actual boundary between routes, roles/personas, and handlers.

RabiRoute is a dispatcher. A route represents one deployable message path; a role/persona represents the reusable identity and policy context carried to a handler. The handler performs the real work.

## Route-owned data

`data/route/<configName>/adapterConfig.json` owns operational concerns:

- enabled state;
- message adapters and their input/output policies;
- ports and endpoint URLs;
- handler adapter, thread name, and cwd;
- pipeline selection;
- the `agentRoleId` binding;
- route-local runtime data and logs.

## Role-owned data

`data/roles/<RoleId>/` owns reusable role semantics:

- `persona.md` and growth material;
- optional `avatar.png` / `.jpg` / `.webp` / `.gif`, referenced by `personaConfig.json.avatar`;
- `personaConfig.json` notification rules, `speechTriggerKeywords`, and ordinary-endpoint `recentMessageLimits`; Heartbeat always omits history;
- `voice/voice-profile.json` as the only TTS model/voice/language/speed/instructions source;
- plans, recent memory, consolidated memory, and skills;
- role-panel timeline data.
- `conversation/current.jsonl` plus time-based archives for bidirectional endpoint evidence.

One role can serve several routes. Those Routes reuse the same role-owned rules, speech keywords, voice profile, and per-endpoint context budgets instead of copying role facts into Route configuration.

## Voice and context ownership

| Fact | Source of truth |
| --- | --- |
| Persona avatar | An image inside the role directory referenced by `personaConfig.json.avatar` |
| Hot versus keyword speech delivery | Route `adapterConfig.json.speechPushMode` |
| Persona names, common addresses, and wake phrases | Persona `personaConfig.json.speechTriggerKeywords` |
| Ordinary endpoint auto-context budgets (`0–200`, default `12`; `0` disables injection only; Heartbeat always omits history) | Persona `personaConfig.json.recentMessageLimits` |
| TTS model, voice, language, speed, and speaking instructions | Persona `voice/voice-profile.json` |
| Current bidirectional message evidence | Persona `conversation/current.jsonl` |
| Reusable person profiles | Host-wide RabiSpeech `output/speaker-profiles.json`; actual mappings remain explicit `sessionId + speakerLabel` bindings |

Hot delivery sends every completed ASR segment. Turning it off keeps recording every segment but wakes the Agent only after a persona-keyword match; an empty keyword list never falls back to hot. Matched ordinary endpoint messages go directly through Desktop `steer/start`. Heartbeat's busy skip remains a separate explicit exception.

## Persona avatars

After selecting a persona on the RibiWebGUI **Persona configuration** page, upload a PNG, JPEG, WebP, or GIF image up to 5 MB. Manager stores a content-addressed file such as `avatar-a1b2c3d4e5f6.webp`, then atomically switches `personaConfig.json.avatar`. The previous managed image is cleaned up only after both the new file and configuration succeed, so a failed replacement leaves the old avatar valid. Removing the avatar does not alter `persona.md`, rules, plans, memory, or voice configuration.

The avatar appears in persona selectors, the Route overview, speech persona selection, and the local role panel. Every surface falls back to the first character of the persona ID when no avatar is configured or the image cannot load. Manager accepts only a simple image filename inside the role directory and does not allow avatar paths to escape that directory. Upload and removal fail closed when `personaConfig.json` is malformed instead of overwriting it with an empty configuration.

## Handler boundary

A role is not a handler process. Codex, Copilot CLI, AstrBot, and Marvis are handler adapters with different maturity levels. The route selects a handler and supplies an `AgentPacket`; the role supplies identity, context, and decision guidance.

Do not place NapCat connection logic into the persona, or make an Agent adapter define what counts as a route.

## How personas contact each other

Use **persona** as the public term for a reusable identity, behavior, and memory owner. Existing `roleId`, `/api/roles/*`, and `data/roles/` names remain compatibility internals and are not migrated by this feature.

An Agent may query `/api/personas?addressable=true` and then explicitly deliver to another persona through one of its enabled Routes. The sender is not a free request-body claim: Manager verifies the capability supplied by the current AgentPacket and bound to both its Route and persona. Directory responses contain display names and Route reachability, never persona bodies, local paths, or capabilities.

This is one-way delivery, not an automatically created two-way chat. The target persona's ordinary reply stays in its role panel. To answer the source, it must explicitly deliver back, reuse the conversation ID, reference the received message, and increment the hop count. A stable `deliveryId` prevents retries from creating duplicate work. Self-delivery, more than eight hops, or an ambiguous target Route is rejected.

## Persona routing templates

Templates should add decision guidance, not reconstruct the entire event. RabiRoute already injects event fields, role/log paths, recent context, role-knowledge indexes, and reply instructions.

The gateway supplies a default response expectation from structural evidence such as a DM, direct mention, direct reply, reply chain, or ambient group message. It does not write the answer for the Agent. The Agent still uses context to choose the content and the limited silence exceptions, while the persona template can further constrain tone, length, and channel behavior.

Explicit DMs, direct mentions, and direct replies should normally receive a visible acknowledgement. Even when no plan is created or implementation is deferred, the role should state what it understood, who acts next, and what condition resumes the work. Pure closing phrases, emoji, duplicate messages, or a complete answer from another member may remain record-only.

A companionship-oriented supplement may say:

```text
Respond only when the message genuinely calls for this role. Preserve the role's tone and relationship. Keep a group-chat response natural and concise. Return any external reply through the injected RabiRoute reply API.
```

A work/PM-oriented supplement may say:

```text
Classify the message as information, question, task, risk, or decision. Identify the owner, evidence, blocker, and next action. Update a focused plan or recent memory only when the message changes durable context. Use the reply API for user-facing chat output.
```

Proactive does not mean replying to every ambient group message. Respond when a message assigns action, corrects direction, reports risk, or continues a commitment previously made by the role. For longer work, acknowledge the request and next step first, then update only on material progress, risk, waiting conditions, or decisions.

## Rule-selection guidance

- Use `direct_at`, `direct_reply`, or `private` for explicit conversation with the role.
- Use `group_message` with a narrow `regex` for ambient group triage.
- Use `heartbeat` and `manual_trigger` for scheduled or explicit internal events.
- Use `voice_transcript`, `wecom_message`, `role_panel_message`, or `rabilink` only for the matching endpoint.
- Keep external-action authorization in pipeline/message-adapter policy, not in conversational wording alone.

Rules should prefer narrow evidence over a broad catch-all regex. When several rules match, RabiRoute produces packets according to the current forwarding behavior; avoid overlapping templates that cause duplicate work.

## Growth files

A role may maintain its own public/local role files when authorized. If a workflow updates role semantics, back up the old file under the role's `old/` directory before replacement. Runtime-semantic files are not translated mechanically because changing their language can change behavior.

## Reusable speech skills

- `skills/rabiroute-voice-workstation/SKILL.md` covers RabiPC capture, TTS/ASR, hot versus keyword delivery, records, speaker bindings, and runtime validation.
- `skills/character-tts-dialogue/SKILL.md` covers character-faithful replies for delivered speech turns and the required Outbox return contract.

See [Routing Configuration](routing-configuration_en.md) for schema and template variables and [Agent Context Injection](agent-context-injection_en.md) for the generated wrapper.
