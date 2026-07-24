<!-- docs-language-switch -->
<div align="center">
English | <a href="./safety-and-data.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Safety, replies, and data

RabiRoute separates what an Agent may execute from whether its result may write to an external system. A task approval is not permanent outbound authorization.

## Two permission boundaries

| Boundary | Controls | Decided by |
| --- | --- | --- |
| Desktop task permission | Commands, files, network, tools, sandbox | Target Codex/ChatGPT Desktop task |
| RabiRoute Action Gate | QQ, WeCom, RabiLink, and other output | Pipeline, reply context, adapter policy |

Desktop file-read approval does not permit sending that file to a group. QQ text output permission does not allow an arbitrary local-file upload.

## Outbox results

| Result | Meaning |
| --- | --- |
| `sent` | The requested output path completed; for an Agent-session target, it can mean the result stayed in that session |
| `draft` | Draft data was retained without completing an external send |
| `blocked` | Policy, payload type, or target denied the action |
| `failed` | An action was attempted, but the platform or connection failed |

There is no generic persistent Action Queue for approving external actions item by item in WebGUI. The Plans page's approval feedback only records user guidance on an Agent plan and notifies the Agent; it neither approves Outbox delivery nor advances the plan directly. `draft` is an output and audit result, not a complete pending-approval center.

<div class="screenshot-placeholder">
  <strong>Screenshot placeholder 14 | Input and output policy</strong>
  <span>Suggested frame: a NapCat or other adapter policy with input, output, payload types, and file roots visible.</span>
  <span>Callouts: separate gates, supported types, allowed file roots, Save to apply.</span>
</div>

## Source replies and proactive sends

For a source-bound reply, the Agent should use the injected `replyContext`. It carries the Route, adapter, and source target and reduces wrong-group or wrong-account sends.

A proactive send needs an explicit target. If the target is ambiguous, the payload is unsupported, or output policy is off, Outbox should return `blocked` instead of guessing.

## Local file uploads

For a NapCat group upload with local `filePath`, the resolved path must remain inside an `allowedFileRoots` directory. RabiRoute checks existence, real path, and ordinary-file type.

Public examples use placeholder directories. Do not publish personal directories, build-server paths, real filenames, or private release locations.

## Actions with real side effects

- Save writes local configuration and may synchronize or reload a Route.
- Start, Stop, and Restart change the Route process.
- Open NapCat may start an instance, select quick login, and repair OneBot settings.
- Manual trigger writes logs and delivers a real AgentPacket.
- Allowed Outbox actions send real content to external platforms.
- Delete removes Route configuration and is not a substitute for Stop.

Before acting, confirm the current Route, target platform, and unsaved-change state.

## Data locations

Common local data:

```text
data/Config.json
data/route/<configName>/adapterConfig.json
data/route/<configName>/*.jsonl
data/roles/<RoleId>/persona.md
data/roles/<RoleId>/personaConfig.json
data/roles/<RoleId>/plans/
data/roles/<RoleId>/memory/
```

Route configuration, message history, AgentPackets, Outbox, and runtime logs normally live under the Route. Persona text, rules, plans, memories, and skills live under the role.

## Never publish these values

- QQ accounts, group IDs, private messages, and unsanitized screenshots.
- Tokens, cookies, passwords, Bot Secrets, and WebUI keys.
- Real local usernames, private absolute paths, and release directories.
- Runtime `data/`, logs, recordings, transcripts, and attachments.
- Private context from handler tasks.

Keep field names, status, event order, and minimal error text. Replace identities and credentials with placeholders.

## Backup and migration

Stop related writes or close the Manager before migration, then back up required Route configurations and persona directories. Build output, `node_modules`, and all historical logs are not configuration essentials.

Read the changelog before starting a new version. Schema normalization can migrate old fields; a backup lets you compare the actual saved changes.

## Continue

- Diagnose output failure: [Operations, logs, and troubleshooting](operations-and-troubleshooting_en.md).
- Prepare a sanitized report: [FAQ and support](faq-and-support_en.md).
