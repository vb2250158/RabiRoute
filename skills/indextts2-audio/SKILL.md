---
name: indextts2-audio
description: 通过 RabiSpeech 的本地 IndexTTS2 模型生成中文或音色复刻语音。用户指定 IndexTTS2、中文参考音频、情绪/风格指令、人格声线或本地 WAV 验证时使用。不得直接运行技能内 worker、启动 OumuQ 或调用云端 API。
---

# RabiSpeech IndexTTS2

IndexTTS2 用于中文克隆 + 情绪/风格控制。**路由规则、请求合同、调用写法都在 [TTS 路由](../tts-router/SKILL.md)，本文只写这个模型自己的取舍。**

- 模型 id：`local-tts/indextts2`
- `voice=<RoleId>`：RabiSpeech 从人格 voice index 选参考音频并缓存，不用自己传参考音文件。
- 人格参考音频在 `RabiRoute/data/roles/<RoleId>/voice/`，推理期只读；**生成结果不得写回参考库**。

## 情绪与风格怎么写

`instructions` 是这个模型唯一的方向控制入口，写成一句可执行的语气要求，例如「自然、温和、清楚」「压低声线，语速偏慢」。

- 写语气，不写内容：它是控制音色表达的，不是改台词的手段。
- 一句就够。堆一串抽象形容词反而会让韵律发散。
- 节奏本身要更细的控制时，先看该模型的 request 字段有没有 `speed`，别用 instructions 硬凑。

## 边界

- 不要从技能目录运行旧 `indextts2_worker.py`；模型环境、CUDA、参考音频组合和输出缓存统一属于 RabiSpeech。
- 生成结果只进 RabiSpeech 输出/缓存，不回写人格目录。
