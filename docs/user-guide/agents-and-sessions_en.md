<!-- docs-language-switch -->
<div align="center">
English | <a href="./agents-and-sessions.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Agents, projects, and tasks

The message adapter decides where an event enters. The Agent adapter decides which handler receives it. The handler owns answers, code, tools, and private task state.

## Current handlers

| Handler | Status | Actual boundary |
| --- | --- | --- |
| Codex | Verified | Delivers through Desktop IPC to the selected Codex/ChatGPT Desktop task |
| Copilot CLI | Experimental | Invokes the local CLI with its own session name and workspace |
| AstrBot | Experimental | Binds a Dashboard/ChatUI project and session; needs environment acceptance |
| Marvis | Manual handoff | Writes a prompt, copies it, and opens the app; no reliable automatic send |

Maturity in the selector comes from the current scan. Installed does not mean authenticated, and authenticated does not mean bound to the correct task.

## Three requirements for Codex

The Codex path needs all three:

1. Codex/ChatGPT Desktop is running.
2. The Route stores the correct project workspace.
3. The Route binds the exact task ID from that workspace.

RabiRoute does not execute real messages through a hidden CLI, shared port, or fallback Runtime. Desktop owns the visible task where the message appears.

## Scan projects and tasks

Open **Message Adapters**, expand **Agent handler**, select Codex, and run Scan or Rescan.

The scan lists available workspaces and unarchived tasks. The selector shows task name and last activity time instead of exposing internal IDs for recognition.

<div class="screenshot-placeholder">
  <strong>Screenshot placeholder 09 | Codex scan and task binding</strong>
  <span>Suggested frame: expanded Codex card with environment status, maturity, workspace, and task selector.</span>
  <span>Callouts: Verified, Desktop status, workspace, task and activity time, Rescan.</span>
</div>

## Select the workspace

The workspace is used to:

- validate that a saved task belongs to the expected project;
- distinguish same-named tasks;
- choose where a new task is created;
- prevent delivery to another repository's task.

Enter an absolute path when no candidate appears, then save. Do not publish private usernames or machine paths in examples, issues, or screenshots.

## Select an existing task

Prefer an existing item from the selector. RabiRoute stores its complete task ID and adopts the task's actual workspace.

While the ID and workspace remain valid, these changes do not create a task:

- a Desktop title change;
- a temporarily stale local index title;
- a completed task goal;
- a rescan that observes the new title.

If the task was deleted, archived, moved, or belongs to another account, select a valid task and save again.

## Create a task

Enter a new name in the selector, then save. The project-pinned app-server only creates and names the empty task. Real prompts still go to the Desktop owner.

Do not guess when several tasks share a name. Use last activity and workspace, or organize names in Desktop first.

## Automatic persona initialization

If **Initialize task automatically** is available, it first saves the stable binding and then sends persona material through the formal AgentPacket path to the same Desktop task.

Initialization failure does not create a second task. Repair the binding or Desktop state before retrying.

## Models, tools, and approvals

The target Desktop task owns its model, tools, sandbox, file access, and network approval. The compatibility `agentModel` field does not override them.

Desktop command approval authorizes Agent execution only. It does not authorize writes to QQ, documents, devices, or external APIs; RabiRoute Outbox policy still gates those actions.

## No handler delivery

Check in order:

1. Does `agent-packets.jsonl` contain the delivery? If not, inspect rules first.
2. Does Log Diagnostics report Codex Desktop IPC?
3. Is Desktop open and able to enter the task?
4. Do the workspace and task match?
5. Does the last error mention `no-client-found`, missing task, or workspace conflict?

See [Operations, logs, and troubleshooting](operations-and-troubleshooting_en.md) for the full path.

## Continue

- Define role behavior: [Personas and message rules](personas-and-rules_en.md).
- Understand output and permission gates: [Safety, replies, and data](safety-and-data_en.md).
