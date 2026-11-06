<a href="./README.md">简体中文</a> | English

# io.rabiroute.manager.speech

Built-in Manager plugin. Instance `manager:speech` provides `manager.speech@1`. Its implementation accesses host resources only through `@rabiroute/plugin-sdk` and versioned capabilities declared by the manifest.

This plugin registers 39 executable endpoints: 32 typed operations and 7 exact HTTP proxies. Discovery, parameter decoding and execution share one contract. The common registry decodes normal JSON once; existing services validate business values. Each contract derives its compatibility alias, `speech:METHOD:PATH`, from its own method and path, without another endpoint table.

## Public endpoints

All paths below are relative to `/api/speech`. Typed operation IDs use the `manager.speech.` prefix. Multiple names in one row follow the method order.

| Method | Path | Operation name |
| --- | --- | --- |
| GET | `/events` | `events`, preserving raw SSE bytes |
| GET | `/status` | `status` |
| GET, PUT | `/selection-reader/settings` | `selection-reader.read`, `selection-reader.write` |
| GET | `/models` | `models` |
| GET | `/personas` | `personas` |
| GET, POST | `/speakers` | `speakers.list`, `speakers.create` |
| PATCH, DELETE | `/speakers/:speakerId` | `speakers.update`, `speakers.delete` |
| PUT, DELETE | `/speaker-bindings` | `speaker-bindings.write`, `speaker-bindings.delete` |
| PUT | `/speaker-identities` | `speaker-identities.write` |
| GET | `/playback/status` | `playback.status` |
| GET | `/audio-streams` | `audio-streams.status` |
| GET | `/audio-streams/events` | `audio-streams.events` |
| POST | `/audio-streams/token` | `audio-streams.token` |
| PUT | `/audio-streams/selection` | `audio-streams.selection` |
| PUT | `/playback/volume` | `playback.volume` |
| GET | `/records` | `records.list` |
| GET | `/records/:recordId/audio` | `records.audio`, original finite byte response |
| GET | `/microphone/status` | `microphone.status` |
| PUT | `/microphone/settings` | `microphone.settings` |
| POST | `/microphone/reconcile` | `microphone.reconcile` |
| GET | `/microphone/devices` | `microphone.devices` |
| POST | `/microphone/start`, `/microphone/stop` | `microphone.start`, `microphone.stop` |
| POST | `/playback/stop` | `playback.stop` |
| POST | `/tts`, `/asr` | `tts`, `asr`, original finite byte responses |
| GET, POST | `/messages` | `messages.list`, `messages.accept` |

The following 7 endpoints register separate exact proxy contracts, also using the `manager.speech.` name prefix:

| Method | Path | Operation name |
| --- | --- | --- |
| POST | `/runtime/start`, `/runtime/stop` | `runtime.start`, `runtime.stop` |
| GET | `/model-management` | `model-management.read` |
| POST | `/model-management/runtime/install` | `model-management.runtime.install` |
| POST | `/model-management/models/:modelId/install` | `model-management.models.install` |
| GET, PATCH | `/model-management/settings` | `model-management.settings.read`, `model-management.settings.write` |

This scope contains no static resource or WebSocket endpoints. The original service still supplies `/audio-streams/token`.

## Execution and resource ownership

`SpeechApiOwner` calls the existing `ManagerSpeechControl`, `SpeechRuntimeControl`, `SpeechModelManager`, selection settings and speech message store. Existing services retain models, voices, ASR, TTS, microphone, playback queues, installation jobs and message provenance. The host continues to stamp submitted messages with host identity. Authenticated remote connections can use these public capabilities by default, subject to existing user disables, parameter checks and resource constraints.

Admission captures the original connection identity, selected remote service and compute device. Checks run after waits, before outbound actions and before disclosing results. Revoked connections or changed targets stop the request. `GET /models` and `POST /tts` retain the `computeDeviceId` query parameter. Exact proxies pass the original method, path, headers and body to the captured remote service. Remote failure never falls back to local startup, installation or modification.

Normal JSON preserves native empty-body, content-type and size behavior. The common registry decodes it once before native business validation. ASR preserves the original multipart bytes and boundary, with the existing 27 MiB limit and native transcription content-type validation. The three finite byte endpoints preserve native status, concrete content type, audio bytes and metadata headers, with the existing Node Buffer maximum. SSE preserves comments, `id`, `retry`, multiline data and non-JSON content without reframing.

Model-directory settings PATCH remains an opaque HTTP proxy. The native tunnel and target Manager consume remote bodies; only its local branch uses the original Manager JSON decoder. That branch retains read-only checks, `application/json`, expected generation/Manager headers and native CAS persistence. It accepts exactly `{modelRoot, expectedRevision}`. `expectedRevision` must be a nonnegative safe integer; the original store checks fixed local disks and protected paths and compares revisions under a file lock. GET and PATCH retain `no-store`.

## Lifecycle and validation scope

Candidates only register operations and proxies. They do not change `managerServicesReady` or the active speech reconciliation callback, or start or stop shared speech services. The plugin uses the public `context.publication.add` lifecycle: `publish` synchronously switches the reconciliation callback, `rollback` restores the original callback, and `afterPublish` waits for the previous activation to retire before reconciling speech services. Failed candidates clean up only their own registrations and SSE resources, leaving the original endpoints callable.

Retirement first stops both registries from admitting requests, cancels and joins original SSE producers and accepted operations, including work still running after a client disconnects. Replacement and revision rollback transfer ownership of the same native services to a new activation; old activations do not stop the shared microphone, playback, models or installer. Only an activation that still owns the current reconciliation callback stops these services, checking ownership again after accepted work drains. If cleanup times out while the original shutdown is still running, later candidates must join that shutdown before taking ownership. Installer cleanup continues to wait for the original child process to emit `close` and close stdout and stderr. Failure in one cleanup action still waits for the others before reporting the error.

HTTP 202 acknowledges an installation job. A playback job or successful HTTP response does not prove completed playback, transcript delivery or physical device activity. Inspect the original service state and original job ID before replaying an uncertain write.

Source regression tests cover all 39 endpoints, native TTS/ASR over controlled HTTP, raw remote proxying, connection revocation, compute-target changes, candidate failure recovery, replacement and revision rollback, original work and SSE cleanup after disconnection, and actual installer closure. Executed test reports define the validation scope; installed versions, real models, speakers and microphones require separate acceptance.
