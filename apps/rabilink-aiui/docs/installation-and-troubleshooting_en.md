<!-- docs-language-switch -->
<div align="center">
English | <a href="./installation-and-troubleshooting.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# RabiLink AIUI Installation, Usage, and Troubleshooting

Last verified: 2026-07-16

This document covers the complete RabiLink AIUI path from local source to Rokid glasses, together with issues reproduced in Craft, the Rokid AI App, ADB, the Ink runtime, and RabiLink Relay. When an installation or runtime problem occurs, first use the stage model below to identify the last completed stage, then find the matching symptom.

## 1. Distinguish the Five Stages

```text
Local AIX generated
  -> Uploaded by Craft to the account's cloud project
  -> Cloud project bound to the RabiLink Agent and submitted for review
  -> RabiLink added from the Agent Store on the phone
  -> Synchronized to the glasses with real runtime evidence
```

These stages are not equivalent:

- The presence of `dist/rabilink-aiui.aix` proves only that the local package was generated.
- "Upload succeeded" in Craft proves only that the cloud project received a new version.
- A version can appear in the phone store only after Craft review submission and approval.
- RabiLink appearing in Agent management proves that it has been added on the phone.
- Physical-device runtime is complete only after the glasses display the HUD, access Relay, and leave application behavior events.

## 2. Official Installation and Release Flow

### 2.1 Generate and Accept Locally

Run the following in `apps/rabilink-aiui`:

```powershell
npm run check
npm run delivery:verify
npm run acceptance:local
npm run goal:evidence
```

The local deliverable is:

```text
dist/rabilink-aiui.aix
```

Before uploading, confirm that:

- The AIX audit passes.
- `delivery:verify` reads the final AIX directly and compares it file by file with the source build.
- The package contains no real `rabilinkToken`, Craft token, Cookie, log, screenshot, or private configuration.
- Upload permissions include only microphone, speech recognition, and network access; the current UI does not require camera permission.

### 2.2 Configure the PC RabiLink Active-Intelligence Route

The global PC "Connect to Server" control only registers the computer and proxies the remote WebGUI. An enabled RabiLink Route is also required for AIUI observations to enter the unified ledger and for Codex to proactively deliver without a preceding task:

1. A new workspace includes a disabled `RabiLink` template. If an upgraded environment with existing data lacks it, copy `examples/data/route/RabiLink` and `examples/data/roles/RabiActive` into the corresponding runtime directories.
2. In route configuration, confirm that message endpoints include `rabilink` and that input, output, and `text` capabilities are enabled.
3. Select `codex` as the Agent, select `RabiActive` as the persona, and enter an explicit fixed thread name and Agent working directory.
4. After confirming that no local port conflicts exist, enable and save the Route.
5. Under the global "Rabi Instances" settings, configure the Relay address, application token, and PC identifier, enable "Connect to Server," then use Relay `/manage` to select this communications PC for the application.

The Relay address and token belong only in local global configuration and the Agent variable `rabilinkToken`; do not put them in the Route template. A running Route is required for input to reach the ledger. Proactive downlink also passes through the Rabi output policy and Action Gate at `/api/agent/replies`.

### 2.3 Upload to Craft

1. Open [Craft](https://js.rokid.com/craft?region=cn&lang=zh-CN).
2. Select "Local .aix" from the import menu.
3. Select `dist/rabilink-aiui.aix`.
4. Run the preview and confirm that both the 448 x 150 card and the 480 x 352 HUD after entry can open.
5. Select package/build, then choose the target Agent `RabiLink`.
6. Verify the version and permissions, then upload.

Step 4 must still complete when no local device credential exists. On physical hardware, the page first opens a separate `RabiLink Setup` page. It does not show the mode rail, ASR, or Agent conversation; it shows only the full glasses SN, the Relay `/manage` address, and binding status. The glasses ignore a legacy application token even if the outer Agent still supplies it. The user signs in to the server administration page, enters the SN in the "Glasses SN" field on the target application card, and selects "Bind / Reset." The glasses attempt their one-time device-credential claim every five seconds. After success, they store the credential in `localStorage` isolated to the current Agent and automatically switch to the normal RabiLink HUD. No second enter action or Agent memory variable is required. The page tool's `token` parameter exists only for Craft debugging compatibility when no device SN is available.

#### Two Craft Browser Debug Entry Points

The "Run Agent" control at the top of Craft and `/debug simulate glasses device running the current page` in the chat box are different paths:

- "Run Agent" initializes the current local AIX directly. It verifies only that the page package can create the 448 x 150 card, enter the 480 x 352 InkView, switch modes, and receive simulated ASR.
- `/debug` first calls Rokid's Agent debugging service, which then starts the current page. If logs show a DNS/fetch failure for `agent-q.glasses-prod`, the official upstream service is unavailable; this does not prove that AIX initialization failed.
- When that upstream debugging service fails, the top "Run Agent" entry can still perform page-level regression testing, but it cannot replace physical-glasses acceptance.

The Craft browser does not read the computer microphone. Correct ASR simulation is:

1. Select "Run Agent" at the top.
2. Select the host "Enter" action on the 448 x 150 card.
3. Trigger the Craft microphone/wake control in the Interactive InkView.
4. Enter recognized text in the Craft debugging input and press Enter.
5. Confirm that the page displays the injected `speech.result` in the HUD.

Only a physical glasses host can provide a device serial number and let the page automatically start AIUI-native `SpeechRecognition`. A Craft browser without a device identity must wait for an interactive wake action.

The current local version awaiting release is `1.0.23`. Both the immersive HUD and the 448 x 150 card display `v1.0.23` to the left of the battery, which identifies the package actually running on the glasses. Recheck the actual cloud version in the Craft project list. The cloud name and version are recorded in `craft-release.json`; do not substitute the local development-package version from `package.json` for the Craft release version.

Craft explicitly shows the following after a successful upload:

```text
Upload complete
100%
Upload succeeded!
The Agent has been uploaded.
```

This message does not mean that review has passed or that the Agent has been installed on the glasses.

### 2.4 Switch from the Local Project to the Cloud Project

After upload, Craft may remain in the local project:

```text
Local Project > rabilink-aiui.aix
```

In that state, the top review-submission button is disabled and prompts:

```text
Bind a Rokid Agent first
```

Correct procedure:

1. Select the current project name at the upper left.
2. Find "Cloud Projects" in the project menu.
3. Select `RabiLink <version>`; after this upload, select `RabiLink 1.0.23`.
4. Confirm that the top project name changes to `RabiLink`.
5. Confirm that the review-submission button becomes available.

This is a key distinction confirmed during troubleshooting: a local AIX can be byte-for-byte equivalent to the cloud version, but the local project has no binding to the Rokid Agent. Only the cloud project can be submitted for review.

### 2.5 Submit for Review

Craft review submission has two steps:

1. Confirm the bound Agent, version, and ID.
2. Choose whether a user agreement is required, optionally enter release notes, then select "Submit for Review."

Submitting for review changes state in the Rokid Agent backend. It is an external publishing action and requires explicit authorization from the account owner before automation performs it.

Before approval, an exact-name search for `RabiLink` in the Rokid AI App Agent Store may still show:

```text
No matching Agent found
```

That means the publishing stage is incomplete; it is not a phone Bluetooth or ADB failure.

### 2.6 Add on the Phone and Synchronize to the Glasses

After approval, use the public UI in the Rokid AI App:

```text
Home
  -> Agent Store
  -> Search for RabiLink
  -> Select the plus icon to add it
  -> Agent management at the upper right
  -> Confirm that RabiLink appears in the list
```

Keep the phone connected to the glasses over Bluetooth, follow the synchronization/run path provided by the app, then open RabiLink from the native assistant on the glasses.

The phone is more than an installation entry point. Under Rokid's official AIUI mechanism, network packets from the glasses page are transparently proxied over Bluetooth to the phone app and then sent to Relay; page code still uses ordinary `fetch`. This reduces the glasses' independent networking burden, but does not prove that QuickJS, Canvas, page state, or all ASR/TTS computation moved to the phone. PC RabiRoute still owns the Agent, unified ledger, configuration source of truth, and action safety gate.

The RabiLink phone companion can also report CXR battery status with the same application token and connect phones, watches, and other portable clients through device-neutral APIs. The current AIUI still follows the "glasses page consumes directly; phone transparently proxies network" model. Do not let the phone concurrently consume as the same glasses identity, because doing so may duplicate display or TTS. See the complete architecture in `../../../docs/rabilink-phone-edge-hub.md`.

Do not treat either of the following as installation:

- Pushing `.aix` to `/sdcard/Download` on the phone.
- Using `adb install` on an `.aix` file.

An `.aix` is not an Android APK. The current Rokid AI App exposes no `.aix` file-opening handler; a file in Downloads is useful only for delivery and hash verification.

## 3. Using RabiLink on the Glasses

### Connected Conversation

- Default mode name: `Connected Conversation`.
- While the page is in the foreground, it uses AIUI-native `SpeechRecognition` for one recognition round at a time and automatically starts the next round after `onend`.
- This approximates continuous transcription only while the page remains open. The AIUI page must not be described as a system-level 24-hour background recording service. Capture stops when the page is hidden, exits, or is reclaimed by the system. True lock-screen/background residency still requires FenneNote or an Android foreground service.
- Final text is queued by session, sequence number, and timestamp, then synchronized to the PC through `/rokid/rabilink/input` as `rabilink.observation`. The PC writes it to the unified conversation ledger and releases the upstream item. It does not send every segment to Codex or create a `taskId` that the page must retain.
- The page's offline queue retains up to 2,000 recent segments for up to 48 hours. Final text has whitespace compacted, punctuation-only content discarded, exact duplicates within 2.5 seconds filtered, and highly similar echo briefly filtered after native TTS ends.
- A single touchpad click means "review recent records now." If Codex is idle, it starts a new turn; if Codex is running, it steers the current turn. This action does not pause ASR. A backward swipe switches to Configuration Assistant; the two actions are not at the same interaction level.
- Without a manual click, the PC also reviews proactively after the final transcript segment stabilizes and the fixed Codex thread is idle. The Agent must read the JSONL to distinguish direct conversation, ambient conversation, media audio, and noise, and remain silent when no reply is warranted.
- Even with no new transcription, the PC performs continuous reflection by default every 30 minutes while the thread is idle, checking the user's current goals, obstacles, unfulfilled commitments, plans, time changes, and local Agent results. It may prepare silently and does not imply a spoken report every 30 minutes. Route variables `rabilinkContinuousReflection` and `rabilinkReflectionIntervalMinutes` disable or tune this behavior.
- The page continuously waits on the downlink stream by cursor. Ordinary replies from Codex/other Agents and proactive messages from timers or planners are displayed and played sequentially with native glasses TTS.
- Relay downlink outbox is independent of ten-minute task cleanup and retains data for 48 hours by default. First connection reads retained backlog instead of jumping to the current tail, so Codex may deliver before the glasses page opens.
- When AIUI receives a batch, it first persists up to 2,000 pending playback items for up to 48 hours under the token, then saves `nextCursor`. Hiding the page, switching to Configuration Assistant, or interrupting playback does not remove unfinished items. Returning to Connected Conversation resumes in original cursor order, and an item is removed only after successful TTS.
- Before TTS starts, the page releases ASR; it restores the next recognition round only after the TTS state machine completes, preventing acoustic feedback. The official `speechSynthesis` API currently exposes only `speak(utterance, mode?)` and does not promise complete utterance lifecycle events or `cancel()`. The page uses `enqueue` mode and, when the host does not call `onend/onerror`, applies a conservative watchdog of 1.8 to 90 seconds based on text length so `speechActive` cannot remain stuck forever. The estimate only guarantees state-machine progress; actual playback end time still requires physical-glasses acceptance.
- After one TTS item fails three consecutive times, it remains in the persistent queue but yields the queue head so later ordinary/proactive messages continue. The HUD shows `TTS failed; click to retry`; a touchpad click in Connected Conversation resets and retries the failed item.

Unified conversation data on the PC:

- Current session: `rabilink-conversation.jsonl`.
- User observation: `direction=user_to_agent`; successfully queued Agent downlink: `direction=agent_to_user`; touchpad request: `direction=control`.
- Across a local-date boundary, or after the default six-hour idle gap, the old file moves to `rabilink-conversations/YYYY-MM-DD[-NN].jsonl`. `index.json` records only the file, start/end times, and record count.
- Rotation and index writes use a cross-process lock, and the index is replaced through a temporary file. Even if a process exits immediately after moving a file, timeline reads discover and recover an unregistered date volume instead of hiding unreviewed observations behind a damaged index.
- Archiving creates no summary and does not rewrite original text. When the Agent needs context, it reads the current file first, then reads relevant dated archives through the index.

### Configuration Assistant

- Swipe backward from Connected Conversation, or let the bound Rokid Agent invoke the page with `mode=configuration`.
- The same InkView switches its rail and HUD directly without exiting or requiring another enter action.
- The page stops Connected Conversation ASR first, commits the mode frame, then starts configuration ASR with the same controlled recognizer. The user may describe a request directly; the complete original utterance goes to the native AIUI `LanguageModel`.
- The in-page model can select only existing actions through the `execute_configuration_action` allowlisted `toolcall`. An outer Agent may invoke the page with an explicit `intent`. Both entry points call Relay/PC WebGUI configuration APIs directly and speak the real result; they do not submit a task or poll for an Agent reply.
- Configuration ASR is released while an API executes, the model interprets, or TTS plays. The next round begins automatically after the operation and TTS state machine complete. When uncertain, the model asks a clarification question instead of executing incorrectly or remaining stuck in a processing state.
- Swipe forward, or say "Switch to Connected Conversation." Configuration ASR recognizes this control phrase before invoking `LanguageModel` and immediately restores Connected Conversation ASR on the same page.

### Proactive Delivery

Proactive producers reuse the RabiRoute output safety gate:

```http
POST /api/agent/replies
Content-Type: application/json

{
  "routeProfileId": "RabiLink",
  "targetType": "rabilink",
  "proactive": true,
  "source": "scheduler",
  "targetDeviceKinds": ["glasses"],
  "presentation": ["text", "tts"],
  "text": "Time to take a break."
}
```

After policy checks, the message is written directly to the continuous queue and recorded in the unified conversation ledger as `agent_to_user`. `targetDeviceKinds` and `presentation` are optional. Omitting both broadcasts within the application; explicitly setting `glasses` + `tts` presents it only on glasses through TTS. It does not require a preceding user utterance and does not create a task for the glasses to poll.

Upstream and downstream are independent queues. Once PC Rabi records glasses input, it releases the upstream item; Codex reviews the record while the thread is idle or when guided by the touchpad. A timer, planner, or Codex can also write proactive downlink at any time without upstream input. Downlink uses a stable `deliveryId`, so retry after a lost network response does not duplicate TTS. `taskId` remains only for legacy direct-message compatibility and does not participate in record-only upstream, proactive delivery, blocking, or stream closure.

### Status Badges

- Bottom left: clock icon and `HH:mm`.
- Bottom right: `v<release version>`, battery icon, and percentage; a charging marker appears while charging.
- Display `--` when all real battery sources are unavailable or Relay status is more than three minutes old.

## 4. Reproduced Problems and Confirmed Remedies

| Symptom | Confirmed cause | Correct remedy |
| --- | --- | --- |
| Review-submission button is disabled and asks to bind a Rokid Agent first | The local AIX project is open | Switch from the project menu to `Cloud Projects > RabiLink <version>` |
| Craft upload succeeds but the phone store still cannot find the Agent | Upload is not review submission or approval | Submit the cloud project for review and wait for approval |
| Upload API returns HTTP 200 but the stream reports a missing `tools` definition | `/upload-agent` uses SSE; HTTP success is not business completion, and metadata lacks page-function declarations | Use the current uploader, which generates tools from AIX `pages/home/index.json`; acceptance must observe `done` with no `error` |
| `goal:evidence` or readiness reports `ConvertFrom-Json` failure on a localized report | Windows PowerShell 5.1 reads BOM-less UTF-8 JSON with the system ANSI encoding by default, corrupting non-ASCII text and string boundaries | Read every local JSON file explicitly with `Get-Content -Encoding UTF8`; do not rely on the PowerShell default encoding |
| The phone Downloads directory contains the AIX, but it cannot be opened | The app exposes no `.aix` file handler | Use Craft -> review submission -> store add -> glasses synchronization |
| Explicit ADB launch of `AgentManageActivity` returns Permission Denial | The management Activity is not exported | Enter Agent Store from the Rokid AI App home page, then select the management entry at the upper right |
| `ecology://agent/manage` cannot be resolved from an external intent | The deep link is not open to ordinary external callers | Use in-app navigation only |
| Chrome reports `Not allowed` when selecting a local file | The ChatGPT Chrome Extension lacks file-URL permission | Enable "Allow access to file URLs" in extension details, or use the embedded AIX upload assistant |
| After running the Agent, the page remains at a waiting-for-render state | An old tool schema made the not-yet-bound token mandatory, so the bound Agent never completed the page tool call | Use the current AIX; when no token is configured, omit the parameter and open the page first, then reference `rabilinkToken` after configuration |
| Source Ink tests pass, but Craft still loads an old UI or does not render | `dist/rabilink-aiui.aix` was not rebuilt from the current source | Run `npm run package:aix` again, then use `npm run delivery:verify` to compare the final AIX file by file |
| ASR does not start at the Craft card stage | The card is not an Interactive InkView, and the simulator does not read the real computer microphone | Select the host "Enter" action, then use the Craft text input to simulate recognition results |
| `/debug` cannot run the page, but the top "Run Agent" action works | `/debug` depends on a Rokid Agent debugging upstream service whose DNS/fetch failed | Continue page-level testing through the top entry; record the upstream error separately and do not attribute it to AIX |
| Initialization or entry into the immersive UI hangs | The old page's resize path included complex `scroll-view`, a large conditional tree, synchronous startup work, or concurrent ASR | Keep one page, no `scroll-view`, and a stable node tree; defer network and ASR until after the first frame |
| One swipe skips a mode or switching has no effect | Event sources or direction mappings differ | Support ArrowUp/ArrowDown, ArrowLeft/ArrowRight, Backspace, and Android DPAD consistently; handle duplicate events idempotently according to current mode |
| Browser has no real ASR | Craft uses a text-injection debugging simulator | Verify real microphone capture and automatic startup only in the glasses host |
| The frame flashes during mode switching or ASR updates | The old redraw guard set `opacity: 0` on every `setData`, briefly clearing the whole frame for clock, ASR, and message updates | Use 1.0.16 or later; only mode switching triggers a bounded 1px reflow, ordinary updates do not hide the HUD, and Ink smoke tests must retain bright pixels even at the 8 ms transition sample |
| After packaging, multiple strings overlap at the upper left, and Craft preview may not reproduce it | Before 1.0.15, separate 448 x 150 card and 480 x 352 immersive trees were mounted; Ink 0.13 reused one Canvas during resize and could leave an incomplete old-tree drawing, while old tests counted only total bright pixels and falsely passed | Use `1.0.16` or later; mount one shared 87px HUD tree for both sizes, inspect the pixel bands for brand, mode rail, status, message, and footer line by line, and verify `v<version>` to the left of the battery |
| Configuration Assistant stops after one utterance or waits forever | The official AIUI `speechSynthesis` does not promise `utterance.onend/onerror`; the old page waited for `onend` before releasing `speechActive` and restoring ASR, so a physical host without callbacks remained stuck | Upgrade to 1.0.16 or later; use `AiuiTtsOutputAdapter` with official `enqueue` mode and a bounded text-duration watchdog for TTS/ASR handoff. Regression passes when the simulated host emits no lifecycle event, but estimated duration still requires physical verification |
| One failed TTS item prevents every later proactive message from playing | The old queue left a failed item permanently at its head | In 1.0.16 or later, each item is tried automatically at most three times; it remains retryable but yields the head so later messages continue. A touchpad click in Connected Conversation retries it |
| Upstream remains pending for a long time, or WebGUI configuration occasionally times out after 30 seconds | A remote task may have been claimed, but its completion acknowledgment or a local proxy request can have an uncertain network outcome; the old implementation had no bounded retry | The current version applies timeout retries to local proxy calls and Relay completion acknowledgment. Completion is idempotent, so retry does not duplicate an observation or downlink message |
| Codex sends a message before the glasses open, but first connection does not receive it | Old AIUI used `tail=1` to place the first cursor at the current queue tail, while Relay outbox followed the ten-minute task TTL | Use the current version and deploy the current Relay. First connection consumes retained 48-hour backlog, and task cleanup no longer removes pending playback messages |
| Switching mode, hiding, or re-entering during TTS makes later messages disappear | The old page saved the cursor first and kept messages only in an in-memory TTS queue; `onHide` cleared that memory | The current version persists the complete batch before advancing the cursor; unfinished items resume in original order |
| Offline transcription was saved, but reopening the page never retries it | Old first startup restored only ASR and downlink, and did not immediately flush persistent observations; another utterance or page switch was required | The current version retries the old queue on first foreground activation and reuses the original `clientMessageId` for Relay idempotency |
| After upgrade, omitting the token still reuses an old connection, or switching token exposes old messages | An old package stored manually entered tokens in page settings; cursor/TTS keys included token prefixes/suffixes, and offline observations lacked account isolation | The current version neither reads nor persists tokens. Delayed first startup deletes legacy plaintext fields and migrates old queues to stable fingerprints containing no credential fragment. Observation, cursor, and pending TTS are isolated by fingerprint, so token changes do not cross streams |
| JSONL rotates while Codex is offline, then recovery reviews only the new file | The old reviewer read only the current `rabilink-conversation.jsonl` and omitted archives from its pending cursor | Update RabiRoute. The review range is built from archive index plus current file, so observations unreviewed before rotation remain in the next turn |
| The RabiLink route exits after a `thread/list` timeout in its log | Old background review started Codex checks with a fire-and-forget Promise, turning an app-server timeout into an unhandled rejection | Update and rebuild RabiRoute. Startup, scheduled checks, touch wake, and queued wake all catch failure and record it as deferred; ledger and review cursor do not advance, and the next cycle retries automatically |
| Session duration shows an old value such as `585:00` | Craft reused the prior page state | Reset the current duration to `00:00` in `onLoad`, when Connected Conversation resumes, and when switching back to it |
| A Playwright screenshot is sometimes truncated even though `getImageData` contains the full frame | While Craft continuously renders Canvas, an element screenshot or direct `toDataURL` can race with GPU writes | Freeze pixels with one `getImageData` call, copy them to an offscreen Canvas for encoding, and derive both pixel classification and image from the same buffer |
| Battery displays `--` | No Web/wx battery API is available, phone status is stale, or production Relay lacks the device-status route | Start the phone CXR status service, update Relay, then run `npm run device-status:e2e` |
| Production device-status request returns 404 | Production Relay is still on an old version | Deploy a service containing `/api/rabilink/mobile/device-status`; an unauthorized probe should return 401, not 404 |
| Transcription stops after the page remains quiet for a while | AIUI promises foreground page continuation only, not a background resident service | Keep the page in the foreground; use FenneNote or an Android foreground-service design for lock-screen/background residency |

### Collect Glasses Runtime Logs

Since `1.0.17`, AIUI asynchronously uploads its own runtime state, ASR/TTS/LanguageModel errors, and safe console summaries to Relay. Sign in to Relay at `/manage/<account>` and open "Glasses Cloud Logs" to filter by device, source, level, and keyword. Each record also shows AIX version, mode, and session. Offline logs remain on the glasses for at most 500 entries and seven days, then upload automatically after connectivity returns.

Cloud logs never upload raw ASR text, raw configuration requests, Agent replies, tokens, or passwords. They cover RabiLink AIUI application-level logs, not complete system logs. Android/YodaOS `logcat`, kernel logs, and private logs from other apps still require glasses ADB or a future device bridge with system privileges.

The computer can read live logs only when the glasses themselves appear in `adb devices -l` and RSA debugging authorization has been accepted on the glasses. A phone connected over ADB does not mean the glasses are connected. The current configuration chain emits safe markers that contain no user utterance: `configuration-asr:start/result/end` and `configuration-ai:dispatch:<command>`.

```powershell
$adb = Resolve-Path ..\rabilink-android\out\tools\android-sdk\platform-tools\adb.exe
& $adb devices -l
& $adb logcat -c
& $adb logcat -v threadtime |
  Select-String -Pattern "RabiLink AIUI|SpeechRecognition|QuickJS|InkWebView" |
  Tee-Object .\dist\rabilink-aiui-glasses.log
```

Reproduce one cycle of "swipe to Configuration Assistant -> speak -> wait for the next round," then stop with `Ctrl+C`. If the device list is empty, do not present PC/Relay logs as glasses logs. In that case, use whether Relay received new input only to narrow the investigation.

## 5. Hang Regression Testing

Historical hangs correlated with:

- Reusing the same InkView for the 448 x 150 card and resizing it to 480 x 352.
- Complex `scroll-view`.
- Many top-level `ink:if` nodes suppressing the tree.
- Synchronous storage, network, and ASR work in `onLoad`.
- Immediately rebuilding the recognizer after a fast failure and creating event-loop pressure.

Current implementation constraints:

- `pages/home/index.ink` is the sole maintained source of truth.
- Non-immersive mode has one shared card, and immersive mode has one shared HUD. Mode switching updates one node tree.
- The page contains no `scroll-view`.
- Only mode switching uses a bounded 1px reflow and replays visible HUD fields. Ordinary `setData` updates for clock, ASR, model, messages, and battery do not hide the whole frame.
- Local state, Relay connection, and physical-device ASR resume in stages after the first frame.
- Fast empty ASR endings use exponential backoff; automatic retries pause after five consecutive failures.

Regression commands:

```powershell
npm run startup:safety
npm run startup:soak
npm run interactive:resize
npm run interactive:resize:daily
npm run craft:headless
npm run check
npm run acceptance:local
npm run delivery:verify
```

Do not proceed to physical release if any command fails or if logs contain `apply_ops is still spinning` / `child_sync_parents`.

Craft online redraw acceptance is recorded in `dist/craft-render-acceptance.json`. Mode switching and simulated ASR writeback are sampled continuously for three seconds and classified every 10 ms. Since 1.0.16, a black frame is not treated as an acceptable masking interval; acceptance requires both `partial_frames = 0` and `black_frames = 0`. The current file still describes a historical AIX whose package size, AIX VERSION, and SHA256 do not match the 1.0.23 package listed here. It cannot be used to claim that the current package passed Craft; generate a report for the same package after re-upload. Even an updated report proves only the Craft browser Interactive InkView, not execution on physical glasses.

## 6. Battery and Charging Chain

The page accepts only a status chain demonstrably originating from the glasses:

```text
Phone Rokid CXR GlassInfo
  -> RabiLink Relay mobile device-status
  -> AIUI status badge
```

The phone status service reads only `GlassInfo.batteryLevel / ischarging`; it neither creates a CXR display session nor opens Custom View. Verification command:

```powershell
npm run device-status:e2e
```

The report saves only battery level, charging boolean, source, and time; it does not save the token.

Completed chain evidence includes the phone CXR callback, compiled AIUI reading Relay status, and deployment of the device-status route to the public production Relay. When the phone or glasses are offline, or status is older than three minutes, the page honestly displays `--` instead of impersonating glasses state with browser or phone battery.

## 7. Final Acceptance Checklist

Release and installation:

- [ ] The Craft cloud project title shows `RabiLink`.
- [ ] The review target version is correct.
- [ ] Backend review is approved.
- [ ] RabiLink appears in Agent management on the phone.
- [ ] The phone home page shows the target glasses connected over Bluetooth.

Glasses UI:

- [ ] `Connected Conversation` is selected by default.
- [ ] The rail clearly shows `Connected Conversation / Configuration Assistant`.
- [ ] A backward swipe switches to Configuration Assistant without exiting the page.
- [ ] A forward swipe switches back to Connected Conversation without re-entering.
- [ ] The bound Rokid Agent can invoke and execute Configuration Assistant through an explicit `intent`.
- [ ] After switching to Configuration Assistant, two supported spoken commands are both recognized and executed without stopping after the first.
- [ ] Bottom-left time is correct.
- [ ] Bottom-right battery is correct and the charging marker matches phone/glasses state.
- [ ] The HUD sits at the lower edge of the field of view and does not obstruct central vision.

Business flow:

- [ ] Continuous ASR works across multiple rounds.
- [ ] The offline queue resumes upload.
- [ ] Ordinary Agent replies enter the continuous downlink queue and play through native TTS.
- [ ] With no preceding speech, a `proactive=true` message still wakes the queue and plays.
- [ ] ASR is released during TTS. Even if the host emits no utterance lifecycle event, ASR resumes automatically after the watchdog without truncating actual playback.
- [ ] Configuration Assistant directly executes an explicit configuration instruction supplied by the bound Rokid Agent.
- [ ] Configuration Assistant ASR, native `LanguageModel`, allowlisted tool, configuration TTS, and next ASR round hand off sequentially with no concurrent recognition.
- [ ] High-risk writes still require confirmation.
- [ ] `npm run runtime:proof` produces `proved=true`.
- [ ] `npm run goal:evidence` shows complete.

## 8. Current Field Status

See [acceptance-report_en.md](acceptance-report_en.md) for the complete original-requirements matrix, automated evidence, and final steps after the devices return.

As of 2026-07-14:

- Local 1.0.23 has passed record-first Connected Conversation, automatic observation retry after page reconstruction, the continuous downlink stream, 48-hour offline backlog, persistent observation/cursor/TTS queues isolated by token fingerprint, task-free proactive delivery, native AIUI ASR/TTS adapters, native `LanguageModel` and outer-Agent entry points for Configuration Assistant, watchdog recovery without TTS lifecycle events, yielding the queue head and touchpad retry for bad messages, migration of legacy token caches and fragment-bearing keys, offline retry and two-stage sanitization for glasses cloud logs, the single-tree mode-rail HUD, clock, visible version, real CXR battery, black-frame-free transitions, 125% font pressure, and Ink 0.13/0.14 resize tests.
- `npm run check`, the 21-item `npm run acceptance:local` matrix, and `npm run delivery:verify` passed. Active-intelligence core checks separately verify record-first classification, task-free proactive downlink, unified-ledger rotation recovery, idle/periodic review, and touchpad guidance. Native-voice checks verify capability, shared DTOs, no API key, and no hidden network fallback. Resident-transcription checks verify that FenneNote/named Webhook input enters the same ledger, deduplicates retries by stable ID/producer time, and does not trigger the Agent per segment. Visual regression checks mode-title completeness and left/right safe-zone pixels.
- Craft's top "Run Agent" entry previously initialized a historical AIX successfully. The current `dist/craft-render-acceptance.json` also corresponds only to that historical AIX and is not evidence for 1.0.23. The current 1.0.23 package awaits physical-device evaluation. The upstream Rokid DNS/fetch failure from `/debug` is recorded separately from AIX initialization.
- The VERSION and SHA256 of the final local 1.0.23 AIX must be taken from the freshly rebuilt file for this release; the main package embeds the deployed Relay endpoint.
- A historical run of public Relay + local Rabi + real Codex bound to the `RabiActive` persona passed the record-first bidirectional queues: a no-input proactive delivery took 184 ms, an observation was persisted and released upstream in 435 ms, and real Codex independently replied with a task-free proactive message about 68 seconds after touchpad-guided review. User observation and Agent downlink shared one JSONL with zero duplicates; remote configuration write, read-back, and exact rollback passed. The current implementation added a resident record-first input and a directly executable review-reply contract. Because release version, AIX, implementation digest, or age no longer matches, `goal-evidence` classifies the old report as `stale-live-e2e`; it must not be presented as current proof before an authorized rerun.
- Upload records for historical versions do not prove that 1.0.23 has been uploaded. Re-read the cloud version and review state in Craft.
- Command-line, ordinary-browser, and embedded-browser upload paths now all add `RECORD_AUDIO`, generate/audit the `index` tool automatically, and reject both an HTTP 200 response without `done` and an SSE `error`. Windows PowerShell 5.1 JSON-array serialization has also been dry-run verified.
- Craft review submission becomes available only after switching from the local project to the RabiLink cloud project.
- Craft cloud version, review state, and phone installation state have not been re-read. Do not infer online state from the local package.
- Production Relay has been updated to the service version from this work. Final battery acceptance still requires the phone and glasses to reconnect and provide non-stale CXR status.
- The phone and glasses were physically disconnected on 2026-07-13. Final phone add, glasses runtime, real ASR, and real battery/charging evidence remain incomplete, so the current status must not be described as fully accepted.
- Optional FenneNote resident transcription provides record-first input from the PC microphone and reuses the same JSONL and reviewer. It does not change the AIUI foreground lifecycle and cannot substitute for glasses microphone, background recording, or physical runtime evidence.

## 9. Related Material

- [RabiLink AIUI project README](../README_en.md)
- [AIUI framework and logic development notes](aiui-framework-and-logic-development_en.md)
- [AIUI quick start](https://js.rokid.com/AIUI/guide/quickstart?lang=zh-CN)
- [First immersive AIUI](https://js.rokid.com/AIUI/guide/quickstart-first-immersive?lang=zh-CN)
- [AIUI ASR guide](https://js.rokid.com/AIUI/guide/basic-ai-asr?lang=zh-CN)
- [AIUI SpeechRecognition API](https://js.rokid.com/AIUI/api/ai-speech-recognition?lang=zh-CN)
