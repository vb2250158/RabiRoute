<!-- docs-language-switch -->
<div align="center">
English | <a href="./README.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

New routes and NapCat instances use `gatewayPort: 0` to request an automatically assigned WS listener, and configuration input/save preserves zero. NapCat management carries the original route/instance identity so the current PC owner resolves its endpoint. Missing HTTP/WebUI URLs are not replaced with guessed addresses; explicit upstream URLs retain their configured values.

# RabiLink AIUI - Agent and Lingzhu Collaboration Framework for Rokid AR Glasses

RabiLink AIUI brings speech recognition, a host model, speech synthesis and a transparent HUD into one glasses application page for conversations, result presentation and controlled configuration. It is not tied to a specific preset persona. By default, the **AIUI host `LanguageModel`** handles conversation; PC supplies controlled HTTP tools rather than replacing the glasses application's model.

> **Maturity**: Phone persona binding, generic HTTP APIs, history and voice steering are wired in source; installation and hardware acceptance remain pending. Source, mocks and local builds do not establish installation or device acceptance. An application multi-step loop has source and fixture evidence; complete Route and real-host acceptance remain pending. Arbitrary Lingzhu binding and physically offline inference are not promised.

The page loads global instructions and connected tools through the shared assistant session, serializing model requests and returning actual tool observations for the next decision. Touch or speech-onset interruption stops playback while reasoning and backend work continue. Explicit session cancellation destroys the model and fences late results; timed-out tools are never automatically replayed. Advanced settings retain the persona source computer ID when saving remote-persona configuration. See [generic transport and host capabilities](docs/generic-api-transport_en.md), [model-turn runtime](docs/agent-turn-runtime_en.md) and [personas, generic APIs and steering](docs/persona-agent_en.md).


Speech arriving during tool waits now has per-input receipts for independent answers, original-ID deferred work and interrupted-input recovery. The footer record viewer shows original text, saved answers and status without replaying tasks. See [input receipts](docs/input-receipts_en.md).

---

## Current implementation and boundaries

For local conversation testing, run `npm ci` and `npm run simulator` here, open the printed localhost URL and configure your API. This runs the same AIUI page on official Ink `0.19.1`. See [current speech and testing notes](docs/aiui-voice-current_en.md) for speech API requirements, SDK updates and device acceptance boundaries.

Packaging injects the same `craft-release.json` version into the app and page; archive validation checks both. Native ASR construction and runtime errors retain sanitized reasons in simulator logs to distinguish application failures from host capability issues.

- The default runtime is `local-aiui`. Obtaining device credentials or connecting Relay/PC does not automatically change the model owner.
- “Local” means that the AIUI page calls its host model, not that inference necessarily runs physically on the glasses or works offline. Current code calls `LanguageModel.create(options)`, checks availability and rejects known offline state.
- Spoken “set/bind agent” commands only change the **local display name**, not a Lingzhu platform binding. `agentId` is not a verified platform invocation route. Renaming saves the complete `{id,name,prompt}` first; storage failure preserves the existing name/model, and late obsolete models cannot replace a newer session.
- A phone-managed device profile can configure name, system prompt, Skill guidance and MCP service references. Saved configuration, applied model configuration and connected tools are different states; execution integration and end-to-end acceptance are still in progress. Once a device profile is active, names are managed on the phone rather than through a competing spoken setting.
- Default conversation uses application action framing and explicit observations for continued reasoning, with native tool declarations empty. It claims no native tool role or result-submission API. Real-host and Route acceptance remain pending.

## Core design

1. **One page, explicit execution ownership**:
   - Conversation, status and configuration share a page. Historical `mode=transcription` / `configuration` operation states remain compatible but do not select the model owner.
   - The host model handles conversation; configuration actions are allowlisted. Configuration-command counts are not counts of general-purpose Agent tools.
2. **Configurable without a hardcoded persona**:
   - Startup parameters can supply `agentId`, `agentName` and `systemPrompt`; they configure the local page, not a guaranteed platform Agent invocation.
   - Phone profiles provide versioned settings. Skills are bounded guidance; MCP references do not prove connectivity, authorization or successful calls.
   - The HUD shows the configured name and statuses such as Thinking, Speaking and Ready.
3. **Basic conversation without a Rabi Token**:
   - Basic host conversation does not require a Rabi Token or an online PC, but depends on available host ASR, model and TTS services and their network/permission requirements.
   - `SpeechRecognition` → `LanguageModel.create(options)` → `speechSynthesis`. Model unavailability produces an error or bounded fallback message, not a fabricated successful model result.
4. **Barge-in and echo suppression**:
   - Normal conversation retains ASR during TTS and inference; non-echo text stops only playback, and final input steers the next step after the active request settles.
   - The runtime filters TTS echoes and rapid duplicate ASR, and handles new user speech interrupting playback. Recognition and interruption quality in real noise still require device testing.
5. **Minimal transparent AR HUD**:
   - Green high-contrast captions, name/status/clock/battery, and a mostly clear central view.
   - A tap can interrupt the active conversation and playback. Double-tap returns or exits. Readability across sizes is subject to layout and device acceptance.

---

## Runtime architecture

```text
RabiLink AIUI: one page, local-aiui by default
  User speech → native ASR → AIUI host LanguageModel → native TTS / HUD
                                  ↑
  Phone device profile → validate/save → apply next turn after the current turn
  (name / system prompt / Skill guidance / MCP references)

  AIUI → controlled HTTP → RabiPC tools → actual tool results
  (actual results return to the same host model; hardware acceptance pending)

```

### 1. Default host-model conversation

For everyday conversation when host capabilities are available; offline operation is not promised.

```text
User speaks
→ AIUI SpeechRecognition captures speech
→ Echo/duplicate filtering and interruption when appropriate
→ LanguageModel.create(options), then promptStreaming() or prompt()
→ Sentences go to speechSynthesis and HUD
→ ASR remains active during reasoning/playback; final input steers between steps
```

### 2. Registered device Agent

A PC message Route can select `deviceAgent`. After loading its native model, the glasses register their name, stable ID and session, then claim and execute the original message. The phone forwards only wake nonces. A rejected system broadcast leaves the original message queued and never records completion. Automatic wake and real-device execution are unverified. See [device Agent](docs/device-agent_en.md).

---

## Configuring the glasses Agent

### Method 1: Phone device settings

On the phone, open **All-day recording → Devices → Glasses → Glasses settings** and select a persona, its source PC and optional preloaded Skills. The glasses connection PC owns the profile and may reference a persona from another PC in the same authenticated application. The device reads this PC profile through generic HTTP transport and applies changes after the active turn and its steering settle. The server owns connections, authentication and forwarding, not persona configuration.

Check Saved and Applied separately. An unconnected MCP reference must not appear as an available tool; integration and device acceptance remain in progress. With a phone profile active, spoken renaming directs the user back to phone management. See [device profile HTTP and phone settings](../../docs/aiui-agent-profile-http_en.md) and [profile lifecycle](docs/agent-profile-runtime_en.md).

### Method 2: Spoken local display-name setting

Without an active device profile, say “设置灵珠智能体为 星河” or “切换灵珠智能体为 助手”. This changes only the display name, not the platform Agent or system prompt. The HUD and spoken confirmation update only after successful complete storage; failure preserves existing settings.

### Method 3: Startup parameters

Pass these through AIUI Studio or a supported page invocation entry:

```json
{
  "agentId": "local-assistant",
  "agentName": "Custom Agent Name",
  "systemPrompt": "You are a concise, helpful assistant for AR glasses."
}
```

`agentId` is a local configuration identifier, not a platform binding credential. Legacy local settings and startup parameters remain compatible; an applied device profile takes precedence. Relay settings in the current `app.json` are not an implemented default-platform-Agent configuration interface.

---

## Official API contracts and references

The official `latest` documentation and npm/Maven releases were reviewed on 2026-11-05. See [current conversation and voice troubleshooting](docs/aiui-voice-current_en.md) for version differences, upgrade checks and silence diagnostics. The `0.18.0` links below remain the original contract baseline, not the current glasses firmware version.

- **Speech recognition (ASR)**: [SpeechRecognition API (0.18.0)](https://js.rokid.com/AIUI/api/ai/speech-recognition?lang=zh-CN&version=0.18.0)
  - Every `SpeechRecognition.start()` requires user interaction. The input handler synchronously starts one continuous recognizer, retaining it during inference and TTS and delivering new final segments by `resultIndex`. End or failure waits for another tap or wake; timers never create another recognition round. Interim-result support and actual simultaneous audio require separate host acceptance.
- **Speech synthesis (TTS)**: [speechSynthesis API (0.18.0)](https://js.rokid.com/AIUI/api/ai/speech-synthesis?lang=zh-CN&version=0.18.0)
  - Conversation uses only `synthesize()` and an owned `SpeechAudioPlayer`. Non-echo recognized text stops the actual player, aborts the old task and discards late results. Unsupported synthesis or failures show an explicit TTS status; they never fall back to the uncontrollable shared `speak()` player. The official shared player exposes neither `cancel()` nor utterance completion events.
- **Host model**: [LanguageModel API (0.18.0)](https://js.rokid.com/AIUI/api/ai/language-model?lang=zh-CN&version=0.18.0)
  - The application supplies initial prompts with `LanguageModel.create(options)`; the official API also permits omitted options with a host default model.
  - Uses `promptStreaming()` or `prompt()`; only one active request per session.
  - `toolcall` provides structured events; result continuation remains unverified. See [tool contract review](docs/agent-tool-contract_en.md).

## HUD and interaction

- The top area shows configured name, state, clock and battery; the bottom shows captions and configuration status while preserving the central view where possible.
- Captions use a green high-contrast design. Actual size, safe edges and compact layouts follow current implementation and acceptance; readability under every lighting condition is not promised.
- **Tap / Enter**: Interrupt the active conversation during inference or playback. While idle, start device Agent reception; a tap resumes listening when transcription is paused.
- **Double-tap**: Return or exit.

---

## Local verification, build and deployment

Run commands from a **complete source snapshot on local disk**, not NAS. Tests, packaging, upload, installation and device operation are separate acceptance stages.

### 1. Local checks and smoke tests

`npm run check:agent` runs eleven focused Agent smoke scripts, plus phone bridge, device Agent, endpoint, configuration and device-status contract tests. `npm run check` runs this entry first, then retains the complete existing cross-application audit chain; missing or incompatible Android bridge contracts remain failures rather than silently skipped checks.
```powershell
# Full static/dynamic contract checks
node .\scripts\check-rabilink-aiui.mjs

# Voice runtime and interruption smoke tests
node .\scripts\Smoke-RabiLinkVoiceRuntime.mjs

# Startup safety tests
node .\scripts\Smoke-RabiLinkAiuiStartupSafety.mjs

# Full configuration-command simulation
node .\scripts\Smoke-RabiLinkAiuiRuntime.mjs
```

### 2. Prepare for Rokid AIUI Studio (Craft)
```powershell
# Stage a self-contained dist/craft-upload directory without bumping the version
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\Prepare-RabiLinkAiuiCraftUpload.ps1 -NoBump

# Build a local AIX package
npm run package:aix
```

Supply valid Relay configuration as required by the packaging script. A test package containing an example address is not a usable device-connection release.

### 3. Upload and device synchronization
1. Open [Rokid AIUI Studio (Craft)](https://aiui.rokid.com).
2. Import the generated `apps/rabilink-aiui/dist/craft-upload` folder.
3. Inspect the Studio preview, then follow the platform's current device-debugging or review flow.
4. If review, account and device requirements are satisfied, add the Agent in the Rokid phone app and synchronize to the glasses; verify synchronization and actual launch separately.

These instructions are not evidence that upload, installation or acceptance has already completed.

Hiding the page stops capture and speech while retaining admitted model/tool work and full text. The existing device owner renews its lease while host JavaScript is running, without claiming new messages. Showing the page first validates the original session and ownerEpoch, then reconciles original receipts. If host suspension or connection changes prevent confirmation, records remain unconfirmed; work is never replayed under a replacement owner. Showing the page neither opens the microphone nor replays muted responses.
