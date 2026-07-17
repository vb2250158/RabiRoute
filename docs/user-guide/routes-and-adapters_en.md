<!-- docs-language-switch -->
<div align="center">
English | <a href="./routes-and-adapters.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Routes and message adapters

A Route is an independently controlled message-flow configuration. It combines message sources, a handler, workspace, persona binding, and output intent.

```text
Message adapter -> Route rules -> persona and context -> Agent handler -> Outbox / reply
```

## When to create another Route

Separate Routes are useful when:

- messages come from different platforms or accounts;
- work must enter different projects or Desktop tasks;
- a different persona or rule set applies;
- output policy, payload types, or file roots differ;
- you need independent lifecycle and diagnostics.

Several Routes can reuse one persona. Do not duplicate a persona only because the message source changes.

## Adapter maturity

| Message adapter | Status | Good for | Additional dependency |
| --- | --- | --- | --- |
| Scheduled trigger | Verified | Periodic checks and first-run validation | No external account |
| Role panel | Verified | Tray and local role messages | Manager/tray entry |
| NapCat / OneBot | Verified | QQ groups and private messages | NapCat, QQNT, OneBot setup |
| WeCom | Experimental | WeCom groups | Bot ID, Secret, environment acceptance |
| Remote Agent | Experimental | Independent bridge devices | Remote bridge and password challenge |
| FenneNote / XiaoAI | Experimental | Speech transcripts | Matching bridge or device |
| RabiLink | Experimental | Relay, glasses, and proactive output | Relay setup and real-device acceptance |
| Generic Webhook | Experimental | POST from an unnamed system | External callback system |

Verified means the repository path, configuration, and contracts are complete. Accounts, networks, devices, and platform risk controls can still affect operation.

## Add a message adapter

Open **Message Adapters** and add an entry under **Message sources**. The catalog groups local desktop, real-time chat, remote devices, internal triggers, speech, and external interfaces.

Each adapter shows maturity, connection state, dependency checks, and its own settings. Stabilize one source before adding another.

<div class="screenshot-placeholder">
  <strong>Screenshot placeholder 07 | Message-adapter catalog</strong>
  <span>Suggested frame: the open catalog with groups, adapter names, maturity, and connection badges.</span>
  <span>Callouts: Verified, Experimental, connection state, Add.</span>
</div>

## Input and output are separate gates

Adapter policy distinguishes:

- **Receive messages**: whether this source may create RabiRoute events.
- **Allow reply/send**: whether an Agent may send through RabiRoute's Outbox.
- **Supported outputs**: text, image, voice, file, or a smaller set.
- **Allowed file roots**: local directories permitted for file upload.

Disabling input does not delete history. Disabling output does not prevent the handler from producing a result in its task; it blocks the platform send.

## Minimal QQ / NapCat setup

NapCat uses two connections:

- WebSocket Client sends QQ events to RabiRoute, commonly `ws://127.0.0.1:8789`.
- OneBot HTTP Server supports health and replies, commonly `http://127.0.0.1:3000`.

In the Route's NapCat panel, verify the instance, RabiRoute WS port, HTTP address, and WebUI address. Scans are read-only; start, login, and repair actions require an explicit click.

<div class="screenshot-placeholder">
  <strong>Screenshot placeholder 08 | NapCat instance and connection</strong>
  <span>Suggested frame: one configured QQ instance with its WS, HTTP, account state, and Open NapCat action.</span>
  <span>Callouts: account, WS port, HTTP address, login state, Scan, Open.</span>
</div>

RabiRoute does not store or bypass QQ passwords, CAPTCHA, device confirmation, or risk controls. Complete first login and exceptional verification in NapCat/QQNT.

See [Unattended NapCat and login stability](../napcat-unattended_en.md) for the recovery flow.

## Scheduled trigger

After enabling Scheduled trigger, add a `heartbeat` schedule in persona rules. Schedules can use intervals, daily times, or a one-off date and time.

**Skip heartbeat while task is busy** affects only heartbeat when the fixed Codex task is active. It does not discard QQ, private, or other real-time messages.

## Webhook and named adapters

Prefer a named adapter when one exists. It normally preserves more accurate status, logs, template values, and reply semantics.

Generic Webhook is for POST sources without a dedicated integration. Public configuration should use localhost, placeholder domains, and sanitized tokens.

For native Lingzhu agent, AIUI, and native app selection, see the [RabiLink glasses three-route comparison](../rabilink-glasses-route-comparison_en.md).

## Save and apply

After adding, removing, enabling, or editing an adapter, select **Save configuration**. The Manager may synchronize or reload the Route.

Then verify runtime state in **Log Diagnostics**. External systems also need platform-side checks such as NapCat WebSocket, WeCom authentication, or Relay presence.

## Continue

- Select a handler and task: [Agents, projects, and tasks](agents-and-sessions_en.md).
- Decide which messages match: [Personas and message rules](personas-and-rules_en.md).
- Input works but delivery fails: [Operations, logs, and troubleshooting](operations-and-troubleshooting_en.md).
