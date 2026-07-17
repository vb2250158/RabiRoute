<!-- docs-language-switch -->
<div align="center">
English | <a href="./personas-and-rules.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Personas and message rules

A Route decides how messages enter and which handler receives them. A persona supplies identity, background, and decision guidance. They are stored separately and can be reused independently.

## Route and persona boundaries

| Content | Owner |
| --- | --- |
| Sources, ports, handler, workspace, pipeline | Route |
| Selected persona | Route `agentRoleId` |
| Persona text, rules, plans, memory, skills | Persona directory |
| Route served by a rule | Rule `configName` |

One persona can serve several Routes. Editing its text or rules affects every bound Route that matches the relevant `configName`.

## Configure a persona

Open **Rabi Persona** and select an existing role under **Persona binding**. The page shows the `persona.md` preview, Route variables, built-in rules, and message-template rules.

Use **Open persona configuration** to edit the full text. Do not mechanically translate runtime-semantic files; language and wording changes can change Agent behavior.

<div class="screenshot-placeholder">
  <strong>Screenshot placeholder 10 | Persona overview</strong>
  <span>Suggested frame: persona binding, persona preview, Route variables, and rule list together.</span>
  <span>Callouts: persona ID, preview, rule count, Open config, Add rule.</span>
</div>

## Rule anatomy

Common fields are:

- **Rule name**: a user-facing purpose.
- **Route kinds**: event categories accepted by the rule.
- **Message regex**: a narrower text match for groups or messages.
- **Target group**: optional group restriction.
- **Schedules**: timer creation for heartbeat rules.
- **Agent wrapper template**: decision guidance for this situation.

<div class="screenshot-placeholder">
  <strong>Screenshot placeholder 11 | Edit a message rule</strong>
  <span>Suggested frame: the rule dialog with Route kinds, regex, schedule, and template editor.</span>
  <span>Callouts: Enable, Route kinds, Regex, Schedule, Agent wrapper template.</span>
</div>

## Common Route kinds

| Kind | Use it for |
| --- | --- |
| `private` | QQ private messages |
| `direct_at` | A direct group mention |
| `direct_reply` | A direct reply to the account or role conversation |
| `indirect_reply` | Wider reply-chain observation; potentially noisy |
| `group_message` | Ambient group messages, normally with a narrow regex |
| `heartbeat` | Schedules and manual validation |
| `manual_trigger` | Explicit UI or API triggers only |
| `role_panel_message` | Built-in role-panel messages |
| `voice_transcript` | FenneNote, XiaoAI, and related transcripts |
| `wecom_message` | WeCom group events |
| `rabilink` | RabiLink events |

The interface groups available kinds by adapters on the current Route. Selecting no kind may match every entry and is rarely a safe default.

## Keep regex focused

Do not forward every ambient group message with an empty regex. Begin with terms that express the intended work, for example:

```text
requirement|error|build failed|reminder|please record
```

Regex decides whether the rule matches, not whether the Agent must reply. The persona guidance should still distinguish new facts, tasks, risks, acknowledgements, and polite responses.

## Schedules

A `heartbeat` rule supports:

- recurring intervals;
- a daily time;
- a one-off date and time.

A heartbeat rule without a schedule can still be triggered from Log Diagnostics. An enabled schedule creates real events and delivery records.

## What belongs in the template

Use the template for decision guidance, not to reconstruct the whole event. RabiRoute already injects the event, recent context, persona and log paths, knowledge indexes, and reply context.

A concise work template can say:

```text
Classify this as information, question, task, risk, or decision.
Act only when facts, blockers, or next actions changed.
Use the injected RabiRoute reply interface for external output.
```

Conversational wording alone cannot grant send permission. Pipeline and message-adapter policy still gate real output.

## Save and validate

Close the rule dialog, then select **Save configuration**. The change applies to the next message or schedule event.

The current WebGUI has no side-effect-free RouteDecision or AgentPacket preview. Use manual trigger for validation only when you intend to enter the real delivery path.

## Continue

- Validate rules and delivery: [Operations, logs, and troubleshooting](operations-and-troubleshooting_en.md).
- Understand reply permission: [Safety, replies, and data](safety-and-data_en.md).
