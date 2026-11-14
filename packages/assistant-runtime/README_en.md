English | [简体中文](README.md)

# Shared assistant execution loop

0.10.1 explicitly calls the native player's optional `stop()` before `destroy()` during interruption. Releasing an object is not assumed to stop playback. Development packages and installed hosts are verified separately.

Version 0.10.0 adds `@rabilink/assistant-runtime/voice`: one injected capture, interruption and streamed playback owner shared by glasses, web, DSH and Rabi. Persona/tools remain in the assistant layer; remote connectivity remains an adapter. GUI and optional pet subscribe to the same owner. Interruptions stop TTS while preserving text and dispatched work. See the [host contract](VOICE_HOST_CONTRACT.md). Injected-host tests do not establish product or hardware acceptance.

`@rabilink/assistant-runtime` is a local development package. The RabiLink page uses its unified session; DSH has integrated a development snapshot with its own tool adapter in fixtures, with real Host/glasses validation pending. This package owns model decisions, tool observations and foreground capture lifecycle; `@rabilink/rokid-voice` provides Rokid ASR/TTS adapters. There are no credentials, network requests, storage, UI or backend SDK dependencies.

## Interfaces and ownership

### Settings layout (0.12.1)

Navigation and save controls remain fixed while settings scroll independently. Parameters use two columns on wide screens and one on narrow screens, with functional search and optional API names. Closing with unsaved changes offers keep-editing or discard actions; saving disables the button until another change. Scoped styles load with `./ui`.

### Streaming output and shared settings (0.12.0)

Playback adapters can provide `beginStream()` so one reply sends text deltas through one synthesis session. Cancellation fences late audio. The optional `./ui` entry accepts host-provided React and state/command interfaces; the core loop has no UI dependency.

The settings panel renders provider/model/voice capabilities with grouped search, dependencies, value validation and independent model profiles. Speech adapters own the catalog and request encoder; the UI does not infer support from model names. Vendor features not yet integrated remain explicitly unavailable. All 133 shared tests pass; this does not establish real-provider or hardware acceptance.

### Current foreground lifecycle (0.10.3)

`voice.setOutputEnabled(boolean)` and the optional constructor setting `outputEnabled` (default true) control audio independently of capture and text. `getState()` reports the permission. Disabling it cancels active, queued and pending audio and suppresses future responses, while existing/new response tokens continue appending and finishing text. Re-enabling permits only newly created responses to speak: it neither replays muted tails nor opens the microphone or cancels model/tool work.

For a hidden view with continuing work, call `setOutputEnabled(false)` then `pauseListening()`. On show, restore the user's output preference; call `activate()` only from an explicit microphone gesture/wake action. `isActive` must describe the real owner's validity, not hide background text on view visibility changes. Existing `suspend()` remains a hard deactivation that retires response tokens; it is unsuitable when hidden work must continue text projection. Durable Session events, admission receipts and reconstruction remain product responsibilities.

116 shared tests and strict TypeScript consumer checks pass. The same hide/show, pending-synthesis cancellation and late-callback cases exercise AIUI callback, browser audio event and desktop queue receipt fixtures. An accepted model request also completes after hide while retaining its text. Product integration, installation and actual microphone/speaker acceptance are separate evidence. See the [voice host contract](VOICE_HOST_CONTRACT.md) for the operation matrix.

### Independent playback queue (0.9.0)

`@rabilink/assistant-runtime/playback` exports `createSpeechPlayback()`. Rabi now delegates its sentence queue, synthesis/playback deadlines, canplay/first-chunk startup, cue ownership and cancellation to this module; the duplicated Page queue, resource handles and timers were removed. When injecting `runtime.tts`, also inject `runtime.releaseSpeech` so cleanup stays with its original owner and occurs once. `cancel()` discards queued sentences and releases only current synthesis/playback. ASR, model work and backend tools continue; text and task receipts remain caller-owned.

```js
import { createSpeechPlayback } from '@rabilink/assistant-runtime/playback';
const playback = createSpeechPlayback({
  tts: runtime.tts, releaseSpeech: runtime.releaseSpeech,
  isActive: () => pageVisible && !destroyed,
  onEvent: event => updateSpeechView(event)
});
playback.speak('First sentence', { voice: selectedVoice, volume: 1 });
playback.speak('Second sentence', { voice: selectedVoice, volume: 1 });
// In an accepted speech-onset/interim/gesture handler:
playback.cancel();
// Dispose on unload; cancel on hide.
```

A true result from `speak()` means accepted, not played or heard. Presentation receives `synthesizing`, `play-requested`, `cue`, `ended`, `error`, `cancelled`, `idle` and `unavailable`. Only the owned player's ended event confirms normal completion; generated duration and estimates adjust failure deadlines. Native canplay or the first audio chunk gates the relevant player startup. Repeated/late events cannot start retired audio, overwrite newer cues or terminate a replacement. Voice, volume and audio options are snapshotted on enqueue. The lifecycle owns AbortSignal and cue callbacks; consumers use `cancel()` and `onEvent`.

All 90 shared source tests and strict typing pass. Eight new tests cover queue options, stale callbacks, pending synthesis cancellation, hide, play rejection, deadlines, reentrant cleanup and an integrated shared-runtime regression preserving active model work/ASR while releasing audio exactly once. DSH reports isolated 0.8.0 listening integration checks passing; its 0.9.0 playback migration and actual device audio remain pending.

### Foreground listening lifecycle (0.8.0)

`@rabilink/assistant-runtime/listening` exports `createListeningLifecycle()`. The Rabi Page now uses it instead of separate startup, restart, empty-round counting and startup-deadline implementations. Inject `runtime.asr` or an adapter with the same contract and call `activate()` synchronously from a genuine user interaction. Native permission checks remain authoritative. Defaults are a 250ms restart delay, a limit of three consecutive empty rounds shorter than 1000ms, and a 15000ms startup deadline; all are configurable. Rabi keeps its existing 220ms restart delay.

`canStart()` controls only the next round, so model activity cannot discard the current user's final transcript. `isActive()` checks owner visibility/lifetime; late callbacks after hide retire capture without delivering input or onset. Consumers must still call `pause()` on hide and `dispose()` on unload; visibility is not polled. `pause({graceful:true})` invalidates ownership before requesting native stop and does not deliver that stop's final transcript. Silence never fabricates a final result. Errors and permission denial do not retry automatically; retired callbacks and late start rejection cannot affect a replacement.

```js
import { createListeningLifecycle } from '@rabilink/assistant-runtime/listening';
const listening = createListeningLifecycle({
  asr: runtime.asr,
  isActive: () => pageVisible && !destroyed,
  canStart: () => listeningDesired,
  onEvent: event => updateListeningView(event)
});
// Synchronously inside a genuine tap/wakeup handler:
listening.activate({ handlers: { onFinal: result => acceptUserText(result.text) } });
// On hide/unload:
listening.pause();
listening.dispose();
```

This interface owns capture lifecycle only. Sentence playback queues remain Page-owned; DSH's five-second task pause, durable input, scope/IDs and receipts remain adapter-owned. All 82 shared tests and strict typing pass, including ten listening regressions; the Rabi source and supplied AIX each pass 41 Page voice contracts. These are software/synthetic-input results, not microphone, audible TTS or DSH installation acceptance.

### Structured final replies and global formatting (0.7.3)

A real OpenAI check successfully discovered and called the read-only endpoint, then placed the required prefix outside its final JSON. Strict validation rejected it as `framing`. The protocol now explains the envelope for every structured response and includes a complete final-object example; global formatting belongs inside the corresponding say/text field. The caller's global prompt remains intact and last. Parsing remains strict and never strips surrounding prose or replays executed tools.

The same live scenario then completed api.find and api.call once each, preserving the final prefix and returning the random count and full receipt. This single OpenAI middleware check uses synthetic read-only HTTP data; it does not establish universal model reliability, Rokid host behavior or device audio acceptance.

### Defer explanations and interjection diagnostics (0.7.2)

The real host included `text` with `disposition: defer`, which 0.7.1 rejected as an extra field and left unconfirmed. Version 0.7.2 explicitly permits an optional nonempty explanation up to 16000 characters. Parsing still returns only defer: the explanation is never an answer, completion receipt or tool invocation. Other fields and protocol/request/input identities remain strictly validated.

Failed interjection receipts may carry `protocolFailureReason`, restricted to closed codes without raw content. All 72 shared tests, strict types and 39 actual-AIX page contracts pass. An official Studio real-model probe answered an arithmetic interjection with its global prefix while the original tool waited, deferred a second tool request, then executed it after the original completed. Both endpoints ran once with independent results. Tool backends/transcripts are synthetic and storage is isolated memory; this does not certify real PC access, persistence or audio. See `apps/rabilink-aiui/docs/tool-wait-probe_en.md` for reproduction.

### Request-scoped response formats (0.7.1)

The real Rokid host returned `kind: interjection` for an ordinary first turn, which strict validation rejected. `getAgentProtocolFailureReason(error)` returns only a closed reason code for framing, JSON syntax, identity, kind or field failures; no raw response, field names, arguments or identifiers are returned.

`protocol.input()` now supplies answer/defer examples only in `independent-input.responseFormats`, using that request's actual request/input IDs. The system prompt selects the current message's format rather than carrying historical formats forward. Parsing and tool permissions remain strict; invalid responses never replay automatically. All 71 shared tests and strict types pass. The official simulator now answers the previously failing first turn, recalls its passphrase on the next turn and dispatches a local tool whose request the host accepts. Real tool-wait interjections, audio, device and DSH runtime acceptance remain pending.

### Per-input interjection ownership (0.7.0)

Use `conversation.interject({id, scope, text}, {assertCurrent})` for independent inputs. Require `supportsInterjectionReceipts === true`, the same `inputScope` on the original `run()`, and `limits.interjectWhileWaiting`. Scope is the captured task binding (backend, Host, connection generation, sessionId, etc.), not the broader assistant notification domain. No active user tool wait, mismatched scope, a legacy protocol without the parser, or closure returns `unavailable` without a hidden queue.

Each Promise carries immutable original input, `modelInvoked`, and `toolDispatched:false`:

| status | Meaning |
| --- | --- |
| `answered` | An explicit answer for this inputId was generated; only this state has text. It certifies neither presentation, audio, persistence nor tool-task completion. |
| `deferred` | The model deferred or proposed a tool action. Return original input without executing or caching the action. |
| `returned` | Accepted but not submitted before the tool ended, cancellation, budget exhaustion or stale input binding. |
| `unavailable` | Not accepted or submitted; the caller retains the input. |
| `unconfirmed` | Submitted but framing, connection, cancellation or identity remains unconfirmed. Keep the reservation without automatic replay. |

The adapter retains/reserves inputs durably first. For deferred/returned/unavailable, it may queue `conversation.run()` within the SAME reservation with original text, turnId, inputScope and guard for a fresh decision. Do not retain/reserve again or mint another ID. Task switching or view closure must prevent execution and settlement. Processing settlement and presentation receipts for answered remain separate adapter responsibilities; failed settlement never authorizes regeneration or execution. Crash recovery relies on durable adapter reservations; this package adds no storage owner.

Within the active turn, identical scope/id/text shares a Promise; conflicting text throws `ASSISTANT_INTERJECTION_ID_CONFLICT`. Up to 16 records, including settled inputs, remain until turn end. Cross-turn/restart deduplication is external. Input/options are snapshotted against later mutation.

Model requests remain serial. Independent replies require interjection JSON with matching requestId/inputId and answer/defer; ordinary final text is not a consumption receipt. Answers return only through their own Promise, never original onText, text, tool results or history. The original tool retains its callId. Transport/request timeout ends the invalid foreground model session without cancelling dispatched backend work: submitted input becomes unconfirmed and unsubmitted inputs are returned.

70 shared tests and strict type checks pass, including 16 new regressions for independent results, duplicate/conflicting IDs, deferred decisions, receipt races, scope/view changes, returned inputs, disconnection, late results and legacy protocols. Rabi still uses the 0.6.0 text-guidance entry below and has not migrated per-input receipts. DSH keeps interjection disabled pending adapter integration and durable-settlement failure tests. These software contracts are not product or physical-device acceptance.

### Replies while a tool is waiting (0.6.0)

With `limits.interjectWhileWaiting=true`, the same host model can answer new input while a dispatched tool awaits its receipt. `session.guide(text)` wakes the wait automatically; callers owning an external `takeGuidance` queue call `session.notifyGuidance()` after enqueueing. The option defaults to false for existing consumers. The Rabi page enables it without changing capture, interruption or original tool ownership.

The `user-interjection` message reports only the original callId, tool name and `awaiting-receipt` status, without inventing acceptance or completion. Interjection replies are fully validated before presentation and cannot dispatch tools. A tool frame fails explicitly without cancelling the backend operation. Model requests remain serial: an earlier tool completion waits for the current interjection reply before its actual receipt reaches the model. Original step/request/turn limits apply; no extra model or inference provider is created.

The 54 shared regressions, strict types and 35 page voice contracts cover replies before tool completion, original receipts, model serialization, rejected actions, cancellation and stale bindings. Page tests use synthetic model/voice resources and do not establish real Rokid compliance or glasses audio. Task-event subscriptions, cross-restart notifications and actual long-tool integration remain pending.

### Foreground speech priority (0.5.3)

AIUI assembly exposes current recognition input through `getState().inputPending` and `onInputStateChange(boolean)`. Onset or interim text holds input priority. Silence is not a final transcript: release after final text reaches the caller and speech has ended, or on recognition end, error, stop or disposal. Interim/final events also support hosts without onset events. A new conversation inherits current input state; obsolete callbacks cannot clear a replacement round. Idle continuous listening does not hold priority. If the host returns neither a final result nor a round termination, input remains unconfirmed rather than being timed into completion.

Shared conversations defer background observations automatically. The Rabi mailbox reads the same state so user input and queued guidance run first. Dispatched tools and backend tasks continue. This does not add a Rabi task-subscription API; acoustic echo, gaps and physical capture require device acceptance.

### Global instructions (0.5.2)

The action protocol and tool catalog precede the caller's unchanged global instructions in the same initial system message. Global instructions occur once, with conversation history ordering preserved. This avoids a long trailing protocol displacing answer-format requirements; JSON validation, tool authorization and receipt semantics are unchanged. Live OpenAI middleware comparisons showed the old order omitting the required prefix or placing it outside JSON. The new order completed discovery, invocation and receipt verification while retaining the final prefix. These synthetic-data checks do not establish reliable compliance for every model or Rokid device acceptance.

### Per-turn binding checks (0.5.1)

Require `conversation.supportsTurnGuard === true` before processing a draft bound to a task. Version 0.5.1 derives this capability from the injected `session.supportsTurnGuard === true`. A legacy session produces false and guarded runs fail with `ASSISTANT_TURN_GUARD_UNSUPPORTED`. Older packages ignore unknown run options, so consumers must stop submission when this capability is absent. The 0.5.0 development snapshot lacks the mixed-version check. Use 0.5.1 for task-bound input.

```js
if (conversation.supportsTurnGuard !== true) throw new Error('TURN_GUARD_REQUIRED');
const binding = captureOriginalTaskBinding();
await conversation.run(originalDraft, {
  assertCurrent() { assertTaskBindingCurrent(binding); }
});
```

`assertCurrent` is synchronous and read-only, returning `undefined` on success. Capture the original task, Host, account and connection generation in its closure and throw when stale. The shared layer checks at dequeue, model creation, after initialization, before each model request and immediately before tool dispatch after presentation callbacks. Async or non-void results fail with `ASSISTANT_BINDING_CHECK_MUST_BE_SYNC`. Queue insertion copies options and limits, so replacing a callback in the caller's options cannot alter a queued turn.

Execution errors from `conversation.run` carry `originalInput`, `cause`, `code` and any unconsumed session `pendingGuidance`. Consumers retain the original draft and durable turn reservation, then reconcile backend receipts before deciding further actions. An error carrying the original text does not establish whether earlier operations were dispatched. The shared layer never automatically replays input, and dispatched tools settle under their original owner. Backend adapters must also check authorization and the fixed target immediately before actual side effects, particularly after internal asynchronous work. Direct session and turn callers can supply `assertCurrent` too.

45 shared tests and strict type checks cover task switching after enqueue, mutated options, switching during initialization, late model replies, switching inside presentation callbacks, ownership of dispatched work, async-guard rejection, legacy-session mixing and original-input recovery.

### Foreground conversation and task observations (0.4.0)

`0.4.1` fixes late ASR events and microphone cleanup calling an independently closed conversation. Voice resources continue their own lifecycle cleanup, with the exit path covered by the 37 shared tests.

Import `createAssistantConversation` from `@rabilink/assistant-runtime/conversation` with a shared `session`, fixed connection `scope`, and durable notification `receipts`. AIUI callers can use `runtime.createConversation({scope, receipts})` after `createSession()` to connect speech start/end to observation scheduling. Transfer exclusive model scheduling to this owner. Use `conversation.run()` for user input and `guide()` for an active user turn. Replace the conversation and session when the connection scope changes.

One assistant can observe multiple background tasks within its permission domain. Build `scope` from the locally verified account, pinned Host and assistant profile/permission domain, retaining it when task focus changes. Make `id` unique within that domain, for example `JSON.stringify([backend, workspaceId, sessionId, durableSeq])`. `body.task` can carry the original task reference for presentation and summaries. Before submitting an observation, adapters verify task membership and child-agent visibility against trusted connections and local permissions. Construct the outer scope from that binding and treat the body as untrusted facts. Maintain subscriptions and checkpoints per task. Notification receipts use the assistant scope and complete compound event ID. Migrating an older task-level scope requires an explicit receipt migration or recovery baseline that preserves the existing records.

```js
const conversation = runtime.createConversation({
  scope: backendConnectionScope,
  receipts: {
    has: (scope, id) => notificationStore.hasAcknowledged(scope, id),
    acknowledge: (scope, id) => notificationStore.persistAcknowledgement(scope, id)
  }
});
await conversation.run(userText);
const update = await conversation.observe({
  id: backendEventId, scope: backendConnectionScope,
  kind: backendEventKind, status: backendReportedStatus, body: backendFacts
});
if (update.status === 'processed') {
  await showTaskUpdate(update.observation, update.result.text);
  await conversation.acknowledge(update.observation.id);
}
```

Adapters supply stable scoped event IDs and own authoritative task state, subscription recovery and durable display acknowledgements. `has()` returns a boolean. `acknowledge()` returns `true` after a confirmed durable write. The shared layer preserves `kind/status` and sends facts to the same model as `task-observation` with `untrusted:true`. Observation turns can generate text and have tool execution disabled. `processed` means generation finished. The caller acknowledges after presentation. Failed acknowledgement can be retried independently while the instance retains the generated result.

User input takes priority at turn boundaries. Speaking holds observations that have yet to start. Receipt queries run independently of foreground input. User jobs and observation records each have a default capacity of 32, configurable from 1 to 256. Rejected input stays with the caller. Receipt operations time out after five seconds by default, configurable up to 30 seconds. Disposal, cancellation and failure settle the original promises. Backend tasks retain their original owner. Generated observations occupy capacity until acknowledgement. Durable `has()` supplies deduplication across restarts. An interruption between display and acknowledgement can cause redisplay, so the presentation layer should update notifications by stable ID.

Once a backend returns a real `accepted/running` receipt and task reference, foreground conversation can continue. A model request or dispatched tool still waits for its current settlement. User input can queue or guide a user turn. Input arriving after an observation starts runs with priority after that observation settles. Cross-task subscriptions, offline recovery and production completion-notification UI still require product adapters.

### AIUI Page assembly (0.3.0)

`@rabilink/assistant-runtime/aiui` exports `createAiuiAssistantRuntime`. The Rabi Page uses it to own native voice resources and create shared model sessions. DSH can inject its own profile, adapter and host. It contains no Rabi protocol, endpoint, credential, UI or provider selection.

```js
import { createAiuiAssistantRuntime } from '@rabilink/assistant-runtime/aiui';
import { createAiuiAsrInputAdapter, createAiuiTtsOutputAdapter } from '@rabilink/rokid-voice/runtime';

const runtime = createAiuiAssistantRuntime({
  asr: createAiuiAsrInputAdapter({ SpeechRecognitionCtor: SpeechRecognition }),
  tts: createAiuiTtsOutputAdapter({ speechSynthesisApi: speechSynthesis,
    SpeechSynthesisUtteranceCtor: SpeechSynthesisUtterance, SpeechAudioPlayerCtor: SpeechAudioPlayer }),
  session: { profile, createModel, discoverTools },
  onCleanupError: reportResourceError
});
await runtime.session.ready();
// Start from a supported user interaction. The app routes complete transcripts.
const round = runtime.asr.createRound({ continuous: true, interimResults: true, onFinal: acceptTranscript });
await runtime.asr.start(round);
// run/guide, global instructions, discovery and recovery use the session contract.
try {
  const result = await runtime.session.run(userText);
  retainOriginalScopeDraft(result.pendingGuidance || []);
} catch (error) {
  retainOriginalScopeDraft(error.pendingGuidance || []);
  throw error;
}
```

- Construction does not start recording, model work or networking. `ready()` prepares model/tools; `asr.start(round)` requires a valid interaction, actual host capabilities and microphone permission. The injected `createModel` still checks service availability. Importing the package does not give an ordinary webpage Rokid services.
- The adapter interfaces retain their capture/synthesis usage, owning one recognition round and one pending/playing output. Replacing a round fences old events. Speech onset interrupts owned output without stopping capture, cancelling the model or undoing backend work. Distinguishing user speech from echo still depends on host VAD/AEC and application filtering.
- `runtime.tts.synthesize()` returns the real `{task, player}` without playing it. The caller owns canplay/ended/error handling, captions and deadlines. Use `releaseSpeech({task,player})` after completion, or `{abort:true}`/`interruptSpeech()` to interrupt. During synthesis, pass the original Promise as `task`. Repeated release is idempotent; an old output cannot release a newer one.
- Interrupted synthesis rejects promptly and late task/player resources are retired without publishing stale captions. Cleanup is best effort, with `onCleanupError` reporting native failures; a cleanup call alone does not certify hardware state.
- `suspendVoice()` releases only voice and retains the model. The application decides whether hiding a Page also ends its model. `dispose()` permanently closes the owner and releases voice/model clients without cancelling durable backend tasks. The original run caller still handles cancellation/error `pendingGuidance`.
- `createSession(options)` validates and replaces the model client, disposing late candidates through shared session rules. It does not switch voice sources. Use `runtime.session.configure(profile)` for deferred profile updates. Before changing Host/task, explicitly close the original input scope and retain its draft; do not route old guidance into the new target.
- Sentence queues, task silence aggregation, echo-text filtering, HUD, durable drafts and backend state remain with their respective owners. Assembly does not turn a serial tool loop into independent immediate conversation during long work.

There are no third-party runtime dependencies. Rabi bundles `src/aiui-runtime.js` together with session/turn/protocol into the AIX; do not upload unbundled npm imports to an unsupported host. DSH can bundle the fixed local development snapshot. Public distribution and hardware entry points remain incomplete.

### Unified session entry (0.2.0)

Import `createAssistantSession` from `@rabilink/assistant-runtime/session`. The Rabi page now uses this entry, passing device-profile global instructions, the host model factory and its existing tool adapter. The page retains voice, HUD, history and lifecycle ownership.

```js
const assistant = createAssistantSession({
  profile: { systemPrompt: globalPrompt, modelOptions: {} },
  createModel: options => LanguageModel.create(options),
  discoverTools: async ({ profile, signal }) => ({
    tools: await adapter.discover({ profile, signal }),
    executeTool: event => adapter.execute(event),
    toolPolicy: adapter.policy,
    dispose: () => adapter.releaseClient()
  }),
  onText: ({ delta, text }) => present(delta, text)
});
await assistant.ready();
const result = await assistant.run(userText);
```

`discoverTools` returns an adapter bound to the selected target. Its declared tools provide interface lookup, contract reading and invocation; the assistant uses actual contracts for subsequent decisions. Unauthenticated remote declarations are not connected tools. `createModel` uses the host factory without selecting an alternative provider.

The global prompt is the first system message, followed by application framing. Profiles may carry adapter source references. Initialization is single-flight with a default 30-second deadline. Discovery errors are explicit and retryable; late models after cancellation/timeout are destroyed. Subsequent turns reuse the model and tool binding.

- `run(text, options?)` executes one turn; `ASSISTANT_BUSY` prevents a second concurrent model request. Per-turn `turnId`, `limits`, `onText`, `onState` and `takeGuidance` do not change the session model, protocol or tool binding. Per-turn callbacks replace defaults only for that run. External guidance returns at most 16 items per call; internal `guide` items drain first at decision boundaries, without merging two queues into an oversized batch.
- `guide(text)` returns whether current-turn guidance was accepted. Idle/finishing/full states must not be presented as accepted; callers retain such input and submit it after the active run ends. Independent voice code interrupts audio immediately.
- Guidance accepted while a terminal tool runs but not consumed is returned through the optional `run()` result field `pendingGuidance`. Callers retain it as a draft scoped to the original session and restore it according to the user's next intent. Do not automatically reopen an exited view, send to a different target or replay a tool. Acceptance means queued, not already processed by the model.
- Since `0.2.6`, cancellation and disposal also return that queue in the original `run()` cancellation result. Initialization deadlines, model failures and turn deadlines return it on the thrown error's `pendingGuidance`, preserving `code` and the original `cause` without mutating host errors. Results and errors are mutually exclusive ownership transfers; there is no duplicate automatic retry queue. Callers must settle the original `run()` even after view exit, retain drafts if saving fails and never retarget them to a newer session.
- Recovery includes only this instance's `guide()` queue entries not yet handed to the turn loop. It excludes the original `run(input)` and caller-owned external `takeGuidance()` input. Dequeuing at a decision boundary does not certify processing; callers retain original input and submission records. Absence of `pendingGuidance` does not prove the model or tools did not execute.
- `configure(profile)` and `refreshTools()` defer during a turn and apply after settlement, preserving dispatched operation targets. `applied` describes adopted configuration; only successful `ready()` confirms a new model/tool context.
- `cancel()` stops the turn and current client session, permitting reinitialization; `dispose()` permanently releases the instance. Neither invokes backend task cancellation. Adapter disposal only releases the client; backends retain durable operations and receipts.
- `getState()` reports local closed/busy/ready/pendingConfiguration and turn state, not backend task status.

### Lower-level protocol and turn execution

`@rabilink/assistant-runtime/protocol` exports `createAgentProtocol({ id, introduction, toolInstructions })` and `canonicalAgentIntent`. The factory returns `id`, `modelOptions(options, tools)`, `input(requestId, data)` and `parseDecision(raw, requestId)`. Profiles supply their prompts/tools. The default protocol is `assistant-agent/v1`; the Rabi adapter preserves `rabi-agent/v1`. Data cannot override application identity fields.

`modelOptions` preserves initial persona instructions, appends the application protocol and clears native model tools to avoid duplicate execution. Observations use supported user messages marked as untrusted data, without inventing native tool roles or submission APIs.

Global instructions still govern visible `say`, `final.text` and natural replies, but persona prefixes cannot appear outside action JSON. Version `0.2.4` rejects decorated/fenced action frames instead of treating them as successful answers. During plain-text streaming, a possible JSON suffix is held until full validation; ordinary data JSON is then displayed, while malformed action content is never spoken. Ordinary prose continues streaming. Framing validation cannot guarantee adherence to arbitrary persona/style instructions.

`@rabilink/assistant-runtime/turn` exports `createAgentTurnRuntime` with these injected dependencies:

| Parameter | Responsibility |
| --- | --- |
| `model` | Selected host session supporting promptStreaming or prompt; the loop never selects a model/provider |
| `protocol` | Protocol object matching the one used to initialize the model |
| `tools` | Available declarations or names; not backend authorization |
| `executeTool(event)` | Backend authorization, pinned target, durable idempotency and execution; returns original receipts |
| `toolPolicy.classify(decision)` | Validate backend operation/arguments and return `{ mutation: boolean }`; invalid classifications prevent dispatch |
| `toolPolicy.inspectOutcome(result, decision)` | Return boolean `uncertain`, `failed`, `terminal` according to the backend contract; missing, throwing or malformed results remain unknown |
| `turnId` | Application-scoped identity used to derive requestId/callId; backend binds actual session/operation identity |
| `takeGuidance/onText/onState` | Read guidance from its owner and publish actual text/loop state, without persistence |

The return object has `run(input)`, `cancel()` and `getState()`. Existing configurable defaults remain requestTimeoutMs 30000, turnTimeoutMs 180000, maxToolCalls 16 and maxSteps 32.

The loop retains raw `observation.outcome` and adds adapter-verified `outcomeStatus`. Executor exceptions and unreadable receipts cannot certify success. Equivalent writes reuse original observations; unknown writes block further writes but permit readback. Blocked actions carry `dispatched:false` and `WRITE_RECONCILIATION_REQUIRED`. These are per-turn protections, not durable backend idempotency or cross-turn reconciliation.

`completed` means only that **this assistant turn ended**. Backend accepted/running receipts retain their state; turn completion is not task completion. `cancel()` stops this turn's model/presentation, without undoing dispatched tools. Backend task cancellation uses the separately authorized backend interface.

## Common Rabi and DSH direction

Both use the same assistant mechanism, distinguished by persona, focus, tools and backend adapters. Rabi policy lives at `apps/rabilink-aiui/utils/rabi-agent-tool-policy.js`, retaining public API, target computer, permission and receipt semantics. DSH needs its own queue/turn-steer, session binding, approval and receipt adapters rather than Rabi fields.

Following the [proactive intelligence design](../../主动智能设计思路_en.md), the complete assistant restores context from sourced, timely and authorized events; understands intent; gathers evidence; chooses participation; acts and verifies follow-up. This package provides single-turn execution within that design. Keyword routing or prompt declarations do not establish complete proactive intelligence.

Shared task silence aggregation is available in [`@rabilink/rokid-voice/task-input`](../rokid-voice/README_en.md). DSH has phone silence settings, while the device task-voice path remains pending. Version 0.4.0 provides user-priority foreground scheduling and scoped task observations. Backend adapters supply cross-task subscriptions, offline recovery and durable task state. Production completion notifications still require integration. Tools settle serially before reasoning continues. Leaving a view, muting input, interrupting output and cancelling work are handled independently.

## Validation and development snapshot

Run `npm test` for profile isolation, non-Rabi tools/fixture receipts, uncertain writes, invalid adapters and cancellation. AIUI `npm run check:agent` runs these alongside Rabi page/tool regressions. Fixture backends do not prove DSH integration or hardware operation.

`npm pack` creates a package-only development snapshot with dependency-free tests; recipients can run `npm test` after extraction. It is not publication or production installation. Maintain the source here rather than copying a second assistant loop.

### 0.2.3 development changes

- Migrated the Rabi page to the unified session with per-turn history/HUD/TTS callbacks. Exit and rename release the old session; late models cannot replace a newer session.
- Added validated per-turn options and separate internal/external guidance draining without dropping accepted input.
- Seventeen package runtime tests and strict TypeScript consumer checks passed. Rabi model creation retains its configured stage deadline and destroys late resources.

### 0.2.4 development changes

- Reject persona-prefixed full/truncated action frames that previously became successful plain answers, while preserving ordinary prose data JSON.
- Nineteen shared runtime tests passed. Added explicit opt-in `apps/rabilink-aiui/simulator/Test-LiveAssistantLoop.mjs --execute`, using the existing local proxy and a random-path read-only HTTP fixture without reading or printing credentials.
- Real `gpt-4o-mini` runs discovered/called the endpoint and reported its randomized receipt correctly, but the requested final prefix remains unreliable and the full format assertion failed. This unresolved model-adherence limitation is not accepted as a pass. The test provider is not the Rokid host and does not establish device model behavior.

### 0.2.5 development changes

- Return accepted but unconsumed guidance in `pendingGuidance` when a terminal tool ends the turn. Preserve terminal behavior without another model request or tool replay.
- Twenty shared runtime tests passed. The regression first reproduced lost input, then verified unchanged returned text, single execution and rejection of new input after completion. Consumers still need to retain this field; this test does not establish phone draft UI integration.

### 0.2.6 development changes

- Recover unconsumed guidance on cancellation, disposal, initialization timeout, model failure and turn timeout. Preserve original error causes, including immutable host errors.
- Twenty-three shared tests passed. Regressions first reproduced loss, then verified exact queued text, no duplicate return of dequeued input, late resource release and single execution of dispatched backend work.

### 0.3.0 development changes

- Added provider/backend-neutral AIUI assembly and connected the Rabi Page's ASR, TTS, model candidates and disposal.
- Added eight ownership tests: onset interruption, late synthesis cleanup, stale recognition callbacks, stale output isolation, model replacement, cleanup errors, pre-cancelled requests and ASR start failure. All 31 shared tests passed.

## 0.11 resident host and optional UI

The native Host owns `createResidentInteraction` from `./resident`. Detaching every GUI/pet presenter does not stop explicitly enabled speech. `pauseCapture` pauses input, `setOutputEnabled(false)` mutes output, and `stop`/`dispose` release speech services without cancelling admitted work owned by the native Session. Barge-in stops audio while text continues.

`openServices` must return an awaitable `dispose`. Cancelled startup, late permission results and unconfirmed cleanup remain fenced. Native process-tree ownership belongs to the PC shell's Windows Job, not SDK polling.

The optional `./ui` export supplies `createAssistantPanel(React, primitives)`. It reads Host state, sends commands and subscribes to the native conversation projection. It owns no microphone, player or model. The low-level voice suspend contract remains available; resident hosts must not bind browser visibility to suspension.

132 SDK tests passed. Installed-host, acoustic and physical-device acceptance remain separate.

### Settings drafts and navigation

Conversation, recognition, speech output, devices and appearance have separate top-level entries. Provider/model/mode changes remain drafts until Save. Closing offers Continue editing, Discard or Save and close. Refresh, playback and microphone tests explicitly say Save and… when pending settings must be applied. DSH host model selection remains immediate and is labeled accordingly.

Hosts expose `previewSettings(patches)` and `saveSettingsBatch(patches)` with matching validation and profile reduction. Preview neither persists nor stops voice. Batch save accepts at most 64 patches and commits once; direct profile writes are rejected. Credentials are saved separately for the effective provider and endpoint. The UI distinguishes draft state, missing setup and disconnection.

### First use and preview boundaries

The DSH plugin reads providers and models from its current DSH host without duplicate chat credentials. Select a model and confirm a real text reply before configuring recognition, a voice and audio devices. An empty catalog or a default model name does not prove the model is callable. Isolated environments need the actual provider plugins and credentials.

UI previews explicitly state that conversation is unavailable, including inside settings and sample model results. Credentials, sending, voice start and audio tests are disabled in previews. First-use guidance proceeds through conversation, recognition, output and devices; model parameters may initially keep their defaults.
