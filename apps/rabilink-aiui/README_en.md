<!-- docs-language-switch -->
<div align="center">
English | <a href="./README.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# RabiLink AIUI - Agent and Lingzhu Collaboration Framework for Rokid AR Glasses

RabiLink AIUI brings speech recognition, a host model, speech synthesis and a transparent HUD into one glasses application page for conversations, result presentation and controlled configuration. It is not tied to a specific preset persona. By default, the **AIUI host `LanguageModel`** handles conversation; PC supplies controlled HTTP tools rather than replacing the glasses application's model.

> **Maturity**: Phone-managed device configuration and knowledge-tool integration are under implementation and acceptance testing. Source, mocks and local builds do not establish installation or device acceptance. Arbitrary Lingzhu platform Agent binding, physically offline inference and a complete autonomous multi-step tool loop are not promised.

---

## Current implementation and boundaries

- The default runtime is `local-aiui`. Obtaining device credentials or connecting Relay/PC does not automatically change the model owner.
- “Local” means that the AIUI page calls its host model, not that inference necessarily runs physically on the glasses or works offline. Current code calls `LanguageModel.create(options)`, checks availability and rejects known offline state.
- Spoken “set/bind agent” commands only change the **local display name**, not a Lingzhu platform binding. `agentId` is not a verified platform invocation route. Renaming saves the complete `{id,name,prompt}` first; storage failure preserves the existing name/model, and late obsolete models cannot replace a newer session.
- A phone-managed device profile can configure name, system prompt, Skill guidance and MCP service references. Saved configuration, applied model configuration and connected tools are different states; execution integration and end-to-end acceptance are still in progress. Once a device profile is active, names are managed on the phone rather than through a competing spoken setting.
- Official tool documentation supports function declarations and `toolcall` events, but no tool-result continuation interface has been verified. Ordinary prompt text must not impersonate a tool response or justify a complete Agent-loop claim.

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
   - ASR releases the microphone before TTS and resumes in a controlled manner afterward.
   - The runtime filters TTS echoes and rapid duplicate ASR, and handles new user speech interrupting playback. Recognition and interruption quality in real noise still require device testing.
5. **Minimal transparent AR HUD**:
   - Green high-contrast captions, name/status/clock/battery, and a mostly clear central view.
   - A tap interrupts playback; explicit legacy remote mode can request review. Double-tap returns or exits. Readability across sizes is subject to layout and device acceptance.

---

## Runtime architecture and compatibility

```text
RabiLink AIUI: one page, local-aiui by default
  User speech → native ASR → AIUI host LanguageModel → native TTS / HUD
                                  ↑
  Phone device profile → validate/save → apply next turn after the current turn
  (name / system prompt / Skill guidance / MCP references)

  AIUI → controlled HTTP → RabiPC tools → actual tool results
  (integration/acceptance in progress; model tool-result continuation unverified)

Only with explicit agentRuntimeMode=legacy-remote-observer:
  ASR → legacy remote observation/review → remote reply queue → TTS / HUD
  Mutually exclusive with local model submission; a Token alone does not enable it
```

### 1. Default host-model conversation

For everyday conversation when host capabilities are available; offline operation is not promised.

```text
User speaks
→ AIUI SpeechRecognition captures speech
→ Echo/duplicate filtering and interruption when appropriate
→ LanguageModel.create(options), then promptStreaming() or prompt()
→ Sentences go to speechSynthesis and HUD
→ ASR resumes in a controlled manner after playback
```

Default mode does not send the old remote inference queue, start the old reply long-wait loop, request remote review or play old remote replies, preventing duplicate submission/replies. Old records are retained rather than automatically deleted. Device status, configuration reads and logs retain their own contracts.

### 2. Explicit legacy remote-observer mode

Retained only for migration of existing message-endpoint callers. Startup must explicitly set `agentRuntimeMode=legacy-remote-observer` and valid remote credentials must be available. Missing credentials produce a disconnected state, not a silent switch to another executor. This mode does not also call the local model.

```text
Upstream: ASR observation + clientMessageId → POST /rokid/rabilink/input
          → remote conversation record → remote Agent review
Downstream: remote replies/notifications → durable outbound queue
          → /rokid/rabilink/messages?stream=1 controlled foreground long wait
          → local persistent queue → TTS
```

This does not establish automatic binding to arbitrary cloud Agents. The compatibility entry can be removed only after callers migrate and old queues have been handled with confirmation. See [model ownership](docs/agent-runtime-mode_en.md).

---

## Configuring the glasses Agent

### Method 1: Phone device settings

In Relay management, select the owned application and bound glasses, then open Agent settings to edit the name, system prompt, Skill guidance and MCP references. The device reads its profile with its own credential. A new profile waits during the current conversation; after successful storage, the next turn rebuilds the model.

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

- **Speech recognition (ASR)**: [SpeechRecognition API (0.18.0)](https://js.rokid.com/AIUI/api/ai/speech-recognition?lang=zh-CN&version=0.18.0)
  - Foreground single-turn state machine and controlled renewal; check interactive readiness before starting and stop ASR before TTS.
- **Speech synthesis (TTS)**: [speechSynthesis API (0.18.0)](https://js.rokid.com/AIUI/api/ai/speech-synthesis?lang=zh-CN&version=0.18.0)
  - Uses `speak(utterance, "enqueue")`, `onend/onerror` and bounded text-length-based lifecycle timeouts.
- **Host model**: [LanguageModel API (0.18.0)](https://js.rokid.com/AIUI/api/ai/language-model?lang=zh-CN&version=0.18.0)
  - `LanguageModel.create(options)` supplies initial prompts and tool declarations; this is not a zero-parameter contract.
  - Uses `promptStreaming()` or `prompt()`; only one active request per session.
  - `toolcall` provides structured events; result continuation remains unverified. See [tool contract review](docs/agent-tool-contract_en.md).

## HUD and interaction

- The top area shows configured name, state, clock and battery; the bottom shows captions and configuration status while preserving the central view where possible.
- Captions use a green high-contrast design. Actual size, safe edges and compact layouts follow current implementation and acceptance; readability under every lighting condition is not promised.
- **Tap / Enter**: Interrupt playback; request review while idle in explicit legacy remote mode.
- **Double-tap**: Return or exit.

---

## Local verification, build and deployment

Run commands from a **complete source snapshot on local disk**, not NAS. Tests, packaging, upload, installation and device operation are separate acceptance stages.

### 1. Local checks and smoke tests

`npm run check:agent` runs the nine focused Agent smoke scripts and the endpoint/configuration boundary negative tests. `npm run check` runs this entry first, then retains the complete existing cross-application audit chain; missing or incompatible Android bridge contracts remain failures rather than silently skipped checks.
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
