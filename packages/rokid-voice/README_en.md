English | [简体中文](README.md)

# Shared Rokid voice package

`@rabilink/rokid-voice` is a local development package for RabiLink and DSH glasses clients. It is not published or integrated into DSH hardware yet. RabiLink imports this single implementation through thin application entry points; esbuild inlines it for QuickJS.

## Extracted interfaces

- `@rabilink/rokid-voice/task-input-handoff` adds `createTaskInputHandoffBuffer` in `0.3.0`, reusing silence aggregation while owning immutable batches during asynchronous durable retention.

### Asynchronous durable handoff

```js
import { createTaskInputHandoffBuffer } from '@rabilink/rokid-voice/task-input-handoff';
const input = createTaskInputHandoffBuffer({
  scope: JSON.stringify([backend, hostId, connectionGeneration, taskId]),
  createHandoffId: () => secureUniqueId(),
  retain: value => taskDraftStore.retain(value),
  onSettled: result => updateDraftStatus(result),
  onInterrupt: () => stopOwnedPlayback()
});
// Connect the existing speechStart/speechEnd/interim/final events.
const result = await input.flush();
const leaving = input.dispose();
// leaving.draft contains input awaiting handoff.
// leaving.handoffs contains IDs, original packets and awaitable completion promises.
```

The caller supplies unique `handoffId` values and a receiver that persists `{handoffId,scope,text}` idempotently. Confirmed persistence returns `{status:'retained',handoffId}`. Each pending batch remains owned while the existing buffer accepts new speech. Up to 32 unconfirmed handoffs are retained by default, configurable from 1 to 256. At capacity, new input stays in the aggregation buffer. Failure or a mismatched receipt returns `unconfirmed` with the original text. An explicit `retryHandoff(id)` retries retention with the same ID. A retry during a pending write returns its original Promise.

`dispose()` returns the unoffered draft and all unconfirmed handoffs. Late writes remain bound to their original scope and settle their original promises. UI callbacks stop after disposal. The receiver validates the original account, Host, connection generation and task authority. Restore a same-scope handoff with `restoreHandoff({handoffId,packet})`, then retry explicitly. The receiver owns persistence, deduplication across restarts and conflicting-content rejection. Input awaiting a `retained` receipt remains unsaved. Survival across process termination depends on the actual storage operation completing.

The existing synchronous boolean `createTaskUtteranceBuffer.onReady` contract remains available. Version `0.3.0` preserves leading, trailing and internal whitespace and line breaks in final transcripts, using `trim()` only to reject empty input. Separate ASR segments are joined with one space. Previously normalized saved drafts still restore. Formatting already changed by ASR or a model remains outside this layer's control.

- `@rabilink/rokid-voice/runtime`: `createAiuiAsrInputAdapter`, `createAiuiTtsOutputAdapter`, `VoiceRuntimeError`, `AIUI_NATIVE_VOICE_MODE`. Callers inject verified AIUI speech APIs. ASR negotiates interim capabilities and ignores late capability results after stopping. TTS uses an independent synthesis task and stoppable player.
- `@rabilink/rokid-voice/transcript-policy`: normalization, fingerprints, similarity and `createTranscriptPolicy`. Bounded text heuristics filter rapid duplicates and likely echoes; they are not acoustic echo cancellation or speaker identification.
- `@rabilink/rokid-voice/task-input`: `createTaskUtteranceBuffer` and TypeScript contracts. Aggregates final transcripts only within an open task; it does not own tools, task state or phone-setting persistence.

The package has no network, credential, task-dispatch, storage or UI dependencies. CXR-L audio capture is not AIUI recognition. React Native consumers need a verified host bridge rather than treating CXR-L objects as AIUI APIs.

## Shared interaction target

In `0.1.1`, `createRound({ onSpeechStart })` forwards host `speechstart` before text may exist. It is neither recognition startup nor complete input. Consumers check current round/page lifecycle before stopping their owned player while preserving model requests and backend tasks. Text echo filtering cannot apply without text; host VAD/AEC and false interruptions require hardware validation.

Keep Rokid ASR/TTS as the main path. Aim for the Codex experience of talking while work continues: within an enabled foreground voice session supported by the host, speech playback, reasoning and tools must not block user speech. Interrupt current playback promptly; preserve backend task identity, state and receipts. Only an explicit task-stop intent enters backend cancellation. Track captions, played audio and task results independently; do not require interrupted reply text to keep playing.

Version `0.2.0` implements task-scoped silence aggregation with a five-second default. Callers pass phone settings as integer milliseconds from 0 to 60000; changes apply to the next utterance. This controls handoff to an application queue, never playback interruption. Ordinary assistant conversation does not use this rule, and model activity does not imply an open task view. Rabi has no separate task view yet, so aggregation is not enabled there. DSH consumption and phone settings need separate acceptance. Leaving a view does not cancel work; this package is not a complete duplex coordinator.

### Task input integration

```js
import { createTaskUtteranceBuffer } from '@rabilink/rokid-voice/task-input';
const input = createTaskUtteranceBuffer({
  scope: JSON.stringify([backendId, hostId, connectionGeneration, taskId]),
  silenceMs: phoneSettings.taskSilenceMs ?? 5000,
  onInterrupt: () => stopOwnedPlayback(),
  onReady: packet => taskInputQueue.tryAccept(packet) // synchronous boolean: queue ownership only
});
const round = asr.createRound({
  continuous: true,
  onSpeechStart: () => input.speechStart(),
  onSpeechEnd: () => input.speechEnd(),
  onInterim: result => input.interim(result.text),
  onFinal: result => {
    const accepted = input.final(result);
    if (!accepted.accepted) retainUnacceptedSegment(result, accepted.reason);
  }
});
```

Callbacks still require current-round validation and existing echo filtering. `onSpeechEnd` forwards official `speechend`; stopped rounds do not forward late speech boundaries. Capture the same `input` in each round, rather than routing stale events through a global current-task variable. Speech onset interrupts immediately. Once speech ends and final text is available, the silence timer starts; fresh speech/interim events invalidate it. Late final text starts a full new interval; interim text never dispatches.

- Each utterance captures its interval; `configure({silenceMs})` does not shorten it. Limits are 64 finals and 16000 characters per batch, with the latest 128 result IDs deduplicated. Conflicting reuse fails explicitly. Overflow retains the accepted prefix and disables automatic submission; callers must retain rejected text rather than execute a truncated command.
- `onReady` returns a synchronous boolean, not a backend Promise or receipt. False, exceptions or an accidental Promise retain the draft without automatic retry. The application owns actual delivery IDs, idempotency and receipts. `flush()` explicitly submits/retries, refusing while speech/interim recognition is unresolved.
- On exit, task/Host/generation change, mute or recognition failure/end, call `dispose()` and retain its unsent final-text draft. Old events/timers cannot send and backend tasks are not cancelled. Interim text is not confirmed draft content; show the recognition interruption instead of automatically sending a partial command.
- Callers own draft persistence. `restoreDraft(packet)` works only in an empty instance with the same scope and does not start a timer. Explicit user choice precedes `resumeDraft()` or `flush()`. A new Host/generation/task cannot silently inherit the draft; retargeting requires a reviewed new-input flow.
- `peek()` and `getState()` expose unsent text and collection state. Local queue acceptance is separate from Host accepted/running/completed receipts. Without reliable host speech boundaries, software timers do not prove actual silence detection; verify events and capture on hardware.

Rabi retains Manager identity, authorization, idempotency and task adapters. DSH retains Remote transport, sessions, queues and approvals. Sharing voice logic must not merge credentials or replace P2P/Relay protocols.

## Validation and consumption

### Shared assistant loop and remaining work

Model decision protocol and serial tool execution live in [`@rabilink/assistant-runtime`](../assistant-runtime/README_en.md). Rabi uses the unified session; its adapter retains `rabi_api_call` classification and receipt fields. DSH has integrated a development package with its adapter in fixtures. Real device integration, task follow-up and notifications remain pending.

- Profiles provide prompts and tool declarations; adapters classify operations, execute them and normalize receipts. The shared loop owns serial model requests, turn/request/call identities, timeouts and guidance. Backends retain authorization and idempotency checks.
- Background task interfaces need submit, steer, explicit cancel, observation and references with pinned targets. Long tasks return genuine acceptance receipts and remain observable; accepted, running, completed, failed, waiting for input and unknown outcomes stay distinct.
- Foreground conversation and background work have independent lifecycles. Speech interruption, leaving a task view and microphone toggling do not implicitly cancel work. DSH retains Harness queue / Codex turn/steer; Rabi retains target computers and delivery receipts.
- Notifications deduplicate by backend event ID/cursor, reconcile disconnects and preserve source tasks. Summaries do not establish completion, and playback does not prove the user heard it. Missing cross-task coverage must be explicit.
- Following the [proactive intelligence design](../../主动智能设计思路_en.md), the same loop accepts user expressions, tool outcomes and authorized context events; restores sourced context with validity; develops and verifies intent hypotheses; chooses how to participate; acts and verifies follow-up. Proactive participation is more than keyword routing; model inference cannot replace facts, authorization or memory writes.

The current loop consumes guidance only after tools return, so immediate conversation during long work is not established. Cross-task notifications and independent background coordination remain unimplemented; this package supplies the listed voice foundation and task input aggregation.

`npm test` covers 12 aggregation/cancellation/restoration cases. Run `node <repository-root>/node_modules/typescript/bin/tsc -p test/tsconfig.json` for strict consumer types. AIUI `check:agent` includes the shared tests. Neither phone settings integration nor hardware task input has been accepted yet.

From `apps/rabilink-aiui`, run `node scripts/Smoke-RabiLinkVoiceRuntime.mjs`, `node scripts/Smoke-RabiLinkTranscriptPolicy.mjs`, `node scripts/Test-AiuiNativeVoiceContract.mjs` and `node scripts/Smoke-RabiLinkAiuiRuntime.mjs`. These cover shared code and page contracts, not glasses acoustics. Actual Ink and hardware checks must cover concurrent capture/playback, interruption latency, echo, disconnects and subsequent turns.

Use `npm pack` for a package-only development snapshot in another workspace. Publication, installation and dependency locking are separate steps; do not fork the source files into another maintained copy.

References: [official Rokid AIUI skill](https://github.com/yodaos-project/AIUI/tree/00c6ec71ee313817705683248b3ebe2acf0937f0/skills/aiui-dev), [OpenAI voice architectures](https://developers.openai.com/api/docs/guides/voice-agents), [separate conversation and task state](https://developers.openai.com/api/docs/guides/live-conversations). OpenAI references inform interaction design only; they neither add a voice dependency nor establish Codex internals.
