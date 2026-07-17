<!-- docs-language-switch -->
<div align="center">
English | <a href="./operations-and-troubleshooting.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Operations, logs, and troubleshooting

Do not treat “no reply” as one indivisible problem. Follow the message path and identify whether the break is at the platform, rule, handler delivery, or output stage.

```text
Message adapter -> event record -> rule match -> AgentPacket -> handler -> Outbox / platform
```

## Start with Diagnosis Summary

Open **Log Diagnostics**. **Diagnosis Summary** places known connection and configuration breaks first.

`Path healthy` only means no known break was detected. If delivery still fails, continue through connection details and recent logs.

<div class="screenshot-placeholder">
  <strong>Screenshot placeholder 12 | Diagnosis and connections</strong>
  <span>Suggested frame: Diagnosis Summary, runtime, message connection, and Codex Desktop task cards.</span>
  <span>Callouts: checks, runtime, source, binding, last success, last error.</span>
</div>

## Locate the break with evidence

| Evidence | Meaning | Next check |
| --- | --- | --- |
| No message record | The event did not enter RabiRoute | Platform login, connection, port, input policy |
| Message record, no `agent-packets.jsonl` | Input worked but no rule matched | Persona, `configName`, Route kind, regex |
| AgentPacket exists, no Desktop message | Handler delivery failed | Task ID, workspace, Desktop IPC, last error |
| Desktop result, no platform reply | Output did not complete | Reply context, pipeline, output policy, Outbox log |
| Outbox is `blocked` | Policy or target denied output | Correct the target or permission; do not bypass the gate |
| Outbox is `failed` | A platform send was attempted and failed | Repair platform state, then retry explicitly |

Common runtime files live under `data/route/<configName>/`. Do not commit runtime JSONL, real messages, or account data.

## Manual-trigger effects

**Manual trigger** can execute `manual_trigger` or `heartbeat` rules to validate the rule-to-handler path.

It will:

- write manual-trigger and routing logs;
- construct a real AgentPacket;
- perform a real handler delivery;
- use the target task's own permissions during execution.

It does not simulate an external QQ event and is not a side-effect-free preview. Validate a group regex with a controlled real message or RouteDecision evidence.

## Read recent logs

**Recent logs** shows the current Route's latest gateway output. Find the newest time boundary and the first error in that run; do not let a historical startup error mislead you.

<div class="screenshot-placeholder">
  <strong>Screenshot placeholder 13 | Recent logs and time boundary</strong>
  <span>Suggested frame: one trigger's start, delivery, and result with clear timestamps.</span>
  <span>Callouts: current startup, first error, target Route, delivery protocol.</span>
</div>

After an upgrade, rebuild and restart the Manager and Route, then verify the startup directory and `dist/` timestamp. Historical logs can remain for audit but do not define current state.

## NapCat connected but no AgentPacket

First check for a new `group-messages.jsonl` or `private-messages.jsonl` record.

- No record: check QQ login, WebSocket Client, port, and input policy.
- Record exists: check persona `configName`, Route kind, target group, and regex.
- Forwarded message contains only an ID: check OneBot HTTP and `get_forward_msg`.

## NapCat receives but cannot send

Reachable OneBot HTTP does not prove that the QQ core can send. Check login, quick login, device verification, Windows time, and NapCat logs.

A failed Outbox attempt retains `failed` and draft data. There is no generic automatic retry queue; repair login, then retry intentionally to avoid duplicates.

## Codex receives nothing

Check in order:

1. Desktop is open and can enter the target task.
2. Agent scan sees that task and workspace.
3. The saved task ID exists and the workspace has not moved.
4. Log Diagnostics reports `desktop-ipc`.
5. A `no-client-found` wake-and-retry still fails.

Do not use fixed port 4510, `CODEX_APP_SERVER_WS_URL`, or a separate stdio Runtime for real delivery. They are not the current transport.

## When to restart

Restart when:

- a new build completed;
- an external port or connection changed;
- the Route child process exited;
- logs prove an old build is still running.

Save rule, persona, and form changes first. Restart is not Save, and repeated external-platform restarts without evidence hide the real break.

## Prepare a useful report

Collect only:

- RabiRoute version and startup method;
- operating system and Node.js version;
- Route message adapter and handler;
- reproduction steps and expected result;
- minimal logs after the current startup;
- sanitized status screenshots.

See [FAQ and support](faq-and-support_en.md) for a report template.
