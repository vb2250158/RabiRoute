<!-- docs-language-switch -->
<div align="center">
English | <a href="./版本更新日志.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Version update

## 0.1.16 - 2026-07-19

### Structured plan steps and current position

- New plans must now provide a complete ordered `steps` array. An in-progress plan uses `currentStepId` to identify the only in-progress step, and every step must be complete before the plan can be completed or archived.
- Qt plan cards now lead with every step, completed progress, and a `Current: step N` callout, with the current row highlighted. The old six-row preview is gone. Legacy plans without steps show an explicit migration notice instead of deriving progress from two summaries.
- Agent plan summaries, public examples, the plan-tracking skill, and bilingual API documentation now share the structured-step contract, backed by backend and Qt regression tests.

### Standalone mobile endpoint and reliable Rabi Glass conversations

- The Android example is now a complete phone-first Rabi message endpoint. After setup it opens multi-route persona chat, stores text, voice, images, video, audio, and arbitrary files in one private conversation ledger, and treats glasses as optional microphone, speaker, HUD, camera, and touchpad peripherals.
- A phone foreground service owns stable uplink queues, a persistent downlink cursor, ASR/TTS recovery, post-boot message recovery, two persistent notifications, and ordinary Agent message notifications. Every message carries a `routeProfileId` and cannot be broadcast to unselected personas.
- Configuration-assistant requests carry an explicit marker to the selected Rabi PC. Writes, deletion, stop, overwrite, and external actions remain behind the existing safety gates, and completion may be claimed only after a successful API response and read-back verification.
- Relay and Outbox now support bidirectional attachments and attachment-only messages, while public RabiLink identity responses no longer expose the application token. Added the mobile audit command, Relay/Outbox/routing regressions, and phone smoke evidence; physical Rokid glasses validation remains a release gate.

### Smartwatch and fitness-band health endpoint

- Added a dedicated `wearable` endpoint, structured role health timeline, and Manager API for heart rate, sleep sessions, sleep stages, current sleep state, history, 24-hour summaries, and per-device threshold policy.
- Routine observations are recorded without entering chat or waking the Agent. Only high/low heart-rate thresholds or sleep-state transitions produce `wearable_health_alert` events through the existing Route and Agent delivery path.
- Android supports Health Connect. The Xiaomi path adds a phone-configured, dry-run-by-default PC ADB companion, scheduled-task installer, and dedicated Route configurator. Authentication secrets stay in Android Keystore and never enter Relay, logs, or Agent context.
- Added coverage for deduplication, cooldowns, sensitive-metadata removal, Relay allowlisting, Manager queries, and alert delivery. Automation proves the protocol and implementation only; long-running heart-rate and sleep stability still requires real-device validation.

### Rabi Codex Context plugin and knowledge-only Manager mode

- Added the first independently installable `rabi-codex-context` Codex plugin prototype. It explicitly binds a real session ID to a Rabi persona and uses `SessionStart` / `UserPromptSubmit` hooks to inject a bounded persona working set, plan/memory indexes, and a small amount of keyword-matched content.
- Unbound sessions receive no context, and `use`, `status`, `refresh`, and `off` require strict control markers. The plugin neither copies role knowledge nor becomes a second memory source of truth, and it does not require Rabi PC to remain running.
- Manager now supports `RABIROUTE_MANAGER_AUTOSTART=0` for knowledge-interface-only use without starting gateways, Relay, or LAN discovery. Role-panel delivery reports success only after an Agent packet was actually delivered.
- Updated the public Rabi plans and recent memories for the mobile endpoint, wearable health, Codex session binding, and structured-plan contract. Local Rabi context was updated through Manager APIs while private runtime `data/` remains uncommitted.

## 0.1.15 - 2026-07-18

### Character-TTS closure for the speech message endpoint

- Fixed RabiSpeech transcripts reaching Codex while `AgentPacket` omitted mandatory reply-delivery instructions, which left the answer visible in the task without entering TTS.
- A `voice_transcript` from `speech` / RabiSpeech now enters `character-tts-dialogue` state and is forced to `voice_chat`; QQ, the role panel, and ordinary text inputs keep their existing behavior.
- After the handler returns semantically identical visible/spoken text through the normal reply API, Outbox revalidates the source and speech-output policy, freezes the Route persona, voice, model, language, instructions, `sessionId`, and autoplay choice, and enters the host-wide RabiSpeech FIFO. Added AgentPacket and Outbox regression coverage.

### Consolidated RabiPC speech control plane

- Manager now has a dedicated `speechControl` interface and shared camelCase contract for models, personas, audio inputs, microphone, playback, TTS, ASR, and accepted speech messages. Python snake_case, loopback URLs, and model-runtime details no longer leak into Vue pages.
- RibiWebGUI now uses a shared speech client/store, input-level waveform, Route monitor, and event/queue status. The speech page and Route configuration no longer poll independently or duplicate defaults; the backend fills `voice_chat` and speech-variable defaults for speech-enabled Routes.
- RabiSpeech microphone and persona-voice handling gained clearer runtime and failure boundaries, with regression coverage for Manager mapping, the frontend contract, microphone behavior, and persona voices.

### Rabi Glass phone backend and media observations

- The Android example adds a phone-side `RabiGlassPcBackend` and a thin glasses client. Glasses only capture/play PCM, send device media, and render the HUD; they store no Relay configuration. The phone owns Relay, selected PC, cursor, and glasses settings, while the selected Rabi PC owns ASR, TTS, Agent context, and the Action Gate.
- The phone home screen is now a focused glasses companion: duplicate Route/Agent/workspace/thread configuration is removed in favor of remote WebGUI, and cross-transport start/stop controls are idempotent so one recording cannot be submitted twice.
- Relay now exposes allowlisted device-media upload/download paths, stores image, video, and audio attachments per application with a default seven-day expiry, and lets the PC worker materialize only controlled paths before recording public-safe metadata in the unified ledger.
- The speech proxy remains limited to TTS and ASR. It cannot reach remote WebGUI proxying, worker APIs, host microphone control, or arbitrary local paths. The bilingual glasses-route, AIUI residency, and active-intelligence docs were updated accordingly.

### Recent-memory overwrite guard

- `updateRecentMemory` no longer lets a handler overwrite a recent memory that has been inactive for more than 24 hours from stale context. The handler must first read it by ID to refresh the view window, or record a new correction.
- This gate applies only to recent-memory edits; it does not change plans, consolidated memories, raw chat logs, or speech transcripts as their respective sources of truth. Added coverage for rejection before reading and successful update after reading.

### Codex Desktop stable-ID continuation

- Fixed the first routed message reaching the correct task but rewriting Desktop SQLite `title` to the first prompt, which made the second message treat the name-ID pair as stale and create a same-name task.
- A persisted binding now uses full task ID plus normalized workspace as stable identity. An existing unarchived ID in the same workspace is reused without comparing mutable title metadata; name lookup/creation runs only when the ID is empty, invalid, or genuinely missing.
- Settings scans and name resolution now read the short-lived app-server's user-facing task name and cross-check it against Desktop's local task ID and archive state. The app-server still reads metadata only and never receives a real prompt or executes a turn.
- If a saved task is archived, RabiRoute may bind the newest unique active same-name task in the same workspace; with no candidate it fails closed and never creates a replacement.
- Explicitly typing a new Rabi name still clears the old ID before name lookup or idempotent creation. Added repeated-delivery coverage after title mutation and synchronized the integration standard, acceptance contract, troubleshooting guide, and Agent-creation Skill.

## 0.1.14 - 2026-07-18

### Codex Desktop archived-binding guard

- Fixed a persisted Codex Desktop task being mistaken for “missing” after archival, which previously allowed Rabi to create a same-name replacement. Exact-ID reads now preserve archived state and require restoring the original task or selecting another one.
- An archived persisted binding returns a conflict and stops delivery before name lookup or creation. Normal pickers and name lookup still show only unarchived tasks, and idempotent creation remains limited to zero matches.
- Added Manager API and Desktop-state regression coverage and synchronized the bilingual integration standard, acceptance contract, troubleshooting guide, and Agent-creation Skill. Archiving a task can no longer silently change Rabi's delivery target.

## 0.1.13 - 2026-07-18

### Codex Desktop same-name task continuation

- Fixed rebinding when a saved ID is missing, stale, or no longer paired with its name: one or more exact same-name/workspace candidates now bind the unique latest `updatedAt`, and creation is permitted only when there are zero matches.
- A tied maximum or entirely unusable timestamps remain ambiguous and require selection. Resolution never depends on database return order and never creates another same-name task in that case.
- Added resolver and Manager API regression coverage and synchronized the bilingual integration standard, acceptance contract, troubleshooting guide, and Agent-creation Skill. Codex/ChatGPT Desktop remains the only real-message owner; port 4510 lifecycle and the no-fallback-Runtime boundary are unchanged.

## 0.1.12 - 2026-07-17

### Windows installer and GitHub Releases

- Added a per-user Windows x64 installer and portable ZIP pipeline that embeds a pinned Node.js runtime, Manager, RibiWebGUI, production dependencies, and the tray entry, so a clean PC does not need Node.js preinstalled.
- Moved Vue, Vuetify, Pinia, frontend Markdown, and icon fonts to development dependencies so the release payload does not duplicate frontend sources already compiled into WebGUI; production dependencies now contain only Manager runtime packages.
- The installer defaults to `%LOCALAPPDATA%\Programs\RabiRoute` and asks the loopback Manager shutdown API to stop gracefully before upgrades and uninstall. The payload excludes top-level `data/`, and neither an upgrade nor uninstall proactively removes local routes, personas, or logs.
- A `v*` tag now runs tests, configuration checks, tray packaging, release privacy checks, and a packaged Manager smoke test on a clean Windows runner, then uploads the setup EXE, portable ZIP, and `SHA256SUMS.txt` to GitHub Releases.
- Windows binaries are not code-signed yet. The README and packaging guide retain the SmartScreen unknown-publisher warning and SHA-256 verification guidance; code signing, stable/nightly channels, and in-app updates remain future decisions based on real release cadence.

### RabiPC speech endpoint and local models

- Added the standalone local-only `rabi-speech` plugin and RabiPC Speech Service page. TTS and ASR are top-level tabs below Rabi Persona; Route delivery happens only when explicitly enabled, and normal API calls never enter an Agent.
- TTS now covers ONNX-VITS, GPT-SoVITS, Qwen3-TTS 0.6B/1.7B, IndexTTS2, and CosyVoice3. ASR covers faster-whisper tiny/small/large-v3-turbo, Qwen3-ASR 0.6B/1.7B, SenseVoiceSmall, and FireRedASR2-AED. Active providers use installed local models or loopback workers only; cloud speech APIs are absent from the active runtime.
- `GET /v1/models` returns installation/availability state, a request schema, required/optional parameters, and examples for all 13 models. The provider contract remains extensible, while remote requests cannot download models, load code, or change the allowlist.
- TTS supports direct Rabi persona-name calls, persona-owned voice/cache data, multiple voices, and one host-wide FIFO across Routes, sessions, Agents, personas, and models. Resident ASR supports a real audio device, pre-roll, separate record/transcribe thresholds, adaptive noise, silence segmentation, restart restore, and optional Route delivery.

### RabiLink, public boundary, and legacy migration

- RabiLink is the Manager-owned system transport. One generic application token proxies model discovery, TTS, and ASR while RabiSpeech remains loopback-only; public microphone start/stop paths are not allowlisted.
- OumuQ and FenneNote are end-of-maintenance archives. Their TTS routing, persona voices, resident transcription, and threshold controls move to RabiSpeech and the RabiPC speech endpoint; active providers no longer depend on either legacy project or paid cloud APIs.
- Rabi speech Skills now target RabiSpeech and `data/roles/<RoleId>/voice/`. Wiki evidence extraction is limited to voice, emotion, delivery, dialogue examples, and indexes, while `persona.md` remains read-only.

### Downloads, performance report, and Windows runtimes

- Added per-model download guidance and isolated-runtime installers. CUDA/cuDNN DLLs live in plugin-private dependencies and affect only the service process search path rather than the system PATH.
- The performance report covers tested/recommended hardware, model size, cold start/warm-up, warm requests, capability limits, three bar charts for TTS latency, ASR latency, and ASR character accuracy, plus exact dialogue samples. Public cold/warm and Relay-reconnect timings are reported separately.
- WebGUI build, configuration checks, 203 RabiRoute tests, and 16 RabiSpeech tests passed. Runtime WAV files, models, logs, tokens, real reference audio, private paths, and machine configuration remain ignored.

## 0.1.11 - 2026-07-17

### RibiWebGUI product user guide

- Renamed the WebGUI footer entry from Project Docs to User Guide. `/#/docs` no longer treats the developer function map as default product help and now renders the manually maintained Chinese and English Markdown under `docs/user-guide/`.
- Organized the guide around first delivery, interface state, message adapters, handlers, persona rules, operations, safety, and support: nine topics and 18 Markdown files including the landing page. Fifteen placeholders specify the exact future screenshot and callouts.
- Added multi-token full-text search, an on-page outline, locale-aware page selection, Markdown internal links, and shareable `?page=` deep links. Architecture, schemas, APIs, and the function map remain deeper developer material.
- Corrected the public capability boundary against the current UI: Log Diagnostics has manual triggers but no Delivery replay control. Replay remains available through the Manager API and ledger. Updated both READMEs, documentation indexes, capability pages, function maps, and code architecture.
- Updated the public Rabi example's WebGUI plan and recent memory with the new user-guide boundary, and recorded sanitized real screenshots as follow-up work.
- The full build, all 197 automated tests, and configuration validation pass. Browser acceptance covers full-text search, internal links, invalid deep-link fallback, locale switching, and overflow-free layouts at 1600px and 390px widths.
- This changes the WebGUI documentation entry and public guidance only. Route schemas, routing, handler delivery, and Outbox behavior are unchanged, with no runtime migration required.

### README brand story and onboarding path

- Restored the brand-first hierarchy in both README languages with “Let Agents connect everything around us.” as the core slogan, grounded by signals from chat, voice, devices, and time. “RabiRoute does not own the Agent. It owns the context and the gates.” now summarizes the architecture boundary.
- Reordered the README as a product landing page: highlights, the shortest Quick Start, message flow, current capabilities, and deeper documentation. The standalone maintainer-grant framing is gone, while maturity, Outbox, Codex Desktop ownership, and no-hidden-fallback facts remain explicit.
- Updated the public example Rabi and local runtime Rabi product-boundary memory to distinguish the vision slogan from the gateway, routing, and action-gate boundary, so later approval-oriented edits do not erase the project story.
- This change updates public documentation and Rabi project context only. Runtime code, configuration schemas, startup flows, and local runtime data behavior are unchanged; no migration is required.

### MIT open-source license

- Added the standard MIT `LICENSE` at the repository root with `Copyright (c) 2026 vb2250158`, explicitly allowing use, copying, modification, merging, publication, distribution, sublicensing, and sale of software copies under the standard warranty disclaimer.
- Added matching MIT badges and license links to both README languages, and declared `license: MIT` in `package.json` and `package-lock.json`; the license text remains the single source of truth.
- This change affects public licensing and package metadata only. It does not change runtime code, configuration schemas, startup flows, or local `data/`, so no runtime configuration migration is required.

### Three documented RabiLink glasses routes

- Added “Three glasses routes” to RibiWebGUI Project Docs, comparing the native Lingzhu agent, AIUI, and native Android app at the same level through a capability-ownership architecture and a horizontal table covering host, entry, wake/ASR/TTS/HUD/lifecycle/Agent ownership, overall freedom, release cost, fit, and maturity.
- Clarified that all three routes share RabiLink Relay, RabiRoute, the unified conversation ledger, the PC Agent, and the Outbox safety gate. Current guidance uses AIUI as the primary custom experience, the native Lingzhu agent as a lightweight compatibility entry, and the app as the deep-device and independent-lifecycle branch.
- Added reviewed Chinese and English route-selection guides to the documentation index. This change affects documentation and presentation only; Relay, Route, Agent, and device protocols are unchanged.
- Updated the public example Rabi active plan and recent memory with the three routes, capability ownership, the freedom gradient, and the shared-backend boundary so later Agents do not mistake the historical phone-app design for the only main path.

### Six-view tray role-panel layout

- The PySide6 floating panel now exposes Chat, Current, Plans, Recent Memory, Archived, and Diagnostics as first-level navigation destinations instead of hiding the last three in the overflow menu.
- The header removes repeated status text and consistently shows the selected role, Manager/Gateway state, and current Route. The left sidebar remains Route-only; directory actions, manual triggers, refresh, and sidebar collapse remain secondary overflow actions.
- Tray colors and component styling now align with RibiWebGUI's `RabiLight` theme: mist-blue backgrounds, white cards, deep navy text, teal interaction states, 8px radii, and light borders, with complete button, input, menu, focus, and scrollbar states.
- Current is explicitly grouped into in-progress plans and recent memory, while Diagnostics uses a read-only status table. The composer still appears only in Chat, and the plan/memory sources of truth and read-only boundary are unchanged.
- Trigger keywords now use progressive disclosure: collapsed cards keep one responsive line, reveal more complete keywords as width grows, and mark any hidden remainder with `……`; expanded cards reveal the full keyword set.
- Expanded plans now use a clear action-summary layout with Current Step and Next Action side by side. The reader accepts optional source `steps`; when real steps exist it shows completed counts, a progress bar, status-aware rows, and Reveal All, while plans without steps never receive inferred progress.
- Added Qt layout regression coverage for the six primary views, composer visibility, Current grouping, the Diagnostics table, and overflow-menu boundaries.

### Runtime Chinese/English switching in RibiWebGUI

- Added a top-bar `中 / EN` menu. `ribiwebgui/src/i18n/index.ts` is the single locale owner, stores the browser preference under `rabiroute:webgui:locale`, and keeps `<html lang>` synchronized. Locale is a UI preference and is never written to Route, role, or Manager configuration.
- Added manually reviewed English copy, dynamic-status rules, and a DOM localizer for navigation, Console, Message Adapters, Persona, Logs & Diagnostics, Quick Setup, and related dialogs. `data-no-i18n`, code blocks, input bodies, and editable content are skipped; Route/persona IDs, rule names, templates, regexes, task names, paths, tokens, logs, and runtime data stay verbatim.
- User Guide selects the Chinese or English Markdown under `docs/user-guide/` for the active locale and renders it with `marked`, avoiding a third page-content source.
- Added five pure translation tests. The WebGUI production build passes with 626 transformed modules. Browser acceptance covered locale switching, Chinese restoration, Quick Setup, rule editing, public message-adapter settings, and a 700px narrow layout against isolated example data.

### Bilingual open-source docs and examples

- Added manually maintained Chinese/English counterparts and top-level language links across README, architecture, configuration, getting started, troubleshooting, message adapters, RabiLink, AIUI, Android SDK, example personas, and archive guides.
- The English User Guide renders `docs/user-guide/*_en.md` directly instead of creating a third documentation source. Agent runtime semantics, personas, and skills are not mechanically translated.
- The public Rabi example plan and recent memory now record WebGUI locale switching, the tray `RabiLight` theme, and structured expanded plans without including runtime `data/`, real accounts, tokens, logs, or machine-private paths.

## 0.1.10 - 2026-07-16

### Codex first delivery and personality initialization stability

- Newly created Codex Desktop tasks will wait for a limited time before the first real message appears in the Desktop read-only index with the same task ID; a short delay in the index will no longer be misjudged as the task does not exist, and tasks with the same name will not be re-created as a result. After the wait is completed, the real message is still delivered to the task owner only through Desktop IPC.
- Added "Automatic initialization session" to the routing configuration page: first reuse and save transaction parsing or idempotent creation, and persist "visible name + complete task ID + workspace", and then deliver the role file, memory, plan and required reading context to the same Desktop task through the role panel and formal AgentPacket chain. If the save fails, no delivery will be performed. If the initial delivery fails, only the saved task ID will be retried.
- Added a special acceptance contract for Codex Desktop, and added the name and ID rebinding, on-demand scanning, unique owner, no fallback and `127.0.0.1:4510` independent life cycle into Agent creation Skill and project-level Agent access control. RabiRoute does not write `CODEX_APP_SERVER_WS_URL`, does not listen for 4510, and does not close or restart Desktop for delivery.
- Regression covers new task index delay, initialization save/delivery sequence and save failure negative examples; all 195 tests, configuration checks, Codex contract checks, backend builds and 607 module WebGUI production builds passed. In the local Desktop real-machine smoke test, existing session delivery and personality initialization both returned `202`, the message was visible in the bound task, and the number of tasks remained unchanged.

## 0.1.9 - 2026-07-16

### NapCat Group file outbound and controlled build product delivery

- NapCat Outbox's local group file no longer relies on the ordinary message `file` segment, uniformly checks `messageAdapterPolicies.napcat.allowedFileRoots` and then calls OneBot `upload_group_file`, supporting the delivery of large files such as APK.
- After the file is uploaded successfully, you can continue to send the reference text; if the description text fails, the result will still retain the fact that "the file has been uploaded" to avoid repeated uploading of large packages during automatic retries. Added `sentFileName` and optional `sentFileId` to the returned results, and the outbound audit record file size and real path.
- Agent can send local group files through unified Outbox request; runtime routing is open on demand `file` output and configure build product whitelist. Only after the actual API returns success can the file be declared as sent, preventing the processor from directly rejecting delivery due to old text permission assumptions.

### Example Rabi full plan efficiency inspection

- The general "One Plan, One Session Task Continuous Tracking" Skill adds forced efficiency invariants: when the plan is not finalized and there is no effective blocking, the bound session task must be in the starting or running state; heartbeat must enumerate all plans and immediately continue or resume all tasks that can be advanced but are idle, failed, or `systemError`.
- Blocking no longer allows writing just "wait". It is necessary to record the evidence, the person in charge who can relieve the blockage, issues to be confirmed, contact results, review time and actions after the blockage is relieved; take the initiative to find the person in charge for confirmation when the blockage is first discovered, and continue to follow up or escalate if no conclusion is reached by the time limit.
- Example Rabi personality and heartbeat template synchronization requires that "the number of advanceable but idle plans is 0" is met at the end of the inspection. During the runtime, the personality can copy the same Skill and perform confirmation by the person in charge through its own authorized message channel.

### RabiLink Glasses Cloud Log

- Relay adds the `POST /api/rabilink/devices/logs` batch entry for application token authentication, and the `GET /manage/api/device-logs` query entry for account session authentication.
- A new "Glasses Cloud Log" has been added to the management console, which can be filtered by device, source, level and keywords, and displays application versions, modes and sessions.
- Logs are written to `data/rabilink-relay/device-logs/<accountId>.jsonl` by account, supporting stable client ID idempotence, retention upper limit and client/server dual desensitization.
- RabiLink AIUI `1.0.17` Added a new non-blocking offline log queue: retain up to 500 entries for 7 days, and re-transmit 20 entries in each batch after being connected to the Internet; the page is persisted first when exiting, without waiting for the network.
- Cloud logs only include running status, errors, and security console summaries; ASR original text, configuration requirements, Agent replies, tokens, and passwords are not uploaded. Normal AIUI does not have permission to read the system global logcat. System-level logs require future privileged device bridge access to the same entrance.
- Added log storage, authentication, account isolation, desensitization, deduplication and AIUI upload regression testing.

### Codex automatic session parsing and complete list- The Codex drop-down of RibiWebGUI is changed to read all unarchived Desktop tasks, and the first 100 items are no longer fixed, and front-end string comparison is no longer used to hide tasks under UNC, mapped disks or extended paths; the interface still only displays the task name and the last session time, and does not display the internal ID.
- Added unified `resolve` entry: accurate binding of valid IDs; automatic search of illegal/invalid IDs by name and normalized cwd; automatic rebinding of unique matches, empty tasks created with zero matches, multiple returned candidates with the same name for user selection. Neither the user nor the AI ​​needs to manually change the UUID.
- When the old configuration mistakenly writes route names such as `RabiLink` into `codexThreadId`, it will automatically move back to `codexThreadName` at the configuration read boundary; invalid IDs will no longer block name resolution at runtime.
- Windows working directory comparison of uniformly normalized drive letters, UNC, and `\\?\UNC`, while preserving failed shutdown when exact ID exists but cwd conflicts.
- The main routing page and quick configuration share the backend resolver, and creation/ambiguity errors are no longer swallowed silently; `offset` paging is added to the thread bridge list, and documents and Agent access Skills are synchronized to record this historical lesson.
- The native complete package has been rebuilt and installed; the backend is consistent with the WebGUI product, and the running scan verification can read 837 Desktop tasks.

## 0.1.8 - 2026-07-15

### Codex Desktop single task owner (final fix)

> This section overrides all older Codex Desktop IPC, app-server fallback and shared 4510 history below this file; older entries are only used to explain version evolution and do not represent current behavior.

- Real messages from the native `codex` adapter are only delivered to the target task owner of Codex/ChatGPT Desktop through Desktop IPC; the messages, run status, and results appear immediately in the desktop task, inheriting the task's own model, tools, sandbox, and approvals.
- Desktop is a required host for native routing. Fails explicitly when the target task cannot be loaded or IPC is unavailable, does not start the isolated app-server, does not connect to the share 4510, and does not have a hidden fallback.
- Removed the Manager's global ownership of `127.0.0.1:4510`, and the desktop configuration entry that persistently writes to `CODEX_APP_SERVER_WS_URL`; legacy environment overrides will not be passed into the short-lived metadata process.
- Route configuration with internal `codexThreadId` as source of truth. The RibiWebGUI drop-down displays "task name + last session time" but hides the ID; when directly entering a name that does not exist, an empty task is first created, and then the Desktop owner receives the first real message and retains the user name.
- The project-locked app-server can only temporarily create and name empty tasks, and does not receive real prompts or perform turns. The old isolated stdio and shared 4510 scenarios are kept in the archive and marked as failed scenarios.
- Added Desktop IPC owner, deeplink wakeup, precise task ID, working directory verification, no fallback and title preservation regression tests.

### Public example: All plan-plan-session tasks

- Example Rabi has added a new general "One Plan, One Session Task Continuous Tracking" Skill, and its scope of application has been expanded from bugs/problems to all plans such as travel planning, research, design, implementation, writing, troubleshooting, etc.
- Once the plan is created, it is necessary to locate or create a formal session task; read the plan, complete task history and binding memory before each round of processing, synchronize write-back and read-back verification after each round, and only stop tracking when the plan enters the final state of completion, cancellation, invalidation or formal replacement.
- Xinghai Architect's ten-minute group takeover, project approval and deterministic closed-loop scripts are converged into the business adaptation layer: the group takeover is only responsible for observation, public claim and duplication prevention, and the universal plan life cycle is unified and reused as an example Skill.

### QQ source citation and Xinghai group chat readability

- When the Agent replies to the NapCat group chat through the normal reply interface, as long as the sources `messageId` and `replyToSource=true` are provided at the same time, Outbox will automatically generate a real OneBot reference reply; both strings and message segment arrays are supported, and existing reply segments will not be added repeatedly.
- The group chat protocol of Xinghai Constructors has been tightened to "one message only corresponds to one session task": claims, plans, approvals, implementations and QA verifications always refer to the original question, and the module and core phenomenon are clearly stated in the first line of the text.
- Heartbeat can only send a maximum of 1-3 messages with real status changes at a time; it is forbidden to continuously send internal reporting techniques such as "I found it out, plan A, can it be changed like this" without leaving the source.

### Codex mission continuation and investigation authority- Xinghai Task Management Skill adds an unclosed task promotion cycle: heartbeat gives priority to reading the true status of existing tasks, active does not interrupt, idle/failed/blocked continues to the next step, and continues to advance until plan approval, implementation, verification or explicit termination.
- Before creating or continuing a task, you must read the current task history and related old tasks, and inject key conclusions, rejected plans, and unfinished actions into subsequent prompts to avoid repeated investigations of tasks by only looking at the latest news.
- RabiRoute The create/send of Agent thread bridge is changed to `workspace-write` by default; Windows sandbox supports using `danger-full-access` to restore the original task when `CreateProcessAsUserW failed: 1312` appears. Operation permissions are separated from business approval, and only investigation is still allowed before approval.

### NapCat Merge forwarding records

- NapCat adapter adds QQ merge forwarding parsing: identify structured `forward` message segments and `CQ:forward`, and query internal chat records through OneBot `get_forward_msg`.
- The outer original message continues to be saved as an audit fact; the expanded time, sender, text, and image, video, voice, and file tags enter `rawMessage` and structured `forwardedMessages`, which can be read directly by historical search, recent context, and Agent.
- If the query fails, the message will not be lost, only `forward_message_resolve_error` will be recorded; if the query succeeds, the forwarding ID and number of nodes will be recorded. A maximum of 100 nodes are reserved for a single forwarding packet, and the rendered text will be explicitly truncated if it is too long.

### Agent Codex official thread bridge

- Manager adds a native `POST /api/agent/threads` interface to provide four formal thread operations of `list`, `read`, `create`, `send` for background Agents that lack the `codex_app__*` connector tool.
- Thread listing and reads use Codex Desktop task state as the read-only source of truth. `create` uses the metadata process only to bootstrap an empty task; both the initial real prompt and later `send` calls go to the target task owner through Desktop IPC.
- Thread creation and renewal are only allowed to use the current RabiRoute configured Codex workspace to prevent the Agent from starting tasks in any directory through the interface; when creating, the security boundary of "only doing investigations and solutions without authorization" is fixed and injected.
- Creating a thread will return `threadId`, source and `initialTurnStatus`; even if the initial turn fails, the created thread can be retained and retried with `send` to avoid repeated creation.
- The one-question-one-thread rule of Xinghai Builder can call the same Manager thread bridge when the connector tool is not injected; this is a call entry replacement, not a second execution runtime or delivery fallback.

### Heartbeat Busy Protection

- A new `heartbeatSkipWhenAgentBusy` switch is added to the route; after enabling it, when the Codex session is still active/in-progress, this heartbeat record will be `skipped/agent_busy` and will no longer be stacked and delivered to the same session.
- Busy judgment is combined with the latest turn final state of Desktop IPC active tasks and Desktop rollout; it can still avoid stacking heartbeats on the working target task when the process has just started or missed the status change.
- RibiWebGUI's "Message Adapter → Scheduled Trigger" and quick configuration add the "Skip heartbeat when session is working" check option; ordinary group chats, private chats and other message types are not affected.
- Supplement configuration normalization and heartbeat busyness judgment tests, and synchronize configuration documents and project function maps.

### NapCat One-click recovery (2026-07-15)- The routing page converges "Open/Auto-Start" to "Open NapCat": with one click, check the existing session, start the binding instance, use the existing quick login, wait for QQ / OneBot to be ready, and automatically repair the HTTP / WebSocket configuration when the account is logged in but the connection does not take effect.
- No longer restart or log in again when the account is online and the account matches; the health check continues to remain read-only, and side effects of startup, login, or configuration repair will only be triggered after the user explicitly clicks on it.
- Verification codes, new device confirmation, code scanning, and the same account being occupied by other windows are not automatically bypassed; the interface only opens the authenticated WebUI of the correct instance and gives a single-step prompt to the user.
- Added automatic and quick login to OneBot-ready management side regression test, covering binding account selection, WebUI authentication and final health status.
- The remote WebGUI coverage audit of RabiLink AIUI will explicitly list the action interface as a prohibited agent to prevent the glasses configuration interface from bypassing the local user click trigger NapCat startup, login or repair.

### Planning and memory writing specifications

- A new single line `focus` topic field is added to plans, recent memories and accumulated memories; new entries must be filled in explicitly. A plan only advances one goal, and a memory only records one fact, preference, conclusion or problem.
- Added global default and personality level `knowledgeLimits`, which performs back-end hard verification on title, topic, body/steps, source summary, keyword length, number of keywords, and total number of text characters; `400` is returned if the limit is exceeded, and no longer silently truncates.
- Added `GET /api/roles/:roleId/knowledge-validation` for auditing old files and manual changes; GameDailyRabi uses a tighter schedule of 1800, memorizes a total character limit of 1500, and splits strips by single topic in a heartbeat.
- Corrected the role knowledge routing priority, `memory/recent`, `memory/consolidated` and other specific resources are matched before the general `memory/:id`; added interface regression, recent memory reading and writing will no longer be misinterpreted as ID query.
- The daily game steward personality has been written into the single-game queue, authoritative evidence, artificial takeover, lightning simulator, natural resources and Blighted City exclusion rules; independent routing is changed to `8798` to avoid conflicts with existing character ports.

### ChatGPT desktop / Codex integration boundary

- RabiRoute remains stable adapter id `codex`: OpenAI is the provider, Codex is the agent/runtime, Desktop IPC is the transport, Codex/ChatGPT Desktop is the task owner, and the specific GPT version is the target task's own model.
- The official delivery of this machine only passes Desktop IPC; the Desktop is not started, the target task cannot be loaded, or the IPC contract fails to close, the user environment is not rewritten, and the backup execution runtime is not started.
- Fixed the thread to use the complete `threadId` as the identity and continue to verify the working directory; the thread name and last session time are only used for user selection to avoid mistaken delivery to historical threads with the same name.

### Models and safe defaults

- Native Route does not override models, tools, sandboxes or approvals; these capabilities are all inherited from the target Desktop task. Compatible fields `agentModel` / `sandbox` must not make another set of task settings.
- Desktop task approval and tool authorization are still handled by the Desktop owner; RabiRoute does not emulate, relax, or replace these capabilities through a secondary runtime.
- Codex runtime approval is independent of RabiRoute Outbox / Action Gate. Approval of Agent execution does not mean that QQ, documents, devices or external APIs have obtained outgoing permissions.

### Runtime and state reliability- Native Route only scans Desktop installations with Desktop IPC ready status, task discovery comes from Desktop status library, real messages go through Desktop owner start/steer.
- Project root-locked `@openai/codex` only serves empty task metadata bootstrap; standalone Remote Agent bridge owns and locks its own unattended stdio runtime on the remote device, neither is allowed to take over the local Desktop.
- The Remote Agent's stdio client preserves concurrent initialization gates, request timeouts, connection close cleanup, and fail-closed server requests; this boundary does not apply to the native Desktop Route.
- Agent status reporting adds gateway process generation and monotonic sequence; Manager only accepts the status of the current process and is updated sequentially, and clears the old status when starting, stopping, and exiting to prevent old asynchronous results from overwriting the new status.
- Codex scans provide Desktop task candidates; the actual identity is confirmed and persisted with the full `codexThreadId` in the Desktop state and the normalized working directory.

### Remote Agent bridge

- The independent bridge is upgraded to the protocol v3 bidirectional HMAC-SHA256 challenge, and the well-known default password is removed; when not configured, a high-entropy temporary password is generated every time it is started, and the Manager strictly verifies the protocol version, challenge, server proof, and device id.
- Both the remote working directory and the return file first pass `realpath` and are verified by allowing the root/current task cwd to prevent junction or symlink from crossing the boundary; the default file synchronization limit is 10 MiB for a single file and 25 MiB for a single task. The Codex defaults to `workspaceWrite` and the network is prohibited.
- Tasks with the same thread target are serialized to the terminal; there is a limited wait when returning to the active turn, and independent threads are created if they cannot be reused safely. `turn/completed` directly extracts the final `agentMessage` return, failure, interruption, unknown status, system error and app-server exit all fail to close, and no longer relies on network callback to end the task.
- Callback and app-server terminal event deduplication; path attachment only allows current task cwd. Optional `REMOTE_AGENT_PUBLIC_CONTROL_URL` only accepts `ws://` / `wss://` addresses with no credentials, no query/fragment, and fixed control path.

### Documentation and Troubleshooting

- README, configuration, architecture, code map, function map, Agent access skills and troubleshooting documents are unified into the "Desktop single task owner, no execution fallback" caliber.
- Troubleshooting portal checks if Desktop is running, IPC is ready, full task ID, working directory and delivery records; fixes with fixed port or user-level `CODEX_APP_SERVER_WS_URL` are prohibited.
- Old unawakened Desktop IPC, isolated stdio and shared 4510 implementations are moved into archives with failure reasons; the live runtime, API and frontend only accept the canonical adapter id `codex`.

### RabiLink AIUI Craft Delivery Chain- RabiLink AIUI Changed from conversational page tool to immersive application entrance, removed unconsumed `description/schema`; the page was changed to 480×352 single surface navigation, Relay state is separated from credential editing, left and right keys switch surfaces, and up and down keys retain vertical scrolling.
- Fixed the vertical stacking caused by the implicit flex main axis in Ink, all horizontal containers are explicitly declared `flex-direction: row`; the maximum height of the theme is separated from the real 352px surface, and the first screen Relay state is no longer cropped in the real Ink rendering.
- `pages/home/index.ink` is now the single maintained page source. Craft staging and local AIX packaging generate the traditional four-file page through the same pipeline and use esbuild to inline local `utils`, so Craft no longer has to resolve relative modules.
- Local AIX root completion `AGENTS.md`, `.aixignore` and automatically generated UUID `VERSION`; added official Ink 0.14 browser run smoke test with official AIX WASM reader Check the package to prevent "Node check passed but Craft module loading failed" from appearing again.

### RabiLink AIUI Active intelligent closed loop (2026-07-14)- The connection dialogue is changed to record-first observation: Glasses ASR only writes unified `rabilink-conversation.jsonl`, and does not interrupt the Codex sentence by sentence; the fixed thread is automatically reviewed when it is idle, the touchpad click can start the review immediately or steer the current turn, and the cycle reflection will also recheck the user goals and unfinished items when there is no new transcription.
- Codex, timers and planners can be written to active downlink without `taskId` at any time through the Rabi output safety gate; Relay outbox is decoupled from the task life cycle and retained for 48 hours by default. AIUI reads the backlog on the first connection, continues to consume according to the cursor and broadcasts in native TTS order.
- User observation, Agent downlink and review control events are written to the same timeline; they are mechanically divided by date or six-hour slot, and no summary is generated. Cross-process locks, atomic index replacement, and orphaned volume recovery ensure no records are missed when Manager/Gateway is used concurrently with Codex offline across volumes.
- The configuration assistant uses the same page AIUI native `SpeechRecognition` and `LanguageModel`. The model can only call the existing RabiLink/WebGUI configuration interface through the whitelist toolcall; after the TTS is completed, the next round of configuration ASR is resumed, and the outer Lingzhu agent can still pass in strict `intent`.
- The confirmed root cause of "Configuration Assistant stopped after saying a word" in Locating Real Glasses: Official `speechSynthesis` is currently not committed to the utterance life cycle event, and the old page is waiting for `onend`, causing the state to be unable to be released; AIUI 1.0.14 uses the document-defined `enqueue` instead. mode, and use a bounded text duration watchdog to ensure that the ASR state machine continues to advance.
- "Switch to connection dialog" in configuration mode is changed to be processed first by the configuration ASR state machine, no longer waiting for `LanguageModel` understanding; the regression test also asserts that this control statement will not create a model prompt.
- Three Playwright/Chrome Ink tests explicitly allow ephemeral ports assigned by the operating system to avoid `ERR_UNSAFE_PORT` false failures when randomly assigned to the browser's safe port list.
- The persistent TTS queue increases the upper limit of 3 automatic attempts for a single item; bad messages are retained for retry but moved out of the queue, subsequent active messages are no longer permanently blocked, and failed items can be recovered by clicking on the touchpad of the connection dialogue.
- The page will no longer persist the injected token; old plaintext tokens and cursor/TTS storage keys containing first and last fragments will be migrated to stable fingerprints without credential fragments. Offline observation, cursor and to-be-broadcasted TTS are isolated by fingerprint, and switching tokens will not cause misinformation or mis-broadcasting across accounts.
- The review of cursors and running evidence is further tightened: the cursor is atomically replaced with temporary files in the same directory and can be recovered from a damaged state; the running proof only accepts the current version, within 20 minutes, and the combination of startup and Relay/configuration activities of the same page session, and old packages and isolated historical events are no longer misjudged as the success of the current real machine.
- AIX reuses a UUID with the same batch of Craft staging/installation manifests and verifies them file by file; device readiness only accepts CXR evidence within 10 minutes or current direct connection to ADB, and historical power reports no longer pretend to be current glasses connections. Final 1.0.14 still awaits user authorization upload, review, phone addition and real glasses ASR/TTS/touchpad verification.
- Added desensitized `examples/data/route/RabiLink` + `roles/RabiActive` paired templates, and completed the complete sample package readability and port conflict regression; only enable `main`, RabiLink, voice, Xiaoai and enterprise WeChat templates after the first copy sample is configured and then explicitly enabled.
- WebGUI quickly started to fill in the necessary step of "enable PC RabiLink Route", making it clear that the global connection only allows PC to be online before Route decided to unify the ledger, fix the Codex thread and RabiActive personality; use Vue Router for internal jumps, and no longer jump back to the server root path under the remote prefix.
- Cloudflare Worker CORS added AIUI Bearer `Authorization` and mobile target switching `PATCH`; public network and Worker smoke test added no pre-task active delivery, stable `deliveryId` retry deduplication and summing `stream=1` Only consumption verification.
- Added optional `rabilinkRecordFirstSources`: FenneNote or named webhook resident transcribers can use stable message identity into the same RabiLink JSONL as idle reviewerThe callbacks with the same message ID, or the same production-side timestamp and body will be deduplicated and will not create Codex turn sentence by sentence; they will be left blank by default to avoid mistaking the PC microphone for background recording on the glasses.
- The local AIUI acceptance matrix has been expanded to 20 items, and a new resident transliteration record-first item has been added; webhook retries with production-side timestamps but no explicit message IDs also use stable observation identities to deduplicate. live E2E and `goal-evidence` share a list of key implementation files. The report is bound to the release version, AIX SHA256, implementation summary and default 60-minute aging. Reports generated by old deployments or old code will be clearly marked as `stale-live-e2e` and will no longer pretend to be current active intelligent closed loops.### RabiLink PC Global Connection

- `data/Config.json.rabiLinkRelay.enabled` is now an explicit global switch instead of being inferred from the presence of a URL and token. Legacy configuration without the field is migrated using the previous inference rule.
- Manager adds a new resident Relay runtime: immediately registers the PC and acts as a proxy for the remote RibiWebGUI after the global switch is turned on, and no longer requires a certain `rabilink` route to be started first.
- The "Rabi instance" of RibiWebGUI adds an immediately effective "Connect to Server" switch and connection status; when the credentials are incomplete, it refuses to open and retains the original status.
- The route-level RabiLink worker continues to be responsible for receiving message tasks and returning Agent replies; remote WebGUI requests are uniformly received by the Manager to avoid multiple routes competing for the same request.

## 0.1.7 - 2026-07-09

### Active Intelligence General Outline

- Added the proactive-intelligence design note, organizing goals, device responsibilities, event types, intent understanding, action levels, memory systems, mobile apps, local agents, privacy, security, and MVP scenarios into one system overview.
- The document makes it clear that the core of active intelligence is not question answering or single device capabilities, but continuous perception, multi-device context fusion, low-intrusion active decision-making and local Agent execution closed loop.
- Supplement the L0-L5 action level, active behavior scoring model and high-risk operation confirmation boundary to provide a unified product judgment caliber for subsequent RabiLink, mobile app, glasses HUD, behavior log and memory management implementation.

### RabiLink Native active intelligent design

- Added `docs/rabilink-glasses-app-design.md`, converging the next stage of RabiLink into mobile phone resident recording bridge, Relay/local Agent connector, mobile phone configuration console and `Rabi Glass` low-interference HUD.
- The document clarifies that the first version does not rely on the native ASR/TTS of the glasses: the main link first uses mobile phone recording, VAD sentence segmentation, mobile phone ASR, Relay task, PC Rabi worker, RabiRoute `rabilink` route and global downlink messages.
- Retain Rokid/Lingzhu official assistant and existing testing capabilities as compatibility and troubleshooting paths, and store the test entrance as `RabiLink Lab` to prevent the test bench from continuing to occupy the main process of ordinary users.
- Supplement the privacy boundary of resident awareness: explicit opening, continuous status prompts, original audio/pictures not saved for a long time by default, and saving, uploading, delivering, retrying and clearing are designed to be visible and controllable.

### RabiLink AIUI Implementation Progress (2026-07-13)

- Added AIUI example on the glasses side, the product mode converges to "Connection Dialog" and "Configuration Assistant"; the connection dialog uses the glasses' native ASR/TTS, the configuration assistant is normalized by the Rokid native Agent intent, and the page no longer maintains assistant tasks or private ASRs.
- Added `/rokid/rabilink/input` input event and `/rokid/rabilink/messages?stream=1` continuous downward contract; glasses do not hold worker taskId, and ordinary Agent replies and active messages without previous tasks share the application-level ordered queue.
- RabiRoute `/api/agent/replies` supports `targetType=rabilink`, `proactive=true`, and appends active messages to Relay `/worker/messages` through the route output policy; the Manager will pass the actual route/global Relay configuration to the publisher.
- AIUI 1.0.5 has passed source code audit, real HTTP Relay integration, Ink operation, AIX package inspection and 18/18 local acceptance; upload, review, mobile phone synchronization and real glasses ASR/touchpad/active broadcast still need to be independently accepted when the device is available.
- AIUI The page tool no longer sets `token` as required before calling: when `rabilinkToken` is not bound, the HUD is first rendered and displayed waiting for connection. After binding, only variable references are still allowed; finally, the AIX audit will reject the old package, and the real Ink smoke test completely omits the token by default field to override the first time the scene is opened.

## 0.1.6 - 2026-07-08

### RibiWebGUI UI/UX- The quick configuration pop-up window complements the loading during saving, the saving failure prompt and the display of blocking reasons to avoid silent closing or no feedback when saving fails.
- The log diagnosis page puts the culture in the manual trigger area and directly displays the results after the trigger succeeds or fails, making it easier to continue viewing the latest logs from the same page.
- The personality message template rule page adds in-place prompts for routing type wide matching, regular, heartbeat plan and empty template description to help discover high-risk rules before saving.
- NapCat The "Open WebUI" of the QQ instance card will give priority to using the WebUI login Token read by the Manager to open the login address with the token, avoiding the need to manually enter the token when entering NapCat from the Rabi entrance.

### Project Function Manual and Agent Context

- Added `docs/project-function-map.md` and the RibiWebGUI `/#/docs` search page. They index each function's source of truth, consumers, activation point, side effects, code entry, and design boundary for feature work, troubleshooting, and Agent handoff.
- Added `docs/persona-route-workbench-plan.md` to clarify that the personality page should be transformed into a "rule preview and diagnosis workbench for bound routes" instead of a multi-personality smart hit or duplicate routing configuration page.
- `personaConfig.json` Added `recentMessageLimit`, AgentPacket will be configured with the latest message summary according to route/persona; the default is 10, set to 0 to turn it off, and additionally configure the read and write and packet injection tests.
- RabiLink adapter is detached as an independent module, and the Relay worker and local replies query are separated from the general webhook adapter, retaining the general entry responsibilities of webhook/FenneNote/XiaoAi.
- Codex delivery link adds visibility guarantee for Windows Codex App: new listening thread, long-unloaded thread resume, Desktop IPC delivery and app-server fallback will try to start/focus `Codex.exe`, and write the result to the `lastCodexAppVisibility*` diagnostic field.

### Windows desktop startup and full package boundaries

- Windows launcher, tray frozen mode and packaging scripts will check whether the backend `dist/manager.js` and `ribiwebgui/dist` are missing or expired, and automatically build them according to the scenario.
- `docs/windows-launcher-and-packaging.md` is now the source of truth for Windows startup and packaging. It clarifies that `RabiRoute-Tray.exe` is the tray entry in a complete desktop bundle, not a self-contained single-file package.
- The packaging script will output `RabiRoute-Tray.new.exe` when it cannot overwrite the running `RabiRoute-Tray.exe` to avoid the build result from directly failing or misleading users.

### RabiLink Server Console and Remote PC WebGUI- The Relay management entrance is unified as `/manage`. After logging in, enter the "RabiLink Server Console"; the same server supports multiple accounts, and each browser session only maintains one current login account. The applications, tokens, PC Rabi connection records and session status between accounts are isolated from each other.
- The server console displays the PC Rabi instances connected under the current account and provides an "Open PC WebGUI" entry. `/manage/<account>/<RabiGUID>/#/routes` loads the server-hosted RibiWebGUI static frontend and forwards reads and writes through the Relay worker to that PC's local Manager.
- Relay now provides a WebGUI request queue, worker claim/response APIs, HTML/JavaScript/CSS path-prefix rewriting, and configurable body-size and wait limits. The server does not keep a copy of PC configuration; the PC Manager remains the source of truth.
- Application tokens continue to display previews in the console card by default, but the "Copy token" button after login will copy the full token at any time and is no longer limited to a single display window after creation or regeneration.
- Relay tightens the application token master-slave relationship: the old public token no longer participates in RabiLink task authentication. The glasses task must be bound to the Rabi PC currently selected by the application; an error is returned directly when the PC is not selected, the bound PC does not exist, or is offline, and no target tasks will be created that will be claimed by multiple PCs.
- Added `AGENT_TOKEN` OpenAPI public/template import version: the publisher token is not written at the plug-in level, `submitRabiLinkTask` uses body `token`, `getRabiLinkMessages` uses query `token`, and is bound to the respective agent tool parameters RabiLink application token.
- RabiLinkMessage The plug-in description supplements the GitHub instructions link and points to the RabiRoute icon in OpenAPI `info.x-logo` to facilitate the supplement of the introduction and icon after the public plug-in is imported.
- The server console has added a "recent log" card isolated by account: recording plug-in submission, downstream polling, PC Rabi receipt/reply, remote WebGUI request and other desensitized summaries to facilitate confirmation of whether the message reaches the server without exposing the complete token.
- The Relay worker will carry its own PC identity when sending back ordinary message tasks and remote WebGUI responses. The server only accepts the PC Rabi return packet selected by the current application to avoid data cross-talk between multiple PCs under the same account or different accounts.
- The Cloudflare Worker agent no longer supports injecting public forwarding tokens; public/multi-account modes must pass in their respective RabiLink application tokens through plug-in authentication or agent tool parameters, and the test script also uses `RABILINK_RELAY_APP_TOKEN`.
- Relay server no longer reads the old `RABILINK_RELAY_TOKEN`, and the deployment script no longer accepts the old public token parameter; PC workers officially use `RABILINK_RELAY_APP_TOKEN`, the console and mobile terminals no longer automatically select the first PC Rabi, and an error will be clearly returned when the target is not bound.
- The old `/admin` console entry is removed from the Relay server and Caddy deployment configurations, and the official entry only remains `/manage`; the `/webgui` subpath of the remote PC WebGUI is still redirected to the new path as a declared compatible entry.
- RabiLink The worker startup environment is changed to issue `RABILINK_RELAY_APP_TOKEN`, and `npm run relay:rabilink:legacy:check` is added to prevent the old public token, old `/admin` entry and automatic selection of PC logic from being reflowed.
- The runtime configuration field naming is changed to `rabiLinkRelayAppToken`, and the old route-level `rabiLinkRelayToken` is only read as a migration-compatible field; the route fallback name is also changed from legacy to route-level fallback to avoid mistakenly returning to the old semantics in subsequent implementations.
- The old mobile phone App Webhook / WebSocket access solution is clearly marked as a historical document; RabiLink quick configuration, project function map and document homepage are all changed to point to the current Relay main link to avoid subsequent implementation from the old mobile phone bridge solution.
- `npm run relay:rabilink:legacy:check` extended to documentation and WebGUI help entries, preventing old mobile webhook documentation, old "RabiLink direct" naming, or old help links from becoming current implementation entries again.
- `npm run relay:rabilink:legacy:check` Continue to add account isolation guards and fullBureau legacy scan: Console state, log API, application additions, deletions, and remote WebGUI target resolution must be filtered according to the application collection of the current account; old public tokens, old `/admin`, old mobile phone bridge API, automatic PC selection, and old naming can only appear in the history/migration locations of the explicit whitelist.
- The deployment script uploads `ribiwebgui/dist` and the required static assets so the server can host the remote PC WebGUI independently. The old `/manage/<account>/<RabiGUID>/webgui/...` path remains a compatibility entry.

### Mobile APK binding to RabiLink

- Android RabiLink SDK adds server mobile state, PC list, remote Manager configuration, Route list and Codex binding reading and writing capabilities.
- The mobile phone sample APK is adjusted to the main process of "Connect to server -> Select PC Rabi -> Select Route -> Select Codex workspace/session -> Save binding", and LAN scanning is downgraded to a backup diagnostic entrance.
- The default server address of the public example uses the `https://rabi.example.com` placeholder to avoid writing the real service domain name into the submittable source code.

### Rokid Glasses Test APK

- The glasses side test APK is renamed to `Rabi Glass Test`, and uses a pure black background to achieve Rokid optical transparency to avoid the Android translucent window from revealing the launcher or the residue of the glasses main menu.
- The glasses HUD is condensed into a single-line operation bar at the bottom: send text, ping, status, diagnosis, register offline and clear offline. Focus is maintained by an explicit ring index, and the selection is enlarged and centered, no longer falling on the post or title.
- The touchpad/direction key interaction is changed to a "previous/next/confirm" three-action model: sliding only switches the focus once when you let go, and repeated key/touch events will be deduplicated to avoid skipping two buttons with one swipe.
- Before starting the glasses CustomApp, it will try to close the old CustomView, and the Activity uses the stable startup mode and hides the system bar to reduce repeated startups and overlay residues.

### Local verification

- `npm run build` passed.
- `node --check scripts/rabilink-relay-server.mjs` passed.
- `:app:assembleDebug` passed, the mobile phone APK was successfully installed, and the glasses APK was successfully installed after retrying and the CustomApp was started.
- `ar-glasses-gui-design` skill verification passed.
- Online Relay has been deployed and verified that `https://rabiroute.cottongame.com/health` and `/manage` are accessible, and the console page has been updated with "copy complete token at any time" logic.

## 0.1.5 - 2026-07-07

### NapCat WebUI connection maintenance

- The QQ instance card of RibiWebGUI is changed to the active action of "Open WebUI": before opening, the discovered NapCat instance will be automatically added to the configuration, the instance will be enabled, the port and login information will be completed, and the OneBot HTTP/WS configuration will be written when it can be repaired.
- NapCat health check supplements the diagnosis that the WebUI is reachable but does not read the QQ login status, prompting the user to first complete the QR code scan or front-end login in the NapCat WebUI; RabiRoute only maintains the connection configuration and does not replace the NapCat/QQ login.
- The WebGUI build target is adjusted to `esnext`, which retains the current front-end syntax output and avoids incorrect downgrading of modern syntax during the build phase.
- `.gitignore` Add root directory `.venv-tray/` to prevent native tray packaging virtual environments from entering submission candidates.

### RabiLink Relay direct connection- RabiLink The main link is adjusted from "mobile phone bridge transfer" to "computer side RabiLink worker directly connected to the public network Relay": Rokid/Lingzhu plug-in submits the task to Relay, and the PC where Rabi is located directly receives the task and delivers it to the current RabiRoute/Codex Route and write incremental replies back to Relay.
- Relay server adds server side `/admin` WebGUI: supports first-time account registration, account and password login, creation/start/stop/delete RabiLink application, regeneration of independent `rbl_...` application token; the complete token is only displayed once when creating or regenerating.
- The Relay task queue is identified and isolated by application token. Rokid/Lingzhu plug-in, computer-side worker, task message query and global downlink message list can only access the tasks of the corresponding application; the old `RABILINK_RELAY_TOKEN` was only reserved as a compatible global token at that time, and has been abandoned from RabiLink task authentication since 0.1.6.
- WebGUI's `rabilink` endpoint adds Relay address, token, device name, collection wait, and reply idle-timeout settings. The token is saved in private local `data/route/<config-name>/adapterConfig.json` and is no longer written to the public example.
- The formal interfaces of Relay workers are unified into `/worker/tasks`, `/worker/tasks/<taskId>/messages`, `/worker/tasks/<taskId>/finish`, and no longer rely on `/phone/tasks`.
- Rokid/Lingzhu side continues to use global downlink `/rokid/rabilink/messages` to pull messages: no taskId is required, pull it one sentence at a time, each message has its own taskId, until the PC worker finish ends this round.

## 0.1.4 - 2026-07-06

This update merges the RabiLink mobile bridge, Rokid/Lingzhu public network relay, Android probe engineering and delivery compensation capabilities into the public engineering structure of RabiRoute, and cleans up the old `android-band-probe` / `vela-band-probe` example naming.

### RabiLink bridges with Rokid- Added `rabilink` message side configuration: support `/rabilink` inbound, independent `rabilink` route kind, `rabilink-voice-transcripts.jsonl` record, RabiLink dedicated outbox reply file and WebGUI quick configuration, no longer confuse mobile bridge messages as ordinary `voice_transcript`.
- Added RabiLink Relay service script, deployment script and Rokid OpenAPI example, which are used to transfer Rokid/Lingzhu Cloud plug-in to mobile phone RabiLink via public network relay, and then send it to computer RabiRoute/Codex.
- Rokid/Lingzhu plug-in public OpenAPI is changed to continue to pull downlink messages through the global `/rokid/rabilink/messages`, and the glasses end is no longer required to press `taskId` to pull; each downlink message comes with `taskId`, and the glasses end should be pulled to say one sentence until Rabi/Codex The side is completed and then finished by the mobile phone bridge.
- The default long polling waiting time of the Relay server is uniformly adjusted to 60 seconds, covering Rokid request waiting, task messages pulling, global downlink message pulling and mobile phone bridge picking tasks, reducing frequent empty polling on the glasses side.
- Mobile phone bridge finish will wake up Rokid global downlink long polling even if it does not come with the final text, to prevent the glasses end from continuing to display thinking when "it has ended but there is no new sentence".
- Added a dedicated OpenAPI for "Import Tool" on the Rizon plug-in details page: `data/rabilink-relay/rokid-rabilink-tools-import.CURRENT.openapi.json`; it only imports `submitRabiLinkTask` and `getRabiLinkMessages` to avoid the old taskId debugging tool from affecting formal agent polling.
- Added the preferred Postman Collection for "Import Tool" on the Rizon plug-in details page: `data/rabilink-relay/rokid-rabilink-tools-import.CURRENT.postman.json`; used to bypass the occasional URL prefix conversion misjudgment when importing the Rizon OpenAPI tool. The Postman tool import is changed to a complete HTTPS URL, no longer using the `{{base_url}}` variable, and providing a URL import entry through `/rokid/rabilink/tools.postman.json`.
- Added Android RabiLink SDK and `examples/android-rabi-link-probe/` test projects to uniformly carry Xiaomi Health, Rokid, RabiRoute manager discovery and relay bridge probes.
- RabiLink webhook adds a new `/rabilink/replies` read-only packet return interface. The Android mobile phone bridge reads the Codex/RabiRoute reply from the callback service to avoid relying on only binding the local Manager port in a LAN environment.
- Android RabiLink probe enhances resident bridge status display, bridge log echo and scan button status; LAN scanning and public network Relay bridge operation are independent of each other. Repeated clicks will be disabled during scanning but the running bridge will not be blocked.
- Added `examples/rabi-link-vela-probe/`, replacing the old Vela bracelet probe naming.

### Delivery Compensation and Desktop Reliability

- Codex Desktop IPC adds wakeup, app-server fallback and delayed retry logging when encountering `no-client-found` to reduce message loss when the target thread is not loaded.
- Forwarding adds delivery replay ledger, route delivery result log and manager replay API to facilitate replaying failed or missed delivery messages from the WebGUI/diagnosis.
- The Windows tray startup script supports locating Node from environment variables, project directories or workspace `tools`, and avoids accidentally killing Qt tray parent and child processes.
- Added health/message-adapter watchdog startup script and tray icon packaging configuration.

### Public security- RabiLink relay, Rokid OpenAPI, Android probe default values ​​have been desensitized to placeholder domain names, empty tokens or sample paths.
- The active RabiLink OpenAPI import is now a runtime file under `data/rabilink-relay/` and is ignored by Git. The repository keeps only sanitized examples under `examples/rabilink-relay/`, preventing real domains, server addresses, or token-related runtime configuration from being published.
- `.gitignore` Add root directory `.tmp/`, `out/`, `reports/` and tray exe backup exclusions to avoid submitting native run output.
- Public example Rabi persona adds RabiLink bridge boundary memory; native Rabi run memory also records synchronously but does not commit.

### Local verification

- `npm test` passed, 86 tests covering paths such as RabiLink outbound, delivery replay, Codex IPC fallback, route configuration, NapCat/WeCom, memory and role skills.
- `npm run build:backend` passed.
- `npm run relay:rabilink:openapi:check`, `npm run relay:rabilink:worker:check`, `node --check scripts/rabilink-relay-server.mjs` and `git diff --cached --check` pass.
- RabiLink OpenAPI cleaned up and ran again `npm run relay:rabilink:openapi:check`, `node --check scripts/rabilink-relay-server.mjs`, PowerShell deployment script parsing and `git diff --check`, all passed.
- RabiLink After the tool import is changed to the Postman Collection preferred, run `npm run relay:rabilink:openapi:check`, `node --check scripts/check-rabilink-openapi.mjs`, skill quick validate and `git diff --check` again, all pass; `git diff --check` only prompts the workspace CRLF newline conversion.
- The local Relay smoke verification passes: submit the task, write/finish on the mobile phone side, and pull the Rokid end from the global message queue to the downstream message with `taskId`; the second task will not reread the historical messages of the first task.

## 2026-07-06

This update puts the RabiRoute dedicated GitHub pull/submit check skill into the warehouse, making it easier for agents on other computers to directly reuse the same set of collaboration rules.

### Agent collaboration

- Added `skills/rabi-github-pull/` to record how to check the local status, read the update log, backup the runtime configuration before pulling, and upgrade the local configuration according to `examples/data/` and migration instructions.
- Added `skills/rabi-github-submit/` to document how to check changes before committing, update the project log, synchronize Rabi local/public example context, and avoid committing runtime private data.
- The description documents of `rabi-github-pull` and `rabi-github-submit` retain the original pull, migration, desensitization, submission and push rules to facilitate direct reading and reuse in the Chinese collaboration environment.
- The README directory structure supplements the two GitHub collaboration skill entrances to facilitate discovery after cloning the repository in the new environment.

### Local verification

- `git diff --check` Passed.

## 2026-07-04

This update adds Xiaomi Band/Xiaomi Health Data Probe handover data, making it easier to continue to verify "whether the Android APK can pull the complete heart rate list" on another computer.

### Xiaomi bracelet probe- Added Android test APK project `examples/android-rabi-link-probe/`, used to detect BLE, Health Connect, Xiaomi Health local Provider and Xiaomi Health Cloud SDK/OAuth data link.
- Android probe supports Xiaomi Health Cloud default heart rate type pulling, full SDK data type deep scanning, paging/sharding pulling, raw HTTP recording, automatic saving ZIP, sharing ZIP, completion notification and diagnosis summary.
- Added Vela fast application probe project `examples/rabi-link-vela-probe/`, which is used to verify the basic capabilities and interconnect communication boundaries of wearable end fast applications.
- Added handover document `docs/xiaomi-band-heart-rate-probe-handoff.md`, recording current conclusions, build commands, mobile phone independent test process, ADB test process, ZIP parsing method and blocking points.
- Updated `.gitignore` to exclude Android/Vela build products, logs, decompilation output, node_modules, APK/RPK and native heart rate results package.

### Current verification status

- Ordinary APK direct reading of Xiaomi Health Provider is still subject to permission restrictions; `heartrate/recent` only proves that it can read the latest heart rate.
- Health Connect currently does not read the data written by Xiaomi Health.
- The full heart rate list of Xiaomi Health Cloud still lacks the `mi-health-cloud-*.zip` evidence package exported by the real mobile phone, which has not yet been certified.

### Local verification

- `examples/android-rabi-link-probe/scripts/Export-RabiLinkProbeApk.ps1 -Build` Passed, debug APK generated.
- `examples/android-rabi-link-probe/scripts/Convert-MiHealthCloudJsonToMarkdown.ps1` Verified raw dataSource / dataPoint parsing with mock ZIP.
- `adb devices -l` is continuously empty on the original machine, and the actual machine verification needs to be continued on the new computer.

## 2026-06-30

This update adds the Enterprise WeChat/WeCom intelligent robot message terminal, allowing RabiRoute to access group chat messages through the Enterprise WeChat WebSocket long connection, and send them back to the original Enterprise WeChat group chat through the unified outbox.

### Enterprise WeChat messaging terminal

- Added `wecom` message adapter, `wecom_chat` pipeline preset and `wecom_message` route kind; enterprise WeChat messages will be written to `wecom-messages.jsonl`, and then enter forwarding, RouteDecision and AgentPacket.
- Added `src/wecom.ts` SDK packaging to centrally handle enterprise WeChat intelligent robot connection, text/Markdown sending, media uploading and sending, and error normalization.
- `/api/agent/replies` supports postback to enterprise WeChat group chat according to `replyContextJson` or explicit `adapterType: "wecom"`, and adheres to the output switch and payload type restrictions of `messageAdapterPolicies.wecom`.
- Manager and RabiWebGUI add new enterprise WeChat configuration, status scanning, message log and adapter log views; WeCom does not declare the local ingress port.
- Added `docs/wecom-integration.md` and `examples/data/route/wecom/adapterConfig.json`, public examples only use placeholder Bot ID, secret and local path.

### Local verification

- `npm test` Overrides WeCom pipeline, gateway config model and outbox return paths.
- `npm run build:backend` passed.
- `git diff --check` Passed, Windows workspace CRLF prompt only.

## 2026-06-18

This update adds a searchable Skill Library to the Rabi character context, so that the skills in the character directory can be recalled as lightly as plans and memories.

### Character skill library- Added `skills/*.md` convention to the role directory; each skill uses Markdown body and frontmatter, including `id`, `title`, `summary`, `keywords`, `updatedAt` and `status`.
- `roleKnowledge` will read skill meta-information and incorporate `role_skill` into the same set of lightweight recall and pre-processing confirmation processes in planning/memory.
- AgentPacket injects `id + title + summary + GET path` for available and matched skills, but not the skill body by default.
- Manager adds new read-only interfaces `GET /api/roles/:roleId/skills` and `GET /api/roles/:roleId/skills/:skillId`; the list returns meta information, and a single query returns the complete text.
- Added companion response, RabiRoute description and configuration troubleshooting three example skills to the public Rabi example, and updated the Agent interface and context injection documentation.

### Local verification

- `npm run test` Passed, covering the paths of skill meta-information reading, skill recall, and AgentPacket not injecting skill text.
- `npm run build:backend` passed.

## 2026-06-18

This update adds file transfer capabilities to the remote Agent, allowing the host to send files along with the task, and the remote end can also bring product files back to the local machine.

### Remote Agent File Transfer

- `/api/remote-agent/tasks` supports `filePaths`, `files` and `attachments`; the manager will read the content of the local file and send it to the remote bridge through the authenticated WebSocket control channel along with the task.
- The remote bridge will save the task file to the remote runtime inbox directory, and list the file name, size, sha256 and actual path in the remote Codex task prompt.
- Remote callback supports `artifactPath`, `logPath` and `files[].path`; bridge will read the content of the remote local file and send it back to the manager.
- Manager will save the returned file to `data/remote-agent-files/<taskId>/`, and record the local save path, size and sha256 in the task event `savedFiles`.
- File transfers have no size limit by default; if you need to protect a specific deployment, you can set the limit explicitly via `REMOTE_AGENT_FILE_SINGLE_LIMIT_BYTES` and `REMOTE_AGENT_FILE_TOTAL_LIMIT_BYTES`.
- The Bridge control port will verify that `127.0.0.1:<port>/health` is indeed returned to itself; if the local loopback is occupied by the old service, the port will be automatically postponed to prevent the remote Codex callback from hitting the old process.

### Local verification

- `node --check plugin-adapters/remote-agent-rabiroute/index.mjs` Passed.
- `node --import tsx --test src/messageEndpoints/remoteAgentManager.test.ts` passed.
- `npm run build:backend` passed.
- Started the native bridge through the Rabi Manager API, scanned connections, posted messages and files to the Codex session in the project root, and successfully returned `result.txt` containing intact non-ASCII text.

## 0.1.3 - 2026-06-18

This update corrects the NapCat WebUI port probing and health check backfill behavior, and upgrades the project version from `0.1.2` to `0.1.3`.

### NapCat Health Check

- NapCat The health check request will carry the gateway id and instance id, so that the manager can accurately backfill the detection results to the corresponding instance.
- Manager will read the actual port in NapCat `webui.json` and try to correct it to the actual port of the local machine when the configured WebUI address is unreachable.
- Health scans and single health checks will write the corrected WebUI address back to the adapter configuration, and explain the automatic correction results in the response diagnostics.
- RabiWebGUI will give priority to the corrected WebUI URL returned by the backend to prevent the frontend from continuing to save expired ports.

### Codex thread discovery- Codex App will traverse the threads with the same name and select the first readable thread to reduce the misjudgment of duplicate threads when the latest thread with the same name is unreadable.
- Desktop IPC fallback calls revert to normal app-server delivery, with the Codex App itself handling readable thread selection.

### Version and Verification

- The project version number is synchronized to `0.1.3`, covering `package.json` and `package-lock.json`.
- `npm test` passed.
- `npm run build` passed.
- `git diff --check` Passed, Windows workspace CRLF prompt only.

## 2026-06-18

This update fixes the issue where the remote Agent occasionally encounters `Remote Agent connection timed out` when multiple network cards, VPNs, or LAN address announcements are inconsistent.

### Remote Agent control connection

- After Rabi manager scans the remote bridge, it will give priority to using the actual source IP of the UDP discovery response to splice the WebSocket control address, instead of fully trusting the host self-reported by the bridge.
- The remote bridge control port still comes from the real port in the discovery response; the process of automatic port deferral and the GUI eliminating the need to manually fill in the port remains unchanged.
- Added a new regression test to cover the control URL generation when "bridge self-reported address and actual source address are different", reducing the probability of successful scan but connect timeout in a multi-network card environment.

### Local verification

- `npm test` passed, 62 tests covering remote Agent password handshake, control URL generation, task attribution, NapCat startup plan, configuration migration, message return, plan/memory recall and gateway config model and other paths.
- `npm run build:backend` Passed.

## 2026-06-17

This update adjusts the remote Agent to the unattended mode of "RabiGUI master scan and connect", and no longer requires the remote plug-in package to configure the manager address or token.

### Remote Agent master connection

- `plugin-adapters/remote-agent-rabiroute` Zero-configuration startup: default password `123456`, control port automatically finds available ports starting from `8797`, UDP discovery automatically selects available ports from `8798-8818` range.
- Rabi manager adds `/api/remote-agent/scan`, `/api/remote-agent/connect` and `/api/remote-agent/disconnect`, and RabiGUI scans the LAN remote bridge, enters the password to connect and remembers the password.
- The remote Agent password is passed through the WebSocket first packet handshake, and URL query is no longer included; the task result still verifies the device ownership, and the local Codex callback only accepts local requests from the remote machine.
- The remote Agent message panel of RabiGUI has been changed to "Scan LAN -> Select device -> Enter password -> Connect" and does not provide port input; port occupation is automatically handled by bridge and manager scanning.

### NapCat Start reliability

- NapCat Automatic startup will recognize the outer shell launcher, give priority to the inner `launcher-user.bat`, and fill in the `-q` quick login parameter if there is a botUserId.
- The startup and restart interface will wait for OneBot `/get_status` or WebUI to be reachable before returning results. When timeout occurs, diagnostic information will be brought back to RabiGUI.
- Added NapCat launch plan unit test, covering outer shell redirection and existing quick login parameter retention.

### Local verification

- `node --check plugin-adapters/remote-agent-rabiroute/index.mjs` passed.
- `npm run build:backend` Passed.
- `node --import tsx --test src/messageEndpoints/remoteAgentManager.test.ts` Passed.
- `node --import tsx --test src/messageEndpoints/napcatManager.test.ts` Passed.
- `npm test` passed, 61 tests cover the remote Agent password handshake, NapCat startup plan, task attribution, configuration migration, message return, plan/memory recall and gateway config model and other paths.
- `npm run webgui:build` passed.

## 0.1.2 - 2026-06-16This update corrects the fallback behavior of Codex Desktop IPC when no desktop client accepts fixed threads, and upgrades the project version from `0.1.1` to `0.1.2`.

### Codex Delivery

- Desktop IPC allows the app-server fallback to be used when encountering `no-client-found`, so that delivery can continue even when there is an existing bound thread and no desktop client.
- App-server fallback can force the creation of a new thread when an unreadable duplicate thread with the same name is clearly encountered to avoid unreadable duplicate threads blocking necessary delivery.
- Clear `lastNotificationError` and `lastNotificationErrorAt` to empty strings after successful delivery to ensure that the status file does not retain stale error values.

### Testing and Versioning

- Added `src/codexDesktopIpc.test.ts` to override the default behavior of allowing fallback and environment variables to turn off fallback.
- The project version number is synchronized to `0.1.2`, covering `package.json` and `package-lock.json`.
- `npm test` passed.
- `npm run build:backend` passed.
- `git diff --check` Passed, Windows workspace CRLF prompt only.

## 0.1.1 - 2026-06-16

This update completes Codex delivery, manual trigger execution context and XiaoAI bridge default port, and upgrades the project version from `0.1.0` to `0.1.1`.

### Codex delivery and trigger context

- The Windows tray will URL-encode the gateway id before manually triggering the manager API to prevent special characters from damaging the `/gateways/:id/manual-trigger` path.
- Codex App / Desktop IPC Delivery uniformly uses explicit model selection functions and no longer reads the native Codex configuration file as an implicit default.
- When Codex App finds a thread with the same name but the current channel is unreadable, it will refuse to automatically create a duplicate thread to avoid spreading messages to multiple listening threads with the same name.
- Codex Desktop IPC allows app-server fallback by default, but will give priority to refreshing the discovered listening threads to avoid automatic creation when there are already threads.

### Agent Packet and XiaoAI

- Manual triggering and heartbeat events inject execution requirements, reminding the handler to execute in the current Codex session and output visible results.
- When `plan-*` is referenced in the manual trigger template, the active/archived plan summary in the role directory will be read and the specified plan content will be injected.
- XiaoAI bridge default port is adjusted from `8798` to `8799`, and the local speaker direct playback branch in the current configuration is removed.

### Version and Verification

- The project version number is synchronized to `0.1.1`, covering `package.json` and `package-lock.json`.
- `npm test` Passed, 56 tests covering forwarding, configuration warehouse, Agent packet, heartbeat schedules, route identity and gateway config model.
- `npm run build:backend` Passed.
- `py -m py_compile desktop/tray-task-window/rabiroute_tray/manager_client.py` Passed.
- `git diff --check` Passed, Windows workspace CRLF prompt only.

## 2026-06-16

This update fixes the startup and discovery self-healing capabilities of the remote Agent bridge, preventing the remote device from registering until the manager is ready and discovery happens to get the correct network card address.

### Remote Agent connection reliability- `plugin-adapters/remote-agent-rabiroute` Upgrade to `0.1.1`: The bridge will save the selected manager, continue LAN discovery in the background, retreat and reconnect after disconnection, and keep running when the manager is not found for the first time and wait for subsequent online.
- Bridge discovery now simultaneously detects general broadcasts and directed broadcasts for each network card, reducing the probability of discovery failures caused by cross-network card, ZeroTier/Tailscale or router broadcast policies.
- Manager's Remote Agent discovery supports `REMOTE_AGENT_PUBLIC_HOST` / `GATEWAY_MANAGER_PUBLIC_HOST` explicit advertisement addresses; when not set will bypass WSL, TAP, vEthernet and link-local addresses in favor of real LAN/VPN addresses.

### Local verification

- `node --check plugin-adapters/remote-agent-rabiroute/index.mjs` passed.
- `npm run build:backend` passed.
- `node --import tsx --test src/messageEndpoints/remoteAgentManager.test.ts` Passed.
- `npm test` Passed, 58 tests cover remote Agent task ownership, configuration migration, message return, plan/memory recall and gateway config model and other paths.

## 2026-06-11

This update continues to push the multi-processor boundary of RabiRoute to "local personality scheduling remote Agent device", while tightening the plan/memory context injection and configuration migration links.

### Remote Agent and Multiprocessor

- Added `remoteAgent` message terminal type and independent `plugin-adapters/remote-agent-rabiroute` bridge; the remote machine only needs to run the bridge, and the local personality delivers the task through the RabiRoute API. The remote result is returned and then injected into the local personality thread.
- Manager adds remote Agent device discovery, task delivery and task event interfaces, and displays online remote devices, default device/cwd/thread settings and connection entries on the WebGUI routing configuration page.
- The Remote Agent REST portal now requires `REMOTE_AGENT_TOKEN` for non-native requests. The task event will also verify that the event source device must match the device to which the task belongs to avoid forging task completion results in the same network segment.
- Agent packet injects the remote device API, default device and task delivery example when `remoteAgent` is enabled, but still requires the remote Agent not to directly reply to QQ. As a result, it returns to the local personality and then uses the normal reply/Action Gate.

### Planning, Memory and Configuration

- Plan/memory recall is upgraded to `[Pre-action context check]`: use only ID, title, and `keywords` for lightweight scoring, inject the required GET path into the Agent, and do not insert the full body directly.
- Refresh `viewedAt` when recent memory and precipitated memory enter the must-read confirmation queue to reduce the probability of premature precipitation of memories that are still in use.
- Gateway Configuration read and write further splits adapter configuration and persona rules, adds configuration migration assistance, retains route historical data and merges old rules into `personaConfig.json`.
- Route identity and path resolution are centralized into shared helpers to avoid route/config/persona path escape and old runtime id caliber drift.

### WebGUI, Tray and Packaging

- RibiWebGUI supplements remote Agent message side configuration, route miss/delivery status display, built-in rolePanel rule protection and read-only status optimization.
- Windows tray packaging supplements the application identity and version information files. The tray entry continues to reuse the manager API and does not submit the generated exe.

### Local verification

- `npm test` Passed, 56 tests covering forwarding, remote agent task event ownership verification, configuration warehouse migration, plan/memory recall, route identity and gateway config model.
- `npm run build:backend` Passed.
- `npm run build` Passed; Vite still prompts static asset runtime resolution and large chunk warnings.
- `git diff --check` Passed, Windows workspace CRLF prompt only.

## 2026-06-10This update continues to consolidate RabiRoute into the scheduling layer of "message portal + role panel + returnable Agent": the Codex adapter name is unified to `codex`, the role panel becomes a built-in local message terminal, and timed triggering supports rule-level schedules. NapCat multi-instance status and port ownership are more diagnosable, and public Rabi Sample synchronization plan/memory knowledge package.

### Routing, Agent and Backhaul

- Agent adapter types are uniformly migrated from `codexDesktop` / `codexApp` to `codex`, old configurations are automatically upgraded when reading and saving, and Codex Desktop IPC is still the default verified delivery channel.
- Added `rolePanel` message terminal and `role_panel_message` routing type. The tray character panel can deliver local chat messages to the Agent bound to the current route, and write Agent replies back to the character panel timeline.
- Agent reply postbacks can locate routes based on clear QQ group/private chat targets or original message logs; NapCat outbound policies are simplified to `outputEnabled` and `supportedOutputs`, and the old `outputMode`, whitelist, and pipeline filter fields are no longer sent as new versions.
- Manager adds a new Agent running status reporting interface, and Copilot CLI and Marvis status are reported to the Manager process instead, reducing misjudgments caused by reading stale state files.

### Timing trigger, NapCat and configuration

- Heartbeat scheduled triggering supports the configuration of each notification rule `schedules`, including interval triggering, interval triggering within a time window, daily fixed time and one-time triggering; trigger records will be marked with route/rule/schedule.
- Gateway Added NapCat to the configuration model for master instance resolution, master instance field synchronization and port ownership collection. Automatic port allocation will avoid occupation by manager, WS, HTTP, Webhook, etc.
- NapCat health check adds `online` / `good` judgments for OneBot `get_status` and supports restarting a single NapCat instance from the WebGUI request.
- When deleting the route configuration, only the corresponding `adapterConfig.json` will be removed, and the historical JSONL records in the route directory will be retained.

### WebGUI, Tray and Examples

- RibiWebGUI displays the role panel as a fixed built-in portal, supplementing route deletion, NapCat restart, offline status display, dirty configuration protection and heartbeat schedule editing/migration portals.
- The Windows tray window has been upgraded from a read-only plan/memory board to a role panel: select routes on the left, the main area displays chat, plans and memories, and supports sending text and file attachments.
- Public examples of Rabi personality completion plan index, archive directory, multiple precipitated memories and recent memories, using desensitized content to illustrate product boundaries, configuration sources, message links, action safety gates, routing types, WebGUI/tray positioning and open source release hygiene.
- README, configuration documents, Agent interface documents and pipeline documents are synchronized to use `codex`, new version of message side strategy and role panel/postback semantics.

### Migration instructions

- `agentAdapters: ["codexDesktop"]` or `["codexApp"]` in old configurations are automatically upgraded to `["codex"]`.
- `outputMode`, `allowedGroups`, `allowedUsers`, `allowBroadcast`, `enabledPipelines`, `disabledPipelines` in old `messageAdapterPolicies` Field is ignored; use `outputEnabled` and `supportedOutputs` when control sending is required.
- The old heartbeat global interval will still be used as a compatible schedule; the new version recommends maintaining `schedules` on the heartbeat notification rule.

### Local verification- `npm test` Passed, covering Agent adapter, configuration warehouse, outbox postback, memory reach, routing decisions, Agent packet, heartbeat schedules and gateway config model.
- `npm run check:config` passed; the missing local route configuration was skipped according to script rules, and the runtime and public example persona configuration verification passed.
- `npm run build` passed, completing TypeScript compilation, WebGUI `vue-tsc` and Vite production build; Vite only prompts static resource runtime analysis and large chunk warnings.
- `git diff --check` Passed.
- The desensitization scan covers public source code, documents, examples and change logs. The hit items are field names, security reminders or placeholder examples. No real tokens, cookies, passwords, local user paths or runtime private chat contents were found.

## 2026-06-08

This supplement includes data format migration instructions in the README, Windows tray exe packaging boundaries, and adds plan/memory context, Agent return interface, multiple NapCat instances, and document and code organization after manager split to facilitate local packaging verification after upgrading from the old runtime `data/` to the new version of the configuration structure.

### Documentation

- README adds "Current Data Format" to clarify the responsibility boundaries of `data/route/<configName>/adapterConfig.json` and `data/roles/<RoleId>/personaConfig.json`.
- README adds old file migration relationships: `routeConfig.json` moves to `adapterConfig.json`, `roleMessageConfig.json` moves to `personaConfig.json`.
- README clarifies that `data/gateways.json` and `data/roles/<RoleId>/routes.json` are no longer used as new moderator configuration entries.
- README adds Windows exe packaging command and runtime boundary: `RabiRoute-Tray.exe` only packages the PySide6 tray entry, and does not build in Node.js, manager/WebGUI build products or runtime `data/`.
- README document index supplements plan/memory, Agent interface and code architecture entry.
- Added `docs/plan-and-memory-model.md`, `docs/rabi-agent-interfaces.md` and `docs/agent-context-injection.md` to account for character planning, recent memory, sunk memory, context injection and Agent postback boundaries.
- Added `docs/code-architecture.md` to sort out the modification entrances for the backend entrance, message main link, routing module, manager control plane, WebGUI, tray window and plug-in directory.
- The local absolute paths in public sample documents are uniformly replaced with placeholder paths to avoid submitting private workspace paths.

### Routing, Agent and Context

- `forwarding.ts` calls the route decision and agent packet constructs of `src/routing/` instead, reducing the coupling of rule matching, template assembly and context injection in the main link.
- Added a new plan and memory reading layer, which injects lightweight plans/recent memory indexes into the Agent by default, and performs lightweight recall of current messages through keywords.
- Added Agent normal reply return interface boundary, the reply is first returned to RabiRoute, and then the outbox decides to send, draft or block based on the pipeline, source log and policy.
- Example Rabi personality supplement `plans/` and `memory/` expose the structure, showing the data form of plans, recent memories, precipitated memories and memory organization runs.

### Manager and message terminal

- Manager unpacks the configuration repository, runtime registry, scan control, role context routing, control plane routing and stateful payloads from a single large file.
- NapCat/OneBot configuration is changed to a multi-instance model, and each instance independently saves the WS port, HTTP address, WebUI address, token, startup command and working directory.
- Added NapCat manager auxiliary logic to support WebUI token reading, OneBot network configuration check/repair, HTTP health, WebUI login and controlled exit.
- WebGUI routing configuration page synchronization supports multiple NapCat instances, instance scanning, WebUI token backfill, Agent session scanning and more complete pipeline/policy configuration.

### Desktop task window- The tray task window uses the plan/memory model to read the role context, and completes the current plan, short-term/long-term view, recent/precipitated memory, task list and running status display.
- Windows launcher and tray lifecycle control continue to maintain manager ownership boundaries: only the manager owned by this launcher is closed.

### Test

- Added `npm test` script.
- Added Node test coverage for route decision, gateway config model and manager config repository.

### Local verification

- `npm test` Passed, covering route decision, agent packet, gateway config model and manager config repository.
- The local runtime `data/` has been generated in the new format `adapterConfig.json` and `personaConfig.json`, the old files are retained for rollback reference.
- `npm run check:config` passed.
- `npm run build` passed.
- `scripts/build-tray-exe.ps1 -SkipNodeBuild` Passed, local `RabiRoute-Tray.exe` has been generated.
- The new version of manager has been restarted, and `http://127.0.0.1:8790/meta` is working normally.

## 2026-06-07

This update further expands RabiRoute from a single QQ/Codex routing to a multi-entry and multi-processing framework of "context routing + action security gate", and completes the Windows desktop entrance, Xiaoai speaker bridge research, Pipeline preset and RibiWebGUI substantial reconstruction.

### Routing and Pipeline

- Added `pipelinePreset` / `pipeline` configuration, built-in three types of output intentions: `qq_chat`, `voice_chat`, `webhook_task`.
- Added input, output, TTS, reflow control and manual trigger related fields to template variables.
- Added `manual_trigger` to the routing type, which supports the manager API to actively trigger specified rules.
- Webhook voice events add device ID, device name, region and session information.
- The default template for voice transcription has been changed to allow entry into the outgoing process when authorization is sufficient to avoid treating voice transcripts as read-only input.

### Agent and output adaptation

- Agent adapter extends to `copilotCli`, `marvis` and `astrbot`.
- Copilot CLI supports configurable binaries, working directories, parameters and timeouts.
- Marvis adapter supports opening desktop, copying prompt words and handover via URL/desktop portal.
- AstrBot adapter uses environment variables to log in and cache short-term tokens, without submitting real passwords or tokens.
- Manager adds Agent scanning, Copilot installation/login/status query, FenneNote playback/reply forwarding and graceful shutdown API.

### RibiWebGUI

- WebGUI page changed to console, message adapter, Rabi personality, log diagnostics and routing directory guidance.
- The routing configuration page is restructured into a more complete message entry, Agent, Pipeline, template rules and manual trigger configuration interface.
- Overview page enhances running status, connection diagnosis, quick actions and routing selection.
- The personality template page enhances template variables, rule editing and personality configuration display.
- Enhanced diagnostic information and manager status display on the run log page.
- The overall style has been updated to improve the scannability and mobile layout of dense configuration interfaces.

### Windows Desktop Portal

- Added and unified Windows startup entry to `Start-RabiRoute-Tray.bat`.
- Added PySide6/Qt tray task panel, which read-only displays the current task, short-term/long-term plan, short-term/long-term memory, task list and running status.
- The tray panel reads status through the manager API and can request graceful shutdown when the launcher has the manager life cycle.
- The desktop layer maintains cross-platform boundaries: Qt panel, manager client, task repository, role context repository and life cycle control remain reusable, Windows only provides the first launcher.

### Xiaoai and external devices- Added `plugin-adapters/xiaoai-rabiroute`, providing XiaoAI transcript bridge and speak placeholder.
- Added `examples/data/route/xiaoai/adapterConfig.json` and related `personaConfig` fragments.
- Added Xiaoai interception routing, LX06 flashing checklist, infrared remote control gateway research and Home Assistant/BroadLink selection instructions.
- This time, the local `open-xiaoai` vendor checkout will not be submitted, only RabiRoute's own bridging code and documentation will be submitted.

### Documentation, Examples and Release Hygiene

- README updates project boundaries to make clear RabiRoute saves migratable context, routing decisions, action safety gates and observable records.
- Added `docs/pipeline-presets.md`, Windows launcher/packaging documentation, WebGUI build skill and RabiRoute build skill.
- Example `.env.example` Add Copilot/Marvis adaptation configuration placeholder.
- `.gitignore` Add Python virtual environment, cache, logs and local vendor checkout ignore rules.
- The local absolute path has been cleaned before publishing, and only the placeholder path, localhost example and environment variable name are retained in the public content.

### Verify

- `npm run build` passed.
- `npm run check:config` passed; during local operation, `data/` missing configuration items were skipped according to script rules, and the example route and Rabi role configuration verification passed.
- The desensitization scan covered modified and newly added files to be submitted, and no real tokens, cookies, passwords or local absolute paths were found.

### Additional updates

- Windows entry merged into `Start-RabiRoute-Tray.bat`, removed old `Start-RabiRoute-Windows.bat` forked with `scripts/start-rabiroute-windows.ps1`.
- Added `RabiRoute-Tray.spec` and `scripts/build-tray-exe.ps1` to support PyInstaller local packaging root directory `RabiRoute-Tray.exe`; exe will not be submitted to the source code warehouse, and public release packages will not be enabled for the time being.
- The packaged tray exe locates the project root directory from its own directory in freeze mode and automatically starts `node dist/manager.js` when the manager is not running.
- When the tray exits, manager shutdown will be called first, and the managed process will be terminated directly when it owns the manager process to reduce background residue.
- Manager configuration is split into `data/route/<configName>/adapterConfig.json` and `data/roles/<RoleId>/personaConfig.json`, routing adapter and personality template rules are no longer mixed in the same file.
- The WebGUI routing configuration page is synchronized to use the `adapterConfig.json` path, and the Copilot CLI session drop-down only displays the Copilot session name.
- `.gitignore` Added `/build/` to avoid committing the PyInstaller temporary directory and the native path analysis files therein.

## 2026-06-05

This update organizes the configuration structure of RabiRoute from the old single file/routes format into two clear data fields, and synchronizes the still valuable WebGUI, Webhook, Codex thread binding and voice workstation capabilities in the old branch.

### Configuration structure

- Route configuration migrated to `data/route/<config-name>/adapterConfig.json`.
- Persona configuration and message-template rules migrated to `data/roles/<role-name>/persona.md` and `data/roles/<role-name>/personaConfig.json`.
- Removed old `examples/data/gateways.json` and `examples/data/roles/Rabi/routes.json` from public examples.
- Added `examples/data/route/main/adapterConfig.json` and `examples/data/roles/Rabi/personaConfig.json` to sample data.
- Configuration check script changes to check `adapterConfig.json` and `personaConfig.json`.

### WebGUI- The top operation bar has been changed to a fixed suspension. When scrolling the page, you can still refresh, start the manager, add routing configuration, open the directory and save the configuration.
- Routing configuration and personality configuration are displayed in two major data fields: `data/route` / `data/roles`.
- The personality configuration and message template rule areas are displayed only after the routing configuration points to the personality.
- The message adapter settings are changed to centralized cards and details panel.
- When adding new message template rules, use the secondary pop-up window to edit; multiple rules can be switched through labels.
- Added "Open Configuration File" entry to all configuration areas.

### Routing and Adapters

- A new independent field `webhookPort` is added to the Webhook port to avoid confusion with NapCat WebSocket's `gatewayPort`.
- Webhook adapter uses `WEBHOOK_PORT`, falling back to `GATEWAY_PORT` when not configured.
- NapCat adapter increases the active connection count to avoid misjudgment when multiple WebSocket connections are made.
- The default template for voice transcription is updated to the FenneNote / Codex local voice input scenario, which is not automatically forwarded to QQ/NapCat by default.

### Codex Delivery

- Codex App and Codex Desktop IPC Enhance pinned thread auto-discovery.
- When the thread name of the old state binding is inconsistent with the current configuration, the old binding will be cleaned up and error information will be recorded to avoid messages being delivered to the wrong thread.
- Codex Desktop IPC Preserves batch posting and on-the-fly steer logic.

### Documentation and Skills

- The documents are uniformly changed to the new caliber `data/route` / `data/roles`.
- Added `docs/voice-interaction-workstation.md`, illustrating public secure wiring methods for FenneNote, RabiRoute, character dialogue, and OumuQ TTS.
- Added `skills/rabiroute-voice-workstation/SKILL.md`.
- Update `skills/create-rabiroute-persona` to avoid subsequent generation of old `routes.json`.
- Added NapCat unattended and login stability instructions.

### Compatibility Notes

- The old `data/gateways.json` / `routes.json` configuration format is not retained this time.
- The old branch has been archived as `archive/*` tag; the main branch continues to evolve in the new format.
- The QClaw branches are too different and are not merged directly. If necessary, it should be re-implemented as an optional adapter or plug-in according to the current main branch.

### Verify

- `npm run build` Passed.
- `npm run check:config` passed.
- The local manager has been restarted with the new build and confirmed that `8790`, `8789`, `8791` are listening properly.
- A desensitization scan has been performed before release, public examples and documents use placeholder values, and no runtime `data/`, logs, tokens, cookies or real accounts have been submitted.
