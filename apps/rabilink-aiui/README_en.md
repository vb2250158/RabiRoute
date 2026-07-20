<!-- docs-language-switch -->
<div align="center">
English | <a href="./README.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# RabiLink AIUI

RabiLink AIUI is the Agent messaging surface for Rokid glasses. Its home screen has two modes on one swipeable HUD: `Connect Conversation` and `Configuration Assistant`.

For publishing, phone enrollment, glasses synchronization, and known failures, see [Installation and Troubleshooting](docs/installation-and-troubleshooting_en.md). For requirement-by-requirement status and evidence, see the [Acceptance Report](docs/acceptance-report_en.md).

## Message model

The production path is record-first and uses two independent queues:

```text
Open or resume Connect Conversation
-> the bound Lingzhu agent opens pages/home/index(mode=transcription)
-> foreground AIUI SpeechRecognition renews one recognition round at a time
-> final text passes conservative duplicate and native-TTS echo filtering
-> AIX POSTs rabilink.observation to Relay /rokid/rabilink/input
-> the PC worker appends it to rabilink-conversation.jsonl
-> the upstream item completes without waiting for a Codex reply

Idle review
-> Rabi detects unreviewed observations in the ledger
-> waits for the bound Codex thread to become idle
-> starts a new Codex turn that reads the current JSONL and, when needed, archives
-> remains silent when there is nothing worth interrupting the user for

Continuous reflection
-> can run on a configurable interval even without new transcripts
-> rechecks intent, commitments, plans, time changes, and local Agent results
-> may prepare low-risk work silently and speaks only when the result is useful

Touchpad review
-> a single touchpad click in Connect Conversation requests review
-> starts review immediately when idle or steers the active Codex turn
-> does not pause ASR or switch modes

Agent downstream
-> Codex, a scheduler, or a planner POSTs /api/agent/replies
   targetType=rabilink, proactive=true, routeProfileId=<target-route>
-> RabiRoute output safety gate
-> Relay /worker/messages persistent outbox
-> the delivered Agent record is appended to the same conversation ledger
-> AIX continuously consumes /rokid/rabilink/messages?stream=1 by cursor
-> glasses-native speechSynthesis plays messages in order
```

The upstream queue does not create a page task for each transcript. `taskId` remains only for the legacy direct-message compatibility path. Downstream producers provide a stable `deliveryId`; retries reuse the same Relay item so the glasses do not display or speak duplicate messages.

The shared ledger uses these directions:

- `user_to_agent` for user observations;
- `agent_to_user` for successfully queued Agent messages;
- `control` for touchpad review requests.

When the local date changes or the idle gap reaches `rabilinkConversationSplitAfterHours` (six hours by default), the current file moves mechanically to `rabilink-conversations/YYYY-MM-DD[-NN].jsonl`. Archiving never summarizes or rewrites the original text. Cross-process locking protects append, deduplication, partitioning, and index updates.

Relay retains the application outbox independently of task lifecycle for at least 48 hours. AIUI persists each received batch before advancing `nextCursor`; hiding the page, switching modes, or interrupting TTS therefore does not discard unplayed messages. Queues are isolated by an opaque credential fingerprint so changing the bound application cannot leak observations, cursors, or TTS items across accounts.

## Configuration Assistant

Configuration Assistant remains in the same Interactive InkView:

```text
Swipe to Configuration Assistant
-> AIUI SpeechRecognition captures the complete request
-> native LanguageModel selects an allow-listed execute_configuration_action tool call
   or the outer bound agent invokes mode=configuration with a strict normalized intent
-> the page calls existing Relay mobile/WebGUI actions
-> the HUD displays and speaks the result
-> the next configuration ASR round resumes
```

The page-local `LanguageModel` is a new native model session. It does not recursively invoke the full bound Lingzhu Agent Loop and does not automatically inherit that agent's memory, variables, or plugins. The outer agent may still pass a confirmed strict `intent`.

The page does not own the PC configuration source of truth. Routes, agents, roles, gateways, directories, and process state remain authoritative in RabiRoute Manager and RibiWebGUI. Destructive or externally visible actions still pass through explicit confirmation and RabiRoute safety gates.

The current allow-listed surface covers common Route, Agent, gateway, NapCat, policy, pipeline, profile, variable, notification rule, schedule, network, Manager, and manual-trigger operations. Unknown free-form requests are not converted into arbitrary HTTP calls.

## Current capabilities

- One-page `transcription` and `configuration` tool modes with a JSON Schema.
- Foreground continuous recognition implemented as serialized `SpeechRecognition.start()` rounds.
- Record-only observations with stable client message IDs, timestamps, deduplication, offline persistence, and automatic replay after page reconstruction.
- Conservative whitespace normalization, punctuation-only rejection, short-window exact deduplication, and native-TTS echo suppression.
- Idle review, touchpad steering, and configurable continuous reflection in one bound Codex thread.
- Global cursor-based downstream delivery for ordinary replies and proactive messages, independent of `taskId`.
- Native ASR/TTS adapters and shared DTOs without a paid API fallback or hidden network fallback.
- TTS/ASR microphone handoff: abort recognition before playback, then resume from host lifecycle callbacks or a bounded text-duration watchdog.
- Persistent failed-message handling: after three playback failures an item remains retryable but yields the queue head so later messages can continue.
- Native `LanguageModel` configuration understanding plus a strict outer-agent `intent` entry point.
- Device enrollment with a glasses serial number and an `rbd_` device credential stored in Agent-isolated `localStorage`.
- Relay-backed glasses cloud logs with offline buffering and privacy filtering; transcripts, configuration text, Agent replies, tokens, and passwords are excluded.
- One shared HUD for 448×150 card and 480×352 immersive surfaces, with mode rail, status, latest text, time, release version, and glasses battery state.

## Product boundaries

- Continuous ASR is guaranteed only while the AIUI page is in the foreground. Hiding, exiting, locking, or host recycling stops recognition. This is not a system-level 24-hour recorder or a FenneNote-style Android foreground service.
- AIUI exposes final recognition text, not PCM, audio levels, dynamic noise floor, Whisper probability, custom VAD, prebuffer, or audio segmentation controls.
- Craft browser ASR is a simulator. It accepts text entered through Craft after the microphone is activated; it does not read the PC microphone.
- The glasses reach the bound PC only through RabiLink Relay and never connect directly to a private LAN port.
- Real application tokens are runtime variables. They must not be stored in the AIX package, prompts, repository, examples, or documentation.
- The page does not trust generic browser or phone battery APIs as glasses state. It displays only fresh Relay state reported by the RabiLink mobile CXR status service; stale state becomes `--` after three minutes.
- CXR-L is not part of the AIUI message path and must not proxy AIUI messages, audio, configuration, or cursor state.

## UI and runtime rules

- Maintain `pages/home/index.ink` as the source of truth. Packaging generates the traditional four-file page and bundles local utilities into `pages/home/index.js`.
- Keep one small HUD tree and no `scroll-view`. Large conditional Ink trees and complex scrolling can lock Ink during card-to-immersive resize.
- Grow content upward from the lower edge of the field of view and leave the central real-world view unobstructed.
- Use the single green theme through border, opacity, text weight, and selected fill; do not introduce a second semantic color.
- Treat mode switching as state inside the same page. Do not call `finish()` or create a second page.
- Keep ASR ownership serialized across modes. Do not start two recognition rounds on one instance.
- Do not depend solely on `onReady`; current Craft/Ink hosts do not trigger it reliably. Schedule local-state activation, network startup, and real-device ASR after the first frame from `onLoad`.

## Local verification and packaging

Run these commands from `apps/rabilink-aiui`:

```powershell
npm run check
npm run startup:safety
npm run startup:soak
npm run interactive:resize
npm run interactive:resize:daily
npm run craft:headless
npm run package:aix
npm run readiness
npm run craft:staging
npm run craft:upload:dryrun
npm run delivery
npm run delivery:verify
npm run acceptance:local
npm run goal:evidence
```

`npm run check` covers the Relay contract, configuration action coverage, native LanguageModel tool routing, record-first ASR, continuous downstream delivery, taskless proactive delivery, token-fingerprint queue isolation, TTS/ASR handoff, device state, repeated same-page mode switching, Ink rendering, startup safety, AIX structure, and Craft upload contract.

`npm run delivery:verify` reads the final `dist/rabilink-aiui.aix`, compares its files with the current build, and runs the final package in the real Ink runtime. `npm run acceptance:local` records the local matrix in `dist/local-acceptance.json` and explicitly distinguishes local completion from real-glasses acceptance.

The release name and pending version have one source of truth:

```json
{
  "agentName": "RabiLink",
  "version": "1.0.23"
}
```

This is `craft-release.json`. It is separate from the development package version in `package.json`.

## Relay URL and credentials

To inject a private Relay URL into a private build:

```powershell
$env:RABILINK_AIUI_RELAY_URL="https://your-relay.example.com"
npm run package:aix
npm run craft:staging
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Test-RabiLinkAiuiReadiness.ps1 `
  -ExpectedRelayBaseUrl $env:RABILINK_AIUI_RELAY_URL `
  -RequireCraftStaging
Remove-Item Env:RABILINK_AIUI_RELAY_URL
```

Do not inject a real application token into the build. Production glasses obtain a device credential after the serial number is bound under Relay `/manage`. The page tool `token` parameter is retained only for Craft environments that do not expose a device serial number.

## Craft upload

`npm run craft:staging` produces the only supported import directory, `dist/craft-upload`. It contains one self-contained runtime representation and excludes source `.ink`, utilities, scripts, `node_modules`, package files, and nested build output.

For an authorized CLI upload, use temporary environment variables:

```powershell
$env:ROKID_CRAFT_ACCOUNT_TOKEN="..."
$env:ROKID_CRAFT_ACCOUNT_ID="..." # required when the token does not expose accountId
$env:ROKID_CRAFT_URL="https://js.rokid.com/craft?defaultAgentId=...&region=cn&lang=zh-CN"
# Alternatively set ROKID_CRAFT_AGENT_ID directly.
npm run craft:upload:dryrun
npm run craft:upload
Remove-Item Env:ROKID_CRAFT_ACCOUNT_TOKEN
Remove-Item Env:ROKID_CRAFT_ACCOUNT_ID -ErrorAction SilentlyContinue
Remove-Item Env:ROKID_CRAFT_URL -ErrorAction SilentlyContinue
Remove-Item Env:ROKID_CRAFT_AGENT_ID -ErrorAction SilentlyContinue
```

The upload endpoint returns an SSE stream. HTTP 200 means only that the stream opened. Success requires a `done` event and no `error` event. The uploader derives `metadata.tools` from `pages/home/index.json`; an empty tool definition is rejected even inside an HTTP 200 stream.

If Chrome is already logged in and you do not want to expose the account token to PowerShell, use the same-origin browser helper:

```powershell
$env:ROKID_CRAFT_URL="https://js.rokid.com/craft?defaultAgentId=...&region=cn&lang=zh-CN"
npm run craft:open-embedded-helper
Remove-Item Env:ROKID_CRAFT_URL -ErrorAction SilentlyContinue
```

Paste the generated helper into DevTools on the target `js.rokid.com` page. It uploads the embedded AIX with the existing Craft session, does not print the account token, and can download a sanitized upload report.

Uploading is not the full release flow. The production order is:

```text
upload AIX
-> switch Craft from the local project to the bound cloud project
-> submit for review and wait for approval
-> add or update RabiLink in the Rokid AI App store
-> synchronize the glasses
-> perform real-device acceptance
```

Upload and review submission require explicit account-owner authorization.

## Device and runtime evidence

Useful read-only or local evidence commands include:

```powershell
npm run craft:status
npm run phone:inspect
npm run phone:inspect:deep
npm run phone:inspect:store
npm run runtime:proof
npm run device-status:e2e
npm run goal:evidence
```

`runtime:proof` accepts real application events such as `app-start`, `relay-connected`, `pc-bound`, `webgui-config-loaded`, and `webgui-config-saved`; a local smoke event does not count as glasses runtime evidence. `goal:evidence` rejects stale versions, stale AIX hashes, historical sessions, and incomplete external stages.

Do not install `.aix` as an APK through ADB. The official path is Craft plus the Rokid AI App. Phone-side `.aix` file opening and private management activities are not public installation interfaces.

## Route requirement on the PC

Connecting the PC globally to Relay only marks that Rabi instance online. It does not choose the ledger or Agent for observations. Enable a Route that has:

- kind `rabilink`;
- input and output policies enabled;
- Agent `codex`;
- persona `RabiActive`;
- the correct workspace and bound Codex thread;
- the expected Manager and gateway ports.

Public disabled templates are available under `examples/data/route/RabiLink` and `examples/data/roles/RabiActive`. Copy and adapt them without copying private IDs, credentials, paths, or runtime data into the repository.

## Related documentation

- [AIUI Framework and Logic Development](docs/aiui-framework-and-logic-development_en.md)
- [AIUI Visual Design and Theme Tokens](docs/aiui-visual-design-system_en.md)
- [AIUI Interaction Design and Input Contract](docs/aiui-interaction-design_en.md)
- [AIUI Canvas 2D Quick Reference](docs/aiui-canvas-2d-reference_en.md)
- [AIUI A2UI Boundaries](docs/aiui-a2ui-notes_en.md)
- [AIUI Global Runtime Reference](docs/aiui-global-runtime-reference_en.md)
- [Installation and Troubleshooting](docs/installation-and-troubleshooting_en.md)
- [Acceptance Report](docs/acceptance-report_en.md)
- [Rokid AIUI quick start](https://js.rokid.com/AIUI/guide/quickstart-intro?lang=zh-CN)
- [Rokid AIUI basic APIs](https://js.rokid.com/AIUI/api/basic?lang=zh-CN)
- [Rokid visual design guide](https://js.rokid.com/AIUI/design/visual?lang=zh-CN)
- [Rokid interaction guide](https://js.rokid.com/AIUI/design/interaction?lang=zh-CN)
