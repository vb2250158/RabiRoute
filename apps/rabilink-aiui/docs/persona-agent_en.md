# AIUI persona, APIs and voice steering

English | [简体中文](persona-agent.md)

Status: experimental implementation. Generic HTTP transport, persona configuration, history ingestion and steering queues are wired in source. Device installation and hardware acceptance remain pending. The application reasoning loop is wired; Route wakeup and real-host acceptance remain pending; this is not an accepted complete Agent.

## Phone settings

Open **All-day recording → Devices → Glasses → Glasses settings** in RabiLink. Select the glasses, the persona's source computer and a persona; optionally preload its Skills. Saving compares the current revision, preserves a stable request ID, verifies the receipt and reads the saved configuration back. Network failures retain the original request for reconciliation rather than resaving with a different ID.

The persona supplies identity, instructions, Skills and history ownership. Rokid configures the model. `personaRef.sourceDeviceId` identifies the default computer and `personaRef.roleId` identifies the persona. Binding, unbinding or switching does not grant or restrict credential permissions. Unbound devices can also call APIs.

Configuration changes apply after the active turn and its queued steering finish. Tools retain the persona PC adopted when the model was created. Old-turn history still targets the original persona and computer. The connection owner PC is the single writable profile authority and may reference another PC in the same authenticated application; changing the source is one compare-and-save operation at that owner, without migrating profile authority.

The user gesture starts ASR synchronously. For a configured device connection, complete utterances arriving during initialization are retained in a bounded raw-input queue. History and the model turn start only after the profile, API tools and device owner initialization are confirmed. Read failures explicitly remain unconfirmed and retain input, rather than being treated as an unbound profile. A confirmed unbound response still allows authenticated APIs; the default package without credentials keeps standalone native model conversation with disconnected tools. Hide, unload or connection scope changes discard old initialization and input. Successful unbinding during an active turn clears its persona and model only at the turn boundary.

## Generic API transport

The model tools are `rabi_api_help` and `rabi_api_call`. Help reads the target PC's `/api/agent/help`; call carries the method, relative path, body and required preconditions. Paths are not a static endpoint allowlist, so new public HTTP APIs can reuse the transport. An optional `targetDeviceId` selects another authenticated PC in the same application. Without it, the tool uses the PC frozen for the active turn. This is connection metadata; personas never filter permissions.

Each target API still enforces its own authorization, arguments, versions and capabilities. Internal service paths, external origins and model-supplied authentication headers are excluded. Persistent event streams and requests beyond size/time limits require suitable target query/job contracts; a bounded HTTP proxy does not prove support for every protocol.

Calls verify `/meta` identity and readiness first; mutations verify identity again afterwards. Before dispatch, writes persist their original intent and stable `Idempotency-Key`. Conflicting payloads using the same ID are rejected. Timeouts, disconnections and repeated old writes require reading the original receipt/resource rather than redispatch. Persona selection never filters API permissions.

Actual tool results now return to the same Rokid model as explicit application observations, allowing help lookup, API calls and continued reasoning from real outcomes. Native result submission remains unverified; the default path does not execute native tool events.

The phone uses the existing encrypted manager-service connection with LAN, P2P, then Relay connection fallback. A dispatched business request is never replayed by changing paths. QuickJS currently provides bounded HTTP Relay capability only; native P2P, streaming HTTP and WebSocket are not claimed. See [generic transport](generic-api-transport_en.md).

## History

Bound devices persist user text in a pending queue before calling the model and append the actual reply when the turn settles. The client freezes the persona and source PC when the turn starts and writes to that PC through generic transport. Relay does not interpret personas or profile revisions. A persisted random device-session seed prevents collisions between glasses with the same local counter; queued records retain their original destination.

PC storage uses the existing persona history with `aiui_user` and `aiui_assistant` kinds. Identical entries deduplicate; conflicting text for the same turn is rejected. Interrupted turns retain received user text without inventing replies; failures stay queued. The phone maps records by source PC and persona to the corresponding conversation history.

## ASR, TTS and steering

Normal AIUI conversation retains native ASR during inference and playback. Non-echo recognized text stops TTS and clears old speech, while inference continues. Later text from that interrupted turn does not resume playback. Final input enters a steering queue and is adopted before the next model decision after the current native request; dispatched tools settle first, without a second simultaneous model request.

This is steering between model steps within the same Agent turn. Injecting guidance inside a single native model request, actual ASR/TTS concurrency and echo rejection in noise require hardware verification. Explicit touch cancellation still cancels the model; voice input and wake words do not take that path.

A tap or supported wake event must call `SpeechRecognition.start()` synchronously before any `await`. The same continuous recognizer receives segments during model work and playback; end or error waits for new interaction instead of a timer restart. The official contract requires interaction for every `start()` and does not exempt later starts after permission. Interim results depend on the host; they stop playback only when actually received.

Conversation uses only `speechSynthesis.synthesize()` and an owned `SpeechAudioPlayer`. Interim text calls the actual player's `stop()`, releases it and aborts the old task. Late synthesis never plays, and later old-stream text remains silent; the next step resumes speech after adopting final guidance. Missing APIs or synthesis failure show an explicit unavailable/failure status without the uncontrollable shared `speak()` fallback, whose `cancel()` and utterance lifecycle events are not exposed officially. Source fixtures establish event and object calls, not simultaneous OEM microphone and speaker operation.

## Remaining complete-Agent contracts

The intended endpoint receives RabiRoute deliveries, invokes Rokid's custom instruction to wake AIUI, processes the message with that same host model and returns a formal response. Two unverified contracts cannot be replaced with claims of completion:

1. Follow the user-confirmed wake path: code triggers a two-finger single tap → the configured Rokid custom instruction → AIUI. The phone CXR diagnostic now asks the glasses component to publish the `com.android.action.ACTION_TWO_FINGER_SINGLE_TAP` ordered broadcast. Component installation, startup and bidirectional custom messages passed on hardware, but broadcasting the gesture returned `dispatch_security_rejected`: the system denied ordinary-app publication. The official chapter documents reception; no supported publishing API has been verified. Automatic wakeup and claiming the original delivery remain incomplete. See the [wake probe](aiui-wake-probe_en.md).
2. Application-observation reasoning is implemented; real-host multi-step behavior, cancellation, duplicates and formal delivery receipts await acceptance. Native result submission remains unverified. See the [tool contract review](agent-tool-contract_en.md).

Until these contracts are verified, no complete Agent adapter is advertised as available and no PC model replaces the glasses-side executor.
