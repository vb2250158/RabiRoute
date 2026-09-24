<!-- docs-language-switch -->
<div align="center">
English | <a href="./README.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# RabiLink AIUI - Universal On-Device Agent & Lingzhu Collaboration Framework for Rokid AR Glasses

> **Latest Architecture Specification**: RabiLink AIUI adopts a **Unified Single Agent Mode** architecture, eliminating the obsolete dual-mode switching between conversation and configuration. It is an open, universal on-device master agent framework completely decoupled from any hardcoded persona (including YeYu), and **fully supports configuring and binding any Rokid Lingzhu Agent**—users can bind whatever agent they want!

---

## Core Philosophy

1. **Unified Single Mode: Agent Mode**:
   - **One Single Mode**: Opening the app directly enters the AR agent interface. No complex dual-segment sliders or manual mode toggles.
   - **Comprehensive Intelligence**: Natural chit-chat, knowledge queries, device control, and agent binding are all processed seamlessly by the AI model within this unified Agent Mode.
2. **Support Configuring & Binding Lingzhu Agents**:
   - **Decoupled Personality**: No hardcoded persona locks. Users can connect to any agent in the Rokid Lingzhu ecosystem.
   - **3 Flexible Configuration Methods**:
     1. **Voice Command Setting**: Simply speak "设置灵珠智能体为 xxx" (Set Lingzhu agent to xxx) or "绑定智能体 xxx" to immediately update and persist the target agent;
     2. **Startup Parameter Injection**: Pass `agentId`, `agentName`, and `systemPrompt` via page tool schema;
     3. **Static Preset in Configuration**: Configure default agent information in `app.json`.
   - **Dynamic HUD Display**: The top bar dynamically displays the bound Lingzhu agent's name, accompanied by real-time status indicators (Thinking, Speaking, Listening, Ready).
3. **Zero-Token Standalone Master Agent**:
   - Talk immediately upon putting on the glasses—**no token configuration, no QR code pairing, and no desktop PC required**.
   - Fully on-device native loop: native `SpeechRecognition` -> system-level native on-device `LanguageModel.create()` (zero-parameter contract) -> native `speechSynthesis`.
   - Built-in on-device fallback responder ensures zero freezes and continuous availability.
4. **Smart Barge-in & Echo Suppression**:
   - Strict microphone lifecycle management: proactively releases ASR before TTS begins, and resumes listening upon playback completion.
   - Tailored for near-ear speakers: suppresses native TTS echoes and millisecond-level rapid duplicate ASR artifacts.
   - True voice barge-in: only genuine human speech triggers an instant interruption of active TTS playback and launches a fresh dialogue turn.
5. **AR-Optimized Transparent HUD**:
   - Engineered for Rokid AR optical transparency:
     - **Bottom 20px High-Contrast Subtitles**: Retro-green (#00FF88 / #55FF99) on translucent dark card, clear under direct sunlight or indoor lighting.
     - **Top Minimalist Status Capsule**: Displays bound Lingzhu agent name, status pill, clock, and battery level. Central real-world vision remains 100% unobstructed.
     - **Intuitive Touchpad Gestures**: Single-tap for barge-in / review, double-tap to go back / exit.

---

## Operating Architecture & Dual Modalities

The entire application runs under a single unified Agent Mode, supporting standalone offline execution and remote collaboration:

```text
+-----------------------------------------------------------------------------------+
|                        RabiLink AIUI (Unified Agent Mode)                         |
|                                                                                   |
|  [ Standalone Master Agent (Zero-Token) ]  [ Remote Collaboration (Token/Relay) ] |
|   - Fully offline / ready out-of-the-box    - Upstream: Observation ledger         |
|   - Native ASR -> On-device SLM -> TTS      - Downstream: Cursor stream            |
|   - Smart barge-in & fallback responder     - Supports cloud Lingzhu agent push    |
|                                                                                   |
|  [ Lingzhu Agent Configuration & Control ]                                        |
|   - Voice: "设置灵珠智能体为 xxx" / "绑定智能体 xxx"                                |
|   - Parameters: agentId / agentName / systemPrompt                                |
|   - 84 allow-listed commands & toolcalls for device and system adjustments        |
+-----------------------------------------------------------------------------------+
```

### 1. Standalone Zero-Token Loop
- **Workflow**:
  ```text
  User speaks
  -> AIUI SpeechRecognition captures natural language
  -> Echo suppression and rapid duplicate filtering
  -> If TTS is speaking and genuine new speech is detected: trigger Barge-in Interruption
  -> On-device native LanguageModel.create() (zero-parameter contract) generates streaming response
     (Fallback responder pool triggers if SLM has lag or error)
  -> Sentences stream to native speechSynthesis
  -> Bottom 20px green HUD displays subtitles synchronously
  -> ASR resumes automatically upon playback completion
  ```

### 2. Remote Collaboration Mode (Optional)
- **Workflow**:
  ```text
  [Upstream Queue - Observation Ledger]
  Glasses ASR observation -> attaches clientMessageId -> POST /rokid/rabilink/input
  -> Remote worker appends to unified ledger (rabilink-conversation.jsonl)
  -> Immediately releases upstream request without blocking for a turn reply
  -> Remote brain (Codex/cloud agent) reviews ledger when idle, or triggered by touchpad tap

  [Downstream Queue - Persistent Cursor Stream]
  Remote agent (proactive alerts / review replies) -> writes to persistent Outbox
  -> Glasses poll /rokid/rabilink/messages?stream=1 using local durable nextCursor
  -> Stored in local persistent queue -> Native speechSynthesis reads aloud in sequence
  ```

---

## How to Configure Lingzhu Agent

### Method 1: Instant Voice Command (Fastest)
Speak directly to the microphone while wearing the glasses:
- "设置灵珠智能体为 星河"
- "绑定智能体 小爱"
- "切换灵珠智能体为 助手"

The system updates the bound agent name and durable local storage immediately, refreshes the HUD top bar, and speaks confirmation via TTS.

### Method 2: Startup Parameters (Schema Injection)
When invoking via AIUI Studio or from an external Lingzhu Agent, pass:
```json
{
  "agentId": "your-lingzhu-agent-id",
  "agentName": "Custom Agent Name",
  "systemPrompt": "You are a concise, helpful assistant for AR glasses."
}
```

---

## Official API Contracts & Reference Links

Developed in strict compliance with official Rokid AIUI standard APIs:

- **Speech Recognition (ASR)**: [AIUI SpeechRecognition API (0.18.0)](https://js.rokid.com/AIUI/api/ai/speech-recognition?lang=zh-CN&version=0.18.0)
- **Speech Synthesis (TTS)**: [AIUI speechSynthesis API (0.18.0)](https://js.rokid.com/AIUI/api/ai/speech-synthesis?lang=zh-CN&version=0.18.0)
- **On-Device Language Model (SLM)**: [AIUI LanguageModel API (0.18.0)](https://js.rokid.com/AIUI/api/ai/language-model?lang=zh-CN&version=0.18.0)

---

## HUD Visual & Touchpad Interaction Contract

- **AR Display Adaptation**: Crafted specifically for Rokid AR optical waveguide characteristics; avoids massive bright color patches to keep real-world vision unobstructed.
- **HUD Layout**:
  - **Top Status Capsule**: Bound Lingzhu Agent Name (dynamic), status pill (Thinking / Speaking / Listening / Ready), clock, and battery level.
  - **Bottom Subtitle Card**: 20px high-contrast retro-green (#00FF88 / #55FF99) text over translucent dark background.
- **Touchpad Interaction**:
  - **Tap / Enter**: Instantly interrupt (Barge-in) speaking TTS; request immediate review when idle in remote mode.
  - **Double Tap**: Go back or exit current application.

---

## Local Verification, Build, & Deployment

```powershell
# 1. Run full contract checks and smoke tests
node .\scripts\check-rabilink-aiui.mjs
node .\scripts\Smoke-RabiLinkVoiceRuntime.mjs
node .\scripts\Smoke-RabiLinkAiuiStartupSafety.mjs
node .\scripts\Smoke-RabiLinkAiuiRuntime.mjs

# 2. Stage files for Rokid AIUI Studio (Craft)
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\Prepare-RabiLinkAiuiCraftUpload.ps1 -NoBump
```
