<!-- docs-language-switch -->
<div align="center">
English | <a href="./antigravity-agent-adapter-plan.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Antigravity as an Agent endpoint

This document records how Antigravity is integrated into RabiRoute with the same capabilities as the Codex endpoint. Every fact below comes from read-only probing on a live machine or from the shipped implementation; nothing is inferred.

## 1. Goals and scope

Let RabiRoute deliver messages into a local Antigravity conversation and reuse the same managed capabilities as Codex:

- Message delivery (the single real message path)
- Delivery receipt recovery
- Conversation discovery and workspace enumeration
- Plan assistant session binding
- Lifecycle hook injection and event reporting

Out of scope: Antigravity model-selection policy, desktop UI changes, and anything that requires modifying the host binaries.

## 2. Gate zero: the user-observable contract

From a user's point of view, the integration is done when:

1. Choosing Antigravity as the primary Agent in route settings lists the existing local conversations and lets one be selected;
2. Sending a message makes it genuinely appear in that conversation, executed by that conversation's model and tools;
3. The name shown in the sidebar matches the name bound to the route;
4. After restarting RabiRoute the binding still holds, and continuing in the same conversation does not create a new one;
5. When a turn ends inside the Antigravity conversation, RabiRoute receives the event.

## 3. Owner and lifecycle

**The Antigravity desktop app owns the conversation.** RabiRoute is not the executor and does not start a fallback runtime. Once a message enters the conversation, that conversation runs it with its own model, tools, permissions and workspace state.

This determines three things:

- Delivery means handing over text to the owner; RabiRoute does not reason on its behalf;
- A binding must persist both the conversation id and the owner type, and continue in the same id after a restart;
- Hook observations are for reporting, not for replacing the owner's execution.

## 4. Product shape

Antigravity is a **desktop application**, not a command-line session. It also ships an `agy` CLI, but that CLI talks to the running desktop instance rather than starting a standalone session. Therefore:

- The transport is "the desktop instance's official programmatic interface", not a process pipe;
- The host must be running for there to be a delivery target;
- The manifest declares `host.required: true`.

## 5. Verified facts

All of the following were measured on a live machine.

### 5.1 The official programmatic interface `agy agentapi`

`agy` exposes three documented subcommands, and they are the only supported programmatic delivery entry point:

| Subcommand | Purpose | Identity written into the transcript |
|---|---|---|
| `new-conversation` | Create a conversation and post its first message | `source: USER_EXPLICIT` / `type: USER_INPUT` |
| `send-message <conversationId> <prompt>` | Append a message to a given conversation | `source: SYSTEM` / `type: SYSTEM_MESSAGE` |
| `get-conversation-metadata` | Read conversation metadata | — |

The property that matters: **the delivery target is an explicit argument**. That removes the entire class of risk where the destination depends on which conversation the UI happens to have open, and it is why this route was chosen over driving the renderer.

### 5.2 Environment variables agentapi requires

All three values belong to the **running instance**, so they are discovered at call time and need no user configuration:

| Variable | Source | Discovery |
|---|---|---|
| `ANTIGRAVITY_LS_ADDRESS` | the language server's gRPC port | `tasklist` finds the `language_server.exe` PID, then `netstat -ano` locates the `127.0.0.1:<port>` entry in `LISTENING` state for that PID |
| `ANTIGRAVITY_CSRF_TOKEN` | regenerated on every launch | read the **last** `--csrf_token <uuid>` in `%APPDATA%/Antigravity/logs/main.log` |
| `ANTIGRAVITY_PROJECT_ID` | fixed value | defaults to `outside-of-project` |

Two traps worth naming:

- **Ports differ by protocol.** The language server listens on both the UI port (7299, HTTPS) and a gRPC port. Connecting to the wrong one produces a misleading `http2: frame too large ... HTTP/1.1 header` error. The discovery logic excludes 7299 explicitly.
- **Failures still go to stdout.** On error, `agy agentapi` writes JSON to stdout and exits non-zero, so the caller must still parse stdout after catching the exception. Skipping that discards the only readable error.

### 5.3 The conversation index

The authoritative conversation list is a SQLite database:

```
~/.gemini/antigravity/conversation_summaries.db
```

This is what the desktop sidebar reads. Notes:

- `title` is the **only** display-name field; there is no separate user-named field;
- `last_user_input_step_index = -1` is a reliable "this conversation never received a user turn" signal, used to filter empty conversations;
- `app_data_dir` identifies the owner (the desktop app writes `antigravity`, the CLI writes `agy`). Without this filter, unrelated conversations show up in the list.

The read runs in a child process using Node's built-in `node:sqlite`, so no third-party SQLite dependency is introduced.

### 5.4 The transcript

Each conversation's per-step record lives at:

```
~/.gemini/antigravity/brain/<conversationId>/.system_generated/logs/transcript_full.jsonl
```

Hooks hand this path to the plugin directly, so both receipt recovery and "what was the last user input" can be read without scanning directories.

### 5.5 The shape of a conversation id (an important constraint)

**Antigravity conversation ids are plain UUIDs** (for example `a1e8f5ce-7e09-47d2-833f-ea27f532810b`), and **Codex task ids are also plain UUIDs**. The two formats are identical.

This yields a hard design constraint:

> Any code that needs to know which adapter owns a session must read the persisted `agentType`, and must **not** infer it from the id's shape.

Several earlier call sites used the form `agentType === "dsh" ? "dsh" : "codex"`, which silently relabelled an Antigravity session as Codex and delivered into the wrong conversation. This integration fixes all of them.

### 5.6 Hook events and registration

Antigravity exposes five lifecycle events:

| Event | Timing |
|---|---|
| `PreToolUse` | before a tool call |
| `PostToolUse` | after a tool call |
| `PreInvocation` | before a turn |
| `PostInvocation` | after a turn |
| `Stop` | when a conversation stops |

Three host behaviours must be respected:

1. **Registration requires two writes.** The plugin directory `~/.gemini/config/plugins/<name>/` must exist, **and** the plugin name must appear under `plugins.<name>.enabled` in `~/.gemini/config/config.json`. With only the former, the host ignores the plugin silently and no hook is ever invoked. Configuration is hot-loaded, so no restart is needed.
2. **`PreToolUse` returning `{}` means deny.** Allowing a tool requires returning an explicit object; an empty value is treated as a denial.
3. **A hook command's working directory is the plugin root.** Commands therefore use a relative path such as `node scripts/xxx.mjs`; the host does not go through a shell, so there is no shell expansion either.

The hook input carries `conversationId`, `transcriptPath`, `artifactDirectoryPath`, `initialNumSteps`, `modelName` and `workspacePaths`, plus `invocationNum`, which is always 0 and cannot be used as a counter.

Injected content uses the shape `injectSteps[].userMessage`. There is **no** `additionalContext`. Injected steps are recorded with `source: SYSTEM_SDK`, which keeps them distinguishable from real user turns.

## 6. The single real message path

```
RabiRoute route
  -> antigravityRuntime.deliver (serialized queue + state machine)
    -> antigravityBridge.deliverAntigravityPrompt
      -> resolve the live environment (gRPC address / CSRF / projectId)
        -> agy agentapi send-message | new-conversation
          -> the Antigravity desktop instance
```

Selection rule:

- A configured conversation id means `send-message` into that conversation;
- Without one, `new-conversation` starts a conversation and the returned id is recorded.

Both paths write adapter log records (`delivery_accepted` / `delivery_delivered` / `delivery_failed`), and a failure is recorded before it is thrown, so the fact of a failed delivery is never lost.

## 7. Identity and resolver contract

| Entry point | Identity written into the record |
|---|---|
| `agentapi send-message` | `source: SYSTEM` / `type: SYSTEM_MESSAGE` |
| `agentapi new-conversation` | `source: USER_EXPLICIT` / `type: USER_INPUT` |
| Hook `injectSteps` | `source: SYSTEM_SDK` / `type: USER_INPUT` |

On the RabiRoute side:

- Route binding uses `antigravityConversationId` (the routing key), `antigravityConversationName` (display name) and `antigravityCwd` (workspace);
- Delivery uses `conversationId` as the session routing key, so repeated deliveries never create a new conversation;
- Plan binding persists `PlanTaskBinding.agentType = "antigravity"` together with `sessionId`.

## 8. Capability level

The manifest declares `experimental` and grants all five managed capabilities:

| Capability | Status |
|---|---|
| `messageProcessingAgent` | supported |
| `planAssistantSessions` | supported |
| `memoryConsolidationAgent` | supported |
| `hooks` | supported |
| `deliveryReceiptRecovery` | supported |

Maturity is `experimental` rather than `verified` for exactly one reason: delivery depends on the host CLI's subcommand contract, which a host upgrade may change. It has nothing to do with whether the transport itself is reliable.

## 9. Code map

| # | Concern | Files |
|---|---|---|
| 1 | Capability declaration | `src/shared/agentAdapterCapabilities.ts` |
| 2 | Configuration model | `src/shared/gatewayConfigModel.ts`, `src/config.ts` |
| 3 | Conversation discovery | `src/antigravitySessionStore.ts` |
| 4 | Delivery transport | `src/antigravityBridge.ts` |
| 5 | Runtime | `src/antigravityRuntime.ts` |
| 6 | Receipt recovery | `src/antigravityReceipt.ts` |
| 7 | Adapter registration and scan | `src/agentAdapters/builtinAgentAdapters.ts`, `src/agentAdapters/antigravityManagerApi.ts`, `src/agentAdapters/managerApi.ts` |
| 8 | Hook package and installer | `plugins/rabi-antigravity-context/`, `src/agentAdapters/hookInstallation.ts` |
| 9 | Binding validation | `src/shared/agentInstance.ts` |
| 10 | Plan and thread generalization | `src/roleKnowledge.ts`, `src/manager/planAgentStatus.ts`, `src/manager/planTaskBindingDelivery.ts`, `src/manager/controlPlaneRoutes.ts`, `src/agentThreads.ts`, `src/forwarding.ts` |
| 11 | Removing adapter-name literals | `src/shared/codexPlanAssistantSessions.ts`, `src/shared/agentHookAutomation.ts`, `src/shared/codexSessionInitialization.ts`, and others |
| 12 | WebGUI | `ribiwebgui/src/pages/RouteConfigPage.vue`, `ribiwebgui/src/components/QuickSetupDialog.vue`, `ribiwebgui/src/stores/gatewayStore.ts`, `ribiwebgui/src/i18n/catalog.ts` |
| 13 | Documentation | this file and its Chinese counterpart |

### 9.1 On removing adapter-name literals

Integrating Antigravity exposed a structural defect: 21 places under `src/` wrote `"codex" | "dsh"` as a union type. The consequences fell into two classes:

- **Actively wrong behaviour**: `binding?.agentType === "dsh" ? "dsh" : "codex"` rewrote Antigravity as Codex, and `raw.agentType !== "codex" && raw.agentType !== "dsh"` rejected it outright. Both sit on the delivery-target path, so both were defects that had to be fixed.
- **Merely narrow typing**: adding an adapter produced no type error, only silent absence.

The fix is not to append `|| "antigravity"` at each site but to **derive the type from the capability manifest**:

```ts
export const planAssistantAgentTypes = agentAdapterTypes.filter(
  (type) => manifestsByAgentType[type].capabilities.managedTasks?.planAssistantSessions === true
);
export type PlanAssistantAgentType = typeof agentAdapterTypes[number];
```

The next adapter then becomes eligible by declaring a capability, instead of requiring all 21 sites to be edited again.

`normalizePlanBindingAgentType()` was added alongside it, separating "field absent" from "field present but unrecognized": the former falls back to the historical default, the latter raises an error. The old code silently fell back in both cases, which is precisely what delivered into the wrong conversation.

## 10. Acceptance test matrix

Automated tests (53 in `src/antigravity*.test.ts` plus 17 in the hook package, all passing):

| File | Count | Coverage |
|---|---|---|
| `src/antigravityBridge.test.ts` | 19 | CLI path precedence, CSRF reads the last entry, port discovery excludes the UI port and foreign PIDs, non-Windows rejection, the environment triple, arguments and env for both delivery paths, empty prompt and missing conversation id rejection, **parsing stdout despite a non-zero exit** |
| `src/antigravityReceipt.test.ts` | 15 | Path derivation, field parsing, skipping malformed lines, receipt match, **`initialNumSteps` blocking a match against an earlier identical delivery**, a reply that predates the prompt not counting |
| `src/antigravityRuntime.test.ts` | 8 | accepted→delivered, unconfigured runs new-conversation, failure recorded before it is thrown, **a receipt read failure not invalidating a completed delivery**, serialized concurrency, log cap |
| `src/antigravitySessionStore.test.ts` | 11 | Index path, ordering, empty-conversation filtering, owner filtering, search and paging, Windows path casing, workspace de-duplication and URI decoding, legacy format support |
| `plugins/rabi-antigravity-context/hooks.test.mjs` | 17 | Event mapping, conversationId→sessionId, workspacePaths→cwd, reading the prompt from the transcript, injection shape being `injectSteps`, **PreToolUse allowing by returning `{}`**, **a Manager outage not blocking tools**, Stop composing a follow-up reason, failing closed without a conversation id |

Live acceptance (requires Antigravity to be running):

1. Listing: route settings list existing conversations, and empty ones do not appear;
2. Delivery: send a message and confirm it lands in the target conversation with `SYSTEM` identity;
3. New conversation: clear the id, deliver, and confirm a conversation is created and its id returned;
4. Continuation: deliver twice into the same conversation and confirm no new conversation appears;
5. Hooks: after installing the package, run a turn and confirm `PreInvocation`, `PostToolUse` and `Stop` are all invoked;
6. Receipt recovery: interrupt a delivery and confirm the receipt is recovered from the transcript.

## 11. Security and privacy

- The delivery target is an explicit argument, never UI state, so there is no "posted into whichever conversation is open" risk;
- Hooks fail closed when there is no `conversationId`, so context cannot be written into somebody else's conversation;
- `PreToolUse` deliberately does **not** block tool calls during a Manager outage — failing closed there would make a Manager restart look like a broken host;
- The CSRF token is read per call; it is never persisted or logged;
- The conversation index is opened read-only (`file:...?mode=ro`).

## 12. Performance notes

A single `tasklist` call measures about **580 ms**, because it spawns a process. Host liveness detection originally ran it on every call, and the manager scan calls it often, so it was replaced with a two-stage strategy:

1. Screen with the mtime of `%APPDATA%/Antigravity/logs/main.log` (**2 ms** measured);
2. Fall back to the process table only when that signal is unavailable;
3. Cache the result for 10 seconds.

Measured: **580 ms down to 0.7 ms**. This also resolved a regression: one test requires the whole scan to finish within 1000 ms, and a single probe was consuming 600 ms of it.

## 13. Risks and stop conditions

| Risk | Description | Mitigation |
|---|---|---|
| Subcommand contract change | A host upgrade may alter `agentapi` arguments | Maturity is `experimental`; a failed delivery reports an error rather than degrading silently |
| Log format change | CSRF relies on how `main.log` writes `--csrf_token` | When it is missing, the error says "start Antigravity Desktop first" instead of returning empty |
| Index schema change | Relies on column names in `conversation_summaries.db` | A failed read records a warning and returns an empty list without affecting other adapters |
| Ids cannot identify the owner | Antigravity and Codex both use UUIDs | Every path persists `agentType`; no shape inference anywhere |

Stop condition: if a host upgrade stops accepting an explicit conversation id, the safety premise of delivery is gone, and the right response is to withdraw the capability declaration rather than fall back to driving the renderer.

## 14. Relationship to existing documents

- `docs/agent-adapter-standard-requirements_en.md`: the standard requirements for adapter integration; this document is one instance of them;
- `docs/agent-adapter-integration-lessons_en.md`: cross-adapter lessons from integration work; the lessons here have been folded into it;
- `docs/workbuddy-agent-adapter-plan_en.md`: a sibling document, useful for comparing how the transport differs between host shapes.
