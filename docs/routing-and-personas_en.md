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
- `personaConfig.json` notification rules;
- plans, recent memory, consolidated memory, and skills;
- role-panel timeline data.

One role can serve several routes. Rules use `configName` to express route-specific behavior without duplicating the role.

## Handler boundary

A role is not a handler process. Codex, Copilot CLI, AstrBot, and Marvis are handler adapters with different maturity levels. The route selects a handler and supplies an `AgentPacket`; the role supplies identity, context, and decision guidance.

Do not place NapCat connection logic into the persona, or make an Agent adapter define what counts as a route.

## Persona routing templates

Templates should add decision guidance, not reconstruct the entire event. RabiRoute already injects event fields, role/log paths, recent context, role-knowledge indexes, and reply instructions.

A companionship-oriented supplement may say:

```text
Respond only when the message genuinely calls for this role. Preserve the role's tone and relationship. Keep a group-chat response natural and concise. Return any external reply through the injected RabiRoute reply API.
```

A work/PM-oriented supplement may say:

```text
Classify the message as information, question, task, risk, or decision. Identify the owner, evidence, blocker, and next action. Update a focused plan or recent memory only when the message changes durable context. Use the reply API for user-facing chat output.
```

## Rule-selection guidance

- Use `direct_at`, `direct_reply`, or `private` for explicit conversation with the role.
- Use `group_message` with a narrow `regex` for ambient group triage.
- Use `heartbeat` and `manual_trigger` for scheduled or explicit internal events.
- Use `voice_transcript`, `wecom_message`, `role_panel_message`, or `rabilink` only for the matching endpoint.
- Keep external-action authorization in pipeline/message-adapter policy, not in conversational wording alone.

Rules should prefer narrow evidence over a broad catch-all regex. When several rules match, RabiRoute produces packets according to the current forwarding behavior; avoid overlapping templates that cause duplicate work.

## Growth files

A role may maintain its own public/local role files when authorized. If a workflow updates role semantics, back up the old file under the role's `old/` directory before replacement. Runtime-semantic files are not translated mechanically because changing their language can change behavior.

See [Routing Configuration](routing-configuration_en.md) for schema and template variables and [Agent Context Injection](agent-context-injection_en.md) for the generated wrapper.
