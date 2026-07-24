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
| Persona avatar, text, rules, plans, memory, skills | Persona directory |
| Route served by a rule | Rule `configName` |

One persona can serve several Routes. Editing its text or rules affects every bound Route that matches the relevant `configName`.

## Configure a persona

Open **Rabi Persona** and select an existing role under **Persona binding**. The page shows the `persona.md` preview, Route variables, built-in rules, and message-template rules.

After selecting a persona, use the same configuration card to set or replace its avatar. PNG, JPEG, WebP, and GIF images up to 5 MB are supported. The avatar follows the persona into selectors, the Route overview, speech persona selection, and the local role panel; the first character of the persona ID is used as the fallback. Because the image belongs to the persona directory, it does not need to be uploaded again for each Route.

Use **Open persona configuration** to edit the full text. Do not mechanically translate runtime-semantic files; language and wording changes can change Agent behavior.

## Synchronize the current persona across PCs

After selecting a persona, **Multi-PC persona sync** lists other PCs using the same RabiLink application token. Automatic synchronization runs in the backend and does not require the page to remain open. A local persona-file change, peer availability change, or Relay reconnection triggers one manifest reconciliation. LAN is preferred, with restricted Relay transit only when direct access is unavailable. Unfinished scope is persisted, so disconnects and Manager restarts do not forget it; an offline target waits for a connection event instead of fixed-interval business queries.

The page shows automatic-reconciliation state, and **Sync current persona** runs it immediately. Results distinguish pull, push, already converged, LAN/Relay transport, and conflict counts. Two-sided ordinary-file edits or concurrent deletion versus editing never use last-writer-wins replacement. They enter **Human confirmation required**:

- **Keep local** retains the current file and tries to publish that decision back to the source PC.
- **Use remote / Accept remote deletion** explicitly accepts the remote content or deletion intent.
- **Manual merge** lets the local Agent submit reviewed content through the `use_merged` API.

Concurrent persona voice-relationship branches do not let the file-conflict dialog guess who is the user. Confirm them again under **Persona voiceprint classification** so a new relationship event explicitly converges the branch. Relay performs discovery and transit only; it stores no server-side master persona. Synchronization also does not replace independent backups or Git/SVN.

## Classify voiceprints for the current persona

After a persona is selected, **Persona voiceprint classification** shows the latest 24-hour classification coverage, speech attributed to the user, speech attributed to other people, unknown/conflicting segments, and relationships already stored by this persona. **This is me** is only the current persona's explicit interpretation of a voiceprint on its processing host. Neither RabiSpeech nor the RabiRoute host decides who a person is or assigns any voiceprint to the user by default.

For an unresolved voiceprint, choose:

- **This is me**: mark the current `sourceHostId + voiceprintId` relationship as the user according to this persona.
- **Another person**: explicitly mark it as not the user.
- **Clear decision**: retain the relationship event while removing the `isUser` conclusion, returning it to unknown.

The page requests only statistics, abbreviated voiceprints, duration, last-seen time, and relationships; it neither requests nor displays transcript text. New recordings, local relationship corrections, and multi-PC persona synchronization each trigger one event-driven refresh. Reconnecting the event stream performs one catch-up query instead of fixed-interval coverage polling. Relationships are ultimately appended to the persona's own `voice/voice-identities.jsonl` and merge with the persona folder as events. Multi-PC conflicts remain visible until a later explicit confirmation converges the branches.

On first use, an opaque voiceprint ID may be impossible to recognize. Select **Mark the next recording**, then speak one continuous sentence by yourself through the PC, phone, or glasses you want to classify, preferably in a quiet environment. When the next recording event completes, unresolved voiceprints newly observed during that attempt move to the front and receive an **Observed this time** marker. This only narrows the candidates: it starts no second recorder, performs no automatic identification, and never assigns the user merely because one candidate appeared. If other people spoke at the same time, confirm only a voiceprint you can identify confidently or capture again.

<div class="screenshot-placeholder">
  <strong>Screenshot placeholder 10 | Persona overview</strong>
  <span>Suggested frame: persona binding, persona preview, Route variables, and rule list together.</span>
  <span>Callouts: persona avatar, persona ID, preview, rule count, Open config, Add rule.</span>
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
