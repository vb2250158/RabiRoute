<!-- docs-language-switch -->
<div align="center">
English | <a href="./routes-and-adapters.md">简体中文</a> | <a href="./routes-and-adapters_ja.md">日本語</a>
</div>
<!-- /docs-language-switch -->

# Routes and message adapters

A Route is an independently controlled message-flow configuration. It combines message sources, a handler, workspace, persona binding, and output intent.

Manage Routes under Role configuration → Message adapters, the second tab after Profile. Select a persona first, then select or add one of its message Routes. New Routes reference the current persona and source PC automatically. There is no separate Route configuration sidebar item. Persona rules live only in persona configuration; endpoint connections and handling Agents remain in Route configuration, linked by persona ID and source PC without copying persona directories. Preview older configurations with the [upgrade script](../persona-message-config-upgrade_en.md) before applying changes.

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

Cross-persona delivery does not require another Route kind or message adapter. It selects a target from Manager's persona directory and reuses the target's existing built-in persona-message path. Both source and target Routes must be enabled.

## Choose inputs by category

Communication and smart devices are peer categories. Schedules, the role panel, and webhooks support desktop and automation tasks.

| Category | Message input | Status | Purpose and dependencies |
| --- | --- | --- | --- |
| Communication | QQ (NapCat / OneBot) | Verified | Group and direct messages; requires NapCat, QQNT, and OneBot setup. |
| Communication | Personal Weixin | Experimental prototype | iLink text input and replies; incoming media is recorded only. Long-running sessions and real-account stability remain unverified. |
| Communication | WeCom | Experimental | Bot group messages and replies; requires real Bot ID / Secret credentials. |
| Communication | Feishu | Local implementation accepted; real credentials pending | App event callbacks and text replies; requires app credentials, public HTTPS, and event subscriptions. |
| Smart devices | Xiaomi Home | Experimental | Home Assistant state, actions, and camera event clips; configure the connection in the endpoint's Setup panel. |
| Smart devices | RabiLink phones / glasses | Experimental | Speech, replies, and proactive delivery; requires Relay configuration and physical-device acceptance. |
| Smart devices | Smartwatches / bands | Experimental; selected Xiaomi device paths verified | Heart rate, sleep, and health events; metrics depend on the capture source. |
| Desktop & automation | Scheduled trigger | Verified | First delivery, scheduled work, and periodic checks without an external account. |
| Desktop & automation | Role panel | Verified | Tray, local persona messages, and authenticated cross-persona delivery without a network listener. |
| Desktop & automation | Generic webhook | Experimental | Receive POST requests from systems without a dedicated adapter; requires a reachable callback. |

Accept accounts, networks, and hardware in their own environments; see [current capabilities](../current-capabilities_en.md). FenneNote and the former XiaoAI message inputs are retired: remove their old entries and use Xiaomi Home for home devices where appropriate. Configure remote Agents as execution endpoints through [remote computer setup](../lan-rabi-agent-bootstrap_en.md), rather than adding them as message inputs.

## Add a message adapter

Open **Message Adapters** and add an entry under **Message sources**. Choose an input for communication, smart devices, or desktop automation, then open its configuration panel.

Each adapter shows maturity, connection state, dependency checks, and its own settings. Stabilize one source before adding another.

Configure the Home Assistant address, event monitor, device-control gate, and camera options inside the **Xiaomi Home** message endpoint. They do not appear again on the host-wide **Settings** page. An authorized LAN WebGUI can maintain this configuration. Enabled remote Agents with authenticated connections can use the same public deployment, device, and recording APIs as local callers. The device-control switch, version preconditions, and separate recording read token still apply; unauthenticated access is not admitted.

To inspect the complete delivery path for the current Route, select **Channel check** at the top of the page. The dialog uses three columns: **Message inputs → Manager → Agent handlers**. The left side lists added message inputs, the center shows the Manager state for the current Route, and the right side lists configured Agents with their primary or secondary role. Select a message node or **View settings** to return to its settings; **Check again** refreshes both message-input and Agent status.

Each Agent node provides **Delivery test**. Save the Route, then select the button to send a real message with a UUID test ID to that Agent’s configured session. The UI reports success only after the adapter confirms receipt. Codex additionally verifies that the ID appears in the target Desktop task. The test does not wait for an Agent answer and does not send to QQ, WeChat, or another external platform. Marvis currently supports manual copy/open handoff only, so it cannot run this test.

![Message Adapters showing the current Route state, message inputs, and primary Agent](../../assets/screenshots/webgui-adapters-en.png)

The documentation sample Route was paused for the screenshot, while NapCat and Scheduled trigger remain visible in its input list. Confirm the inputs and primary Agent before enabling a Route.

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

In the Route's NapCat panel, verify the instance, RabiRoute WS port, HTTP address, and WebUI address. Scans are read-only; start, login, and repair actions require an explicit click. Endpoint probes start concurrently under one scan deadline. A timed-out probe preserves partial results from other endpoints and is not interpreted as offline.

QQ/NapCat and personal Weixin have completely independent login states. QQ is marked usable only from a live OneBot connection and health result. A reachable NapCat WebUI proves only that the diagnostic/configuration surface is reachable; it does not prove that QQ is logged in or can send and receive. A logged-out personal-Weixin adapter affects only that adapter and never turns an online QQ or every message endpoint into an offline state.

RabiRoute does not store or bypass QQ passwords, CAPTCHA, device confirmation, or risk controls. Complete first login and exceptional verification in NapCat/QQNT.

See [Unattended NapCat and login stability](../napcat-unattended_en.md) for the recovery flow.

## Scheduled trigger

After enabling Scheduled trigger, add a `heartbeat` schedule in persona rules. Schedules can use intervals, daily times, or a one-off date and time.

While Codex Message Agent mode is off, **Skip heartbeat while task is busy** affects only heartbeat when the fixed Codex task is active. With Message Agent mode on, heartbeat goes immediately to an independent Message Agent and the busy-skip option is hidden. QQ, private, and other real-time messages are not discarded by this setting.

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
