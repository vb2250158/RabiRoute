---
name: tts-router
description: Route local text-to-speech through RabiSpeech across ONNX-VITS, GPT-SoVITS, IndexTTS2, Qwen3-TTS and CosyVoice3. Use when Codex must choose a local TTS model, Rabi persona voice, language, style instruction, output format, session metadata or global playback behavior. Never route to OumuQ or cloud speech APIs.
---

# RabiSpeech TTS Router

本技能是本地语音的**唯一路由层**：选哪个模型、请求怎么发、播放怎么排，都在这里定。
单模型专页（`qwen-tts-audio`、`indextts2-audio`）只写该模型自己的取舍，不重复本文的合同与调用写法。

从当前 RabiSpeech 配置取得完整 `speechBaseUrl`，或使用已核验 Manager 的同源语音代理；不要从旧技能或日志猜地址。RabiSpeech owns model workers, persona voice resolution, output files and one host-wide FIFO playback queue.

## Discovery first

Call `GET /v1/models`. Each row contains provider, model, installed state, languages, features and a complete `request` contract. Call `GET /v1/models/<provider>/<model>` when exact fields are needed. Do not guess model parameters.

Rabi persona data lives under `RabiRoute/data/roles/<RoleId>/voice`. Pass `<RoleId>` as `voice`; no Route or Agent configuration is required. ONNX fixed speakers use `voice="speaker:<id>"`.

## Routing policy

| 模型 | 什么时候用它 |
|---|---|
| `local-tts/onnx-vits` | 最快、纯 CPU 的固定说话人基线；不支持参考克隆 |
| `local-tts/gpt-sovits` | 少样本人格克隆；最适合 3–10 秒的短参考音 |
| `local-tts/indextts2` | 中文克隆，且需要情绪/风格控制 |
| `local-tts/qwen3-tts-0.6b-base` | 多语言克隆的均衡档，显存与冷启动低 |
| `local-tts/qwen3-tts-1.7b-base` | 多语言，质量优先 |
| `local-tts/cosyvoice3-0.5b` | 多语言，偏指令控制与流式 |

Honor an explicit user model choice. Otherwise choose by language, cloning need, latency and available hardware; mention when comparing unlike fixed-speaker and cloning models.

本地推理服务按「语言覆盖 + 是否需要克隆 + 延迟 + 显存」选，不按榜单分数选。

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

## 最小调用

调用写法只在这里写一次，单模型专页不再重复。`$speechBaseUrl` 来自上面的发现步骤，不要硬编码。

```powershell
$body = @{
  model = 'local-tts/gpt-sovits'
  input = '要合成的文本'
  voice = '<RoleId>'
  response_format = 'wav'
  language = 'zh'
  play  = $false
} | ConvertTo-Json -Compress
Invoke-WebRequest -Method Post -Uri ($speechBaseUrl.TrimEnd('/') + '/v1/audio/speech') `
  -ContentType 'application/json' -Body $body -OutFile '.\out.wav'
```

```bash
curl -sS -X POST "$speechBaseUrl/v1/audio/speech" \
  -H 'Content-Type: application/json' \
  -d '{"model":"local-tts/gpt-sovits","input":"要合成的文本","voice":"<RoleId>","response_format":"wav","language":"zh","play":false}' \
  -o out.wav
```

两条必须记住的：

- **换 model 不等于能直接用。** 先 `GET /v1/models/<provider>/<model>` 看该模型的 request 字段：有的不接受 `speed`，有的必须给 `language`，参数名以该模型为准。
- **验证一律 `play=false` 落 WAV 再听；`play=true` 是给对话用的**，会进全局 FIFO 抢占播放。

## GPT-SoVITS 的语言模式

中文口播夹英文专名时，`language` 的实际行为要先核，别按名字猜：

- 先核实际的 `zh` 模式是否保留英语。能保留就优先用它，中文部分最稳。
- 只有某一句英文型号念得不好时，先只对该句试 `auto`，**不要整批换**。
- 全批次仍以能稳定中文日期、数字、汉字短语的模式为准。`auto` 要拿中文日期、数字和「文字/研究所」这类汉字短语做代表验证，防止自动分语种后冒出异语读法。
- 出现局部乱码：保留旧母带，用同原文、同声线对照 `zh`，只重生受影响句块；新母带要重建时轴并独立复核。
- 正式英文专名保持原样，不要为了念得顺改写拼写。语言模式的问题用正确的语种模式加对照样修复，不靠改文案绕。

## 会话、旧数据和 Manager 代理

每次请求显式发送 model、input 和 voice；人格属于请求，不属于 worker 全局状态。先查询模型列表和详情，以 installed、语言和 request 字段判断能力。用户明确选用的模型优先。旧 voice-references 注册表不作为当前真源；迁移须先备份并使用当前人格 voice 合同。

经动态发现及 `/meta` 身份核验后的 Manager 可使用 `/api/speech/status`、`/api/speech/models`、`/api/speech/personas`、`/api/speech/tts`、`/api/speech/asr` 和 `/api/speech/playback/status`。直接 RabiSpeech 使用 speechBaseUrl 下的 `/v1/models`、`/v1/audio/speech` 与 `/v1/playback/status`。停止播放是用户授权范围内的独立操作，不作为只读探针。只有 `/api/speech/messages` 会将识别文本提交给 Route/Agent；普通 TTS/ASR 不隐式投递任务。
