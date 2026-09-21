---
name: tts-router
description: Route local text-to-speech through RabiSpeech across ONNX-VITS, GPT-SoVITS, IndexTTS2, Qwen3-TTS and CosyVoice3. Use when Codex must choose a local TTS model, Rabi persona voice, language, style instruction, output format, session metadata or global playback behavior. Never route to OumuQ or cloud speech APIs.
---

# RabiSpeech TTS Router

从当前 RabiSpeech 配置取得完整 `speechBaseUrl`，或使用已核验 Manager 的同源语音代理；不要从旧技能或日志猜地址。 RabiSpeech owns model workers, persona voice resolution, output files and one host-wide FIFO playback queue.

## Discovery first

Call `GET /v1/models`. Each row contains provider, model, installed state, languages, features and a complete `request` contract. Call `GET /v1/models/<provider>/<model>` when exact fields are needed. Do not guess model parameters.

Rabi persona data lives under `RabiRoute/data/roles/<RoleId>/voice`. Pass `<RoleId>` as `voice`; no Route or Agent configuration is required. ONNX fixed speakers use `voice="speaker:<id>"`.

## Routing policy

- `local-tts/onnx-vits`: fastest fixed-speaker CPU baseline; no reference cloning.
- `local-tts/gpt-sovits`: few-shot character voice cloning; strongest fit for short 3–10 second role references.
- `local-tts/indextts2`: Chinese cloning and emotion/style direction.
- `local-tts/qwen3-tts-0.6b-base`: balanced multilingual cloning.
- `local-tts/qwen3-tts-1.7b-base`: larger multilingual model.
- `local-tts/cosyvoice3-0.5b`: multilingual, instruction and streaming-oriented capability.

Honor an explicit user model choice. Otherwise choose by language, cloning need, latency and available hardware; mention when comparing unlike fixed-speaker and cloning models.

## Shared request

```json
{
  "model": "local-tts/gpt-sovits",
  "input": "required speech text",
  "voice": "RoleId",
  "response_format": "wav",
  "speed": 1.0,
  "language": "zh",
  "instructions": null,
  "sample_rate": null,
  "play": false,
  "session_id": null,
  "route_id": null
}
```

Use `play=true` only when playback is wanted. The service queues completed audio globally across models, personas, Routes, sessions and Agents. Do not launch a separate player or model process per utterance.

Generated audio remains in RabiSpeech output/cache. Persona reference audio is read-only during inference and must never be exposed or committed.

## 会话、旧数据和 Manager 代理

每次请求显式发送 model、input 和 voice；人格属于请求，不属于 worker 全局状态。先查询模型列表和详情，以 installed、语言和 request 字段判断能力。用户明确选用的模型优先。旧 voice-references 注册表不作为当前真源；迁移须先备份并使用当前人格 voice 合同。

经动态发现及 `/meta` 身份核验后的 Manager 可使用 `/api/speech/status`、`/api/speech/models`、`/api/speech/personas`、`/api/speech/tts`、`/api/speech/asr` 和 `/api/speech/playback/status`。直接 RabiSpeech 使用 speechBaseUrl 下的 `/v1/models`、`/v1/audio/speech` 与 `/v1/playback/status`。停止播放是用户授权范围内的独立操作，不作为只读探针。只有 `/api/speech/messages` 会将识别文本提交给 Route/Agent；普通 TTS/ASR 不隐式投递任务。
