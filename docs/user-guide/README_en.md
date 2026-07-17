<!-- docs-language-switch -->
<div align="center">
English | <a href="./README.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# RabiRoute User Guide

This guide is for people who configure and operate RabiRoute through RibiWebGUI. It starts with the first screen and does not expect you to understand the code, schemas, or Agent internals.

> Applies to RabiRoute 0.1.x. The project is under active development. “Experimental” means an integration exists, but its external platform or real-device path still needs validation in your environment.

## Understand one thing first

RabiRoute is a message triage and dispatch layer. It receives messages, records events, chooses a route, adds context, and hands work to Codex or another handler. The handler does the actual answering, coding, and tool use.

In the interface, a **Route** is an independently controlled message-flow configuration:

```text
Message adapter -> matching rules -> persona and context -> Agent handler -> reply or draft
```

- A **message adapter** decides where messages enter, such as NapCat / QQ, Heartbeat, Webhook, or RabiLink.
- A **persona and its rules** decide which messages match and what instructions accompany them.
- An **Agent adapter** decides which handler, project directory, and task receive the message.
- **Log diagnostics** show where a message stopped.

## The best first-run path

To prove that the software works, start with Heartbeat and Codex. This path does not require a QQ login and is the shortest way to validate delivery.

1. Open Quick setup from the bottom of the sidebar.
2. Select Scheduled trigger as the message source.
3. Select Codex and bind a project directory and Desktop task.
4. Leave the persona empty for now, then save.
5. Open Log diagnostics, trigger one message, and confirm that the task receives it.

See [Run your first Route](first-route_en.md) for the full procedure. When you are ready for QQ, continue with [Routes and message adapters](routes-and-adapters_en.md).

<div class="screenshot-placeholder">
  <strong>Screenshot placeholder 01 | RibiWebGUI console overview</strong>
  <span>Suggested frame: the first-run desktop console with the sidebar, current Route, top connection status, core status cards, and Quick setup button visible.</span>
  <span>Call out: current Route, Manager connection, runtime state, Quick setup, Save configuration, and Log diagnostics.</span>
</div>

## Find a guide by goal

| What you want to do | Start here |
| --- | --- |
| Configure and verify the first delivery | [Run your first Route](first-route_en.md) |
| Understand navigation, states, and save notices | [Interface and status](interface-and-status_en.md) |
| Connect QQ, schedules, webhooks, or RabiLink | [Routes and message adapters](routes-and-adapters_en.md) |
| Bind Codex or another handler | [Agents, projects, and tasks](agents-and-sessions_en.md) |
| Configure personas, matching rules, and schedules | [Personas and message rules](personas-and-rules_en.md) |
| Diagnose or review missing messages and errors | [Operations, logs, and troubleshooting](operations-and-troubleshooting_en.md) |
| Understand reply permissions, drafts, and local data | [Safety, replies, and data](safety-and-data_en.md) |
| Check common questions or prepare a report | [FAQ and support](faq-and-support_en.md) |

## User guide versus developer documentation

This guide explains how to use the product and verify outcomes. It mentions files or technical boundaries only when they materially help with troubleshooting.

For adapter development, routing internals, or APIs, use the [project documentation index](../README_en.md). The [current capabilities and maturity](../current-capabilities_en.md) page is the source of truth for feature status.

## Reading conventions

- Paths, task names, rule names, tokens, and logs remain unchanged when the UI language changes.
- Save configuration writes local configuration; some changes also synchronize or restart the current Route.
- Manual trigger enters the real delivery path. It is not a side-effect-free preview.
- Outbound results can be `sent`, `draft`, `blocked`, or `failed`. There is no general WebGUI approval center yet.

## Next step

Continue with [Run your first Route](first-route_en.md). If you already have a running Route, jump to [Interface and status](interface-and-status_en.md) or [Operations, logs, and troubleshooting](operations-and-troubleshooting_en.md).
