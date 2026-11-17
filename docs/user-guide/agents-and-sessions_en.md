<!-- docs-language-switch -->
<div align="center">
English | <a href="./agents-and-sessions.md">简体中文</a> | <a href="./agents-and-sessions_ja.md">日本語</a>
</div>
<!-- /docs-language-switch -->

# Agents, projects, and tasks

## Read sessions and message history

Messages run from oldest to newest, with new messages at the bottom. A thin scrollbar stays inside the message pane. Loading earlier messages preserves the reading position, while the conversation list and details remain independently accessible.

Open a persona's **Message History** and select **Agent sessions**. Switch between configured Agents using the second-level tabs, then choose a session or task. Search, refresh and load more sessions from the list. The conversation shows user inputs and final replies.

The session list starts in a flat view. Each description previews its latest user input or final reply. Use the folder button above the list to switch to project folders. Each folder initially shows five sessions, with **Show more** for additional sessions. Project headings collapse or expand, and the browser remembers the selected view.

Codex main sessions appear on the left. Selecting one shows its working subagents in the **Subagents** panel on the right, using native parent-child relationships. Select a subagent to read its user inputs and final replies, then choose **Back to main session**. On narrow screens, open the roster with the **Subagents** information button.

The directory combines the persona's configured Routes and keeps each remote computer and Agent identity. Separate DSH service origins remain separate choices. Codex and DSH read paged history from their native owners. Other adapters supply their own history capability, and missing interfaces or connection failures show an error for that target. Switching Agents selects that Agent's tasks. Failed refreshes retain loaded content.

The message adapter decides where an event enters. The Agent adapter decides which handler receives it. The handler owns answers, code, tools, and private task state.

## Current handlers

| Handler | Status | Actual boundary |
| --- | --- | --- |
| Codex | Verified | Delivers through Desktop IPC to the selected Codex/ChatGPT Desktop task |
| Copilot CLI | Experimental | Invokes the local CLI with its own session name and workspace |
| AstrBot | Experimental | Binds a Dashboard/ChatUI project and session; needs environment acceptance |
| Marvis | Manual handoff | Writes a prompt, copies it, and opens the app; no reliable automatic send |

Maturity in the selector comes from the current scan. Installed does not mean authenticated, and authenticated does not mean bound to the correct task.

## Select the Primary Agent

A Route may retain local Codex, DSH, and multiple remote Codex targets together, but matched messages go to only one Primary Agent. Select the specific local or remote Agent above the handler list. Other project, task, and service settings remain saved without receiving default deliveries. Adding a remote target neither replaces a local card of the same provider nor changes the primary.

An older Route without a saved primary keeps its original first entry; an existing remote primary retains the same target. Removing the current primary requires an explicit new selection instead of automatically switching to local or another Agent. No Agent delivery occurs without a primary.

If Primary Agent delivery fails, RabiRoute records the failure and does not switch to another Agent. This prevents two handlers from replying or performing the same external action.

The primary is selected per Route, not globally for the application. When investigating why a message reached an Agent, first check its Route ID and then that Route's primary. With an independent message-processing Agent enabled, a message may first reach a processing session on the primary's provider; this does not change the primary or permit delivery to a different provider.

## Three requirements for Codex

The Codex path needs all three:

1. Codex/ChatGPT Desktop is running.
2. The Route stores the correct project workspace.
3. The Route binds the exact task ID and uses the project workspace for the next turn.

RabiRoute does not execute real messages through a hidden CLI, shared port, or fallback Runtime. Desktop owns the visible task where the message appears.

## Scan projects and tasks

Open **Message Adapters**, expand **Agent handler**, select Codex, and run Scan or Rescan.

The scan lists available workspaces and unarchived tasks. The selector shows task name and last activity time instead of exposing internal IDs for recognition.


## Select the workspace

The workspace is used to:

- validate that a saved task belongs to the expected project;
- distinguish same-named tasks;
- choose where a new task is created;
- prevent delivery to another repository's task.

Enter an absolute path when no candidate appears, then save. Do not publish private usernames or machine paths in examples, issues, or screenshots.

## Select an existing task

Prefer an existing item from the selector. RabiRoute stores its complete task ID; you may still choose the next-turn workspace independently of the task's saved default cwd.

While the ID remains valid and the requested workspace is allowed, these changes do not create a task:

- a Desktop title change;
- a temporarily stale local index title;
- a completed task goal;
- a rescan that observes the new title.

If the fixed target is archived, the next real delivery creates a new task and automatically persists the replacement binding. The message does not enter archived history and RabiRoute does not reuse another same-name task. If the target was deleted, moved, or belongs to another account, select a valid task and save again.

## Create a task

Enter a new name in the selector, then save. The project-pinned app-server only creates and names the empty task. Real prompts still go to the Desktop owner.

When several tasks share the exact name and workspace, RabiRoute automatically binds the one with the unique latest activity time. If the maximum time is tied or unavailable, use the selector's activity time and workspace to choose, or organize names in Desktop first. This ambiguous case never creates another task.

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
4. Is the requested workspace the project you intend to handle now?
5. Does the last error mention `no-client-found` or a missing task?

See [Operations, logs, and troubleshooting](operations-and-troubleshooting_en.md) for the full path.

## Continue

- Define role behavior: [Personas and message rules](personas-and-rules_en.md).
- Understand output and permission gates: [Safety, replies, and data](safety-and-data_en.md).
