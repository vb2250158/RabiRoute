---
name: qwen-tts-audio
description: 通过 RabiSpeech 使用本地 Qwen3-TTS 0.6B 或 1.7B 生成人格、多语言或音色复刻语音。用户指定 Qwen3-TTS、日语/多语言、本地参考音频、人格名或模型大小对比时使用。不得启动技能内 worker、OumuQ 或任何 Qwen/DashScope 云端 API。
---

# RabiSpeech Qwen3-TTS

Qwen3-TTS 是本地多语言克隆模型。**路由规则、请求合同、调用写法都在 [TTS 路由](../tts-router/SKILL.md)，本文只写这个模型自己的取舍。**

## 选 0.6B 还是 1.7B

| 模型 | 取舍 |
|---|---|
| `local-tts/qwen3-tts-0.6b-base` | 显存占用和冷启动更低，常规多语言对话够用。**默认选它。** |
| `local-tts/qwen3-tts-1.7b-base` | 质量优先时才选；更慢、更吃显存，适合成品交付而非反复试音。 |

## 这个模型的参数怎么填

- `language`：目标语言码（`zh` / `ja` / `en` 等）。Qwen 是多语言模型，**语言靠这个字段定，不靠提示词暗示**；不给就可能按参考音的语言走。
- `instructions`：简短风格/情绪说明。用目标语言写更稳（日语台词配日语的 instructions）。
- `voice`：Rabi 人格目录名，每次请求显式发送，不继承上一会话。
- `play` / `session_id`：验证用 `play=false` 存 WAV；对话用 `play=true` 进全局 FIFO。

## 边界

- 模型加载、参考音频选择、缓存和 worker 生命周期全部归 RabiSpeech，不要在技能目录里起 worker。
- 不走云端 Qwen / DashScope，也不走 OumuQ。
