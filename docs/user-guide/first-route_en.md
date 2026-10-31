<!-- docs-language-switch -->
<div align="center">
English | <a href="./first-route.md">简体中文</a> | <a href="./first-route_ja.md">日本語</a>
</div>
<!-- /docs-language-switch -->

# Run your first Route

This tutorial uses Scheduled trigger plus Codex for the shortest complete loop. It does not require QQ and is the safest first check of RabiRoute, RibiWebGUI, and the handler.

> Done means the current Route is saved, Delivery test returns an identifier, and the selected Codex/ChatGPT Desktop task receives that message. Scheduled rules are verified separately.

## Before you begin

- RabiRoute is installed and built, and the Manager can start.
- Codex/ChatGPT Desktop is open.
- You know the project directory used by the target task.
- The target task is accessible and has not been deleted.

In the Windows package, start RabiRoute Host and open WebGUI from the tray. In source mode, start Manager from the repository:

```powershell
npm run start:manager
```

Then open the `<managerBaseUrl>` printed by Manager. The operating system assigns this address; no fixed port is used.

## Step 1: create a role

Select **Create role** at the bottom of the sidebar, enter **Role name**, confirm the stable **Role ID**, and create it. You can also select an existing role at the top. This tutorial uses a local role; confirm that the source PC is this computer before creating it.

In **Role configuration**, open the second tab, **Message adapters**, and choose **Add message Route**. The new Route belongs to the selected role; you can add more Routes to that role later.

## Step 2: add a message input

In the message-input card, choose **Add message input**, then **Heartbeat**. This internal source requires no QQ login. Configure scheduled rules later under the role's automation and message rules.

![Earlier interface showing message inputs and Codex parameters](../../assets/screenshots/webgui-adapters-en.png)

The screenshot illustrates the input and Agent parameters. The current entry is **Role configuration → Message adapters**.

## Step 3: bind a Codex task and save

In the same page's **Agent handler** card, choose **Add Agent**, select Codex, and select it as **Primary Agent**. Expand its parameters:

1. Enter the target project's absolute path in **Working directory**.
2. Select an existing task in **Task name + last activity**. Selection adopts that task's workspace; verify it afterward.
3. To create a task, enter a new name. If no task matches, saving creates an empty task and binding. For the first check, you may simply select a task already open in Desktop.

RabiRoute stores the complete task ID. A display-name change or completed goal does not automatically create a replacement while the original ID remains valid. The original Codex/ChatGPT Desktop task executes deliveries; keep Desktop open.

Confirm that the Route is enabled, then choose **Save** in the top bar. Wait for the unsaved-change notice to clear. If saving remains unconfirmed, reconcile that save instead of creating another role or Route.

## Step 4: test one delivery

Open **Channel check** on the current message Route. Inspect the input and Agent states, then choose **Delivery test** on the Codex node. This sends a real message containing a test identifier.

Confirm the success result and open the same Desktop task to verify receipt of that test message. Saving configuration or reading channel status alone does not establish delivery.

## Step 5: verify the actual trigger rule

The delivery test verifies the current Route-to-Agent path. For scheduled operation, configure and save a rule under **Role configuration → Automation → Message rules**. In **Log Diagnostics**, manually trigger an existing `heartbeat` or `manual_trigger` rule, then verify receipt in the original Desktop task.

![Earlier log-diagnostics interface](../../assets/screenshots/webgui-diagnostics-en.png)

This screenshot uses a stopped sample without a real task binding. Use your current Route's actual state. If no rule is listed, configure one first; passing the delivery test does not establish that a scheduled rule has run.

## Verify success

1. The current Route is saved and Channel check identifies the selected Codex task.
2. Delivery test returns its identifier and the same Desktop task receives the matching message.
3. If scheduled rules are configured, also verify one manual trigger and receipt in the original task.

## First-failure checklist

| Symptom | Check first |
| --- | --- |
| Manager disconnected | Host `status --json` generation/instance/URL in the package, or this run's stdout URL in source mode |
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
