<!-- docs-language-switch -->
<div align="center">
English | <a href="./first-route.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Run your first Route

This tutorial uses Scheduled trigger plus Codex for the shortest complete loop. It does not require QQ and is the safest first check of RabiRoute, RibiWebGUI, and the handler.

> Done means Log Diagnostics shows no obvious break, a manual trigger succeeds, and the selected Codex/ChatGPT Desktop task receives a RabiRoute message.

## Before you begin

- RabiRoute is installed and built, and the Manager can start.
- Codex/ChatGPT Desktop is open.
- You know the project directory used by the target task.
- The target task is accessible and has not been deleted.

If the Manager is not running, start it from the repository:

```powershell
npm run start:manager
```

Then open `http://127.0.0.1:8790/`.

## Step 1: open Quick setup

Select **Quick setup** at the bottom of the sidebar. RibiWebGUI also opens this wizard automatically when no Route exists.

Under **Select a message source**, choose **Scheduled trigger**. Do not add QQ, Webhook, or experimental adapters yet; the first run should test one short path.

<div class="screenshot-placeholder">
  <strong>Screenshot placeholder 02 | Quick setup: message source</strong>
  <span>Suggested frame: step one with Scheduled trigger selected and the three-step progress indicator visible.</span>
  <span>Callouts: Scheduled trigger, skip heartbeat while task is busy, Next.</span>
</div>

## Step 2: bind a Codex task

Under **Bind an Agent handler**, choose **Codex Agent**. Its scan should report **Verified**. This describes the implemented project path; Desktop is still required at runtime.

Complete these fields:

1. Select the target task's workspace under **Project directory**. Enter an absolute path if no candidate appears.
2. Select an existing item under **Task name and last activity**.
3. To create a task, enter a new name. Saving creates only the empty task and binding.

RabiRoute stores the complete task ID. A Desktop rename or completed goal does not create a duplicate while the ID and workspace remain valid.

<div class="screenshot-placeholder">
  <strong>Screenshot placeholder 03 | Quick setup: bind Codex</strong>
  <span>Suggested frame: Codex selected with scan status, project directory, and task selector visible.</span>
  <span>Callouts: Verified, project directory, task name and activity time, Rescan.</span>
</div>

## Step 3: confirm the persona

Use an existing example persona or leave the field empty. A persona-free Route receives basic rules; configure a persona later when you need role-specific behavior.

Select **Save configuration**. Saving writes local Route configuration and may start or reload the current Route.

## Step 4: check runtime status

Return to **Console** and confirm:

- The top bar says `Manager connected`.
- The current Route is enabled or running.
- The current path includes Scheduled trigger and Codex.
- The unsaved-changes notice is gone.

If an enabled Route is stopped, open **Log Diagnostics** and select **Start** or **Restart**.

## Step 5: trigger one delivery

Open **Log Diagnostics**. Under **Manual trigger**, find a `heartbeat` or `manual_trigger` rule and select **Trigger**.

A manual trigger enters the real delivery path. It is not a preview: it writes runtime records and performs a real handler delivery.

<div class="screenshot-placeholder">
  <strong>Screenshot placeholder 04 | First successful delivery</strong>
  <span>Suggested frame: diagnosis summary, runtime, Codex Desktop task, and manual-trigger result together.</span>
  <span>Callouts: Path healthy, Codex Desktop IPC, last success, trigger succeeded.</span>
</div>

## Verify success

All four checks should pass:

1. Diagnosis Summary shows no obvious break.
2. The manual trigger reports success.
3. The Codex area shows the target task and a recent success time.
4. The same Desktop task contains the routed message.

`Configuration saved` alone does not prove delivery. Opening Desktop alone does not prove that the message reached the selected task.

## First-failure checklist

| Symptom | Check first |
| --- | --- |
| Manager disconnected | The Manager process and `127.0.0.1:8790` |
| Enabled Route is stopped | Start/Restart and recent logs in Log Diagnostics |
| No triggerable rule | A `heartbeat` or `manual_trigger` rule in Persona |
| Codex is unbound | Workspace, task selection, and rescan results |
| `no-client-found` | Desktop is open and can load the target task |
| Trigger succeeds but no task message | Delivery channel, task ID, workspace, and recent logs |

For the full sequence, see [Operations, logs, and troubleshooting](operations-and-troubleshooting_en.md).

## Next steps

- Add QQ: [Routes and message adapters](routes-and-adapters_en.md).
- Bind messages to the correct project task: [Agents, projects, and tasks](agents-and-sessions_en.md).
- Configure group, private, or scheduled rules: [Personas and message rules](personas-and-rules_en.md).
