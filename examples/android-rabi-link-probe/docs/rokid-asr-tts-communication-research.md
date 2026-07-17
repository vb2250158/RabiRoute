# Rokid ASR/TTS 通讯方式与可行性结论

<!-- docs-language-switch -->
<div align="center">
<a href="./rokid-asr-tts-communication-research_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

> 状态：当前研究结论，证据更新至 2026-07-05。外部平台和 SDK 可能变化，实施前仍需重新核对官方权限与版本。

本文回答当前问题：`com.rabi.link` 想接入 Rokid 眼镜语音时，ASR/TTS 一般怎么通讯，以及哪些“原生”路线真正可行。

结论更新日期：2026-07-05。

## 大白话结论

Rokid Glasses 对普通第三方 APK 没有直接开放“系统 ASR 文本接口”。论坛官方回复已经把边界说清楚：眼镜系统 ASR 不是眼镜 SDK 的自带开放能力；要做 ASR，接第三方 ASR。另一个官方回复也说明，面向 APP 端产品的云端 ASR/TTS API 当前没有开放计划。

所以 `com.rabi.link` 不应继续把主路线押在“直接调用乐奇系统 ASR/TTS”。更稳的方向是：

1. CXR-M / CXR-L 负责眼镜连接、按键、音频、拍照、GUI、结果显示。
2. ASR 在手机、电脑或云端自己做。
3. RabiRoute/Codex 处理文本消息。
4. 回复再用 CXR-M `sendAsrContent` / `sendTtsContent`、CustomView 或 CustomApp 送回眼镜显示；真正的语音合成和播放要单独走手机 TTS、云 TTS、RokidAiSdk TTS 或 Glass3 TTS。

## 没有底层 ASR/TTS 时怎么和用户交互

这里要把“交互”拆开看。眼镜不开放系统 ASR/TTS，不代表它不能和用户交互；只是语音识别和语音合成不在第三方 APK 里直接完成。

| 交互方向 | 没有底层 ASR/TTS 时怎么做 | 对 RabiLink 的意义 |
| --- | --- | --- |
| 用户输入语音 | 眼镜/平台只提供原生助手入口，或只提供录音/音频流；真正转文字交给灵珠平台、手机 ASR、云 ASR、FenneNote/Whisper。 | 我们拿到的是“平台文本”或“外部 ASR 文本”，不是直接调用眼镜系统 ASR。 |
| 用户输入按键 | CXR-M/CXR-L 可监听 AI 键、触摸、确认/返回等事件。 | 适合做 push-to-talk、确认、取消、下一步、拍照等低延迟控制。 |
| 用户输入视觉 | 通过拍照、相机帧、图片首轮传递或灵珠视觉模型处理。 | 很适合眼镜场景，很多“问这个是什么”不一定需要用户打字。 |
| 眼镜输出文字 | CXR-M `sendAsrContent` / `sendTtsContent`、CustomView、CustomApp 或灵珠回复卡片。 | 这是最稳定的返回通道，先保证“看得见”。 |
| 眼镜输出 GUI | CustomView / CustomApp 在眼镜端画框、按钮、状态、步骤。 | 适合测试接口能力，也适合后续做 RabiLink 的实时状态 HUD。 |
| 眼镜输出语音 | 平台托管时由 Rokid/灵珠播报；自管 APK 时走手机 TTS、云 TTS、RokidAiSdk TTS 或已验证的 Glass3 TTS。 | “能播报”要单独验收，不能因为能 `sendTtsContent` 就算 TTS 成功。 |

所以实际通讯模型有两种：

1. 平台托管模型：Rokid 原生助手/灵珠负责听和说，我们只接收文本请求并返回文本结果。
2. 自管桥接模型：CXR 负责眼镜 IO，我们自己做 ASR/TTS，再把文本、状态和 GUI 推回眼镜。

第一种更像“原生体验”，第二种更像“我们自己的应用模式”。两者都能和用户交互，但控制权和可测接口完全不同。

## 不额外接 ASR/TTS 的推荐路径

如果目标是“用户能说话 -> 我们拿到文字 -> RabiRoute/Codex 回答 -> 眼镜显示或播报”，同时不想自己额外接一套 ASR/TTS，优先级应这样排：

| 优先级 | 路线 | 谁负责语音转文字 | 谁负责文字转语音/播放 | 我们接什么 | 当前判断 |
| --- | --- | --- | --- | --- | --- |
| 1 | 灵珠 / AIUI Studio 自定义智能体 | Rokid AI App / 灵珠平台 | Rokid AI App / 灵珠平台 | 智能体外部 URL、SSE、WebSocket 或工作流工具；只处理文本请求和文本回复。 | 最符合“不额外接 ASR/TTS”。需要真机验证返回是自动播报、只显示，还是可配置。 |
| 2 | RokidAiSdk / OpenVoice 官方语音 | Rokid 语音 SDK / 云端 | Rokid 语音 SDK / 云端 | 官方语音产品凭证和 SDK 回调。 | 技术形态匹配，但当前缺正式语音产品凭证，普通 appId、账号 key、`.lc` 文件不能替代。 |
| 3 | CXR-L/CXR-M 音频流 + 外部 ASR/TTS | 我们自己接手机、云或电脑 ASR | 我们自己接手机、云或电脑 TTS，或只把文本推到眼镜显示 | `startAudioStream` PCM/WAV、外部 ASR、`sendAsrContent` / CustomView、外部 TTS。 | 最可控，但不符合“不额外接 ASR/TTS”，作为兜底和底层验证。 |

所以当前最值得先试的是灵珠：它不是让 `com.rabi.link` APK 调系统 ASR/TTS，而是让 Rokid AI App/灵珠先把语音交互托管掉。RabiLink 后端只当一个文本 Agent 服务。

### 灵珠最小验证

1. 在灵珠 / AIUI Studio 创建 `RabiLink` 自定义智能体。
2. 配置外部 URL、鉴权 AK、SSE、WebSocket 或平台支持的工作流工具。
3. 外部服务先只返回固定文本：`收到：<用户文本>`。
4. 戴眼镜用 Rokid AI App / 开发者模式语音触发这个智能体。
5. 验证三件事：
   - 外部服务是否收到用户语音转成的文本。
   - 眼镜是否显示返回文本。
   - 眼镜是否自动播报返回文本。
6. 如果前两项成功但不播报，说明灵珠可免 ASR，但 TTS 播放还需要平台配置或额外能力；如果三项都成功，它就是 RabiLink 第一优先级的消息端路线。

## TTS 名字边界

“TTS”在 Rokid 资料里会出现在不同层，不能看见 `tts` 字样就当成眼镜已经能自己播报：

| 名称 | 它是什么 | 当前判断 |
| --- | --- | --- |
| Glass3 SDK TTS | 眼镜端原生 TTS 服务，目标是手机发文本、眼镜自己播。 | 最像“眼镜原生播报”，但当前 CustomApp 真机里 Glass3 Security Service 不可见，实测不可用。 |
| RokidAiSdk TTS | 官方语音 SDK 的 `IRokidAudioAiService.playTtsVoice(text)`。 | 有正式接口，但需要 OpenVoice/RokidAiSdk 语音产品凭证；当前缺 `key/secret/deviceTypeId/deviceId/seed`。 |
| OpenVoice HTTP/WS TTS | 云端文本转音频协议，HTTP 或 WebSocket 返回 mp3/pcm/流式音频。 | 协议存在，但不等于消费级 Rokid Glasses 第三方 APP 可直接使用。 |
| CXR-M `sendTtsContent` | AI 场景里把“AI 回复/TTS 文本/状态”推到眼镜端界面或场景。 | 不等于 SDK 内置 TTS 合成引擎；社区文章也明确 ASR、AI、TTS 服务要开发者自己接。 |
| Android 系统 `TextToSpeech` | 手机或眼镜 Android 系统级 TTS。 | 手机侧可作为备用；当前没有证明声音能路由到眼镜。眼镜 CustomApp 内系统 TTS 当前不 ready。 |

因此，RabiLink 后续验收必须拆成两件事：一是“文本有没有送到眼镜显示”，二是“声音有没有实际播出来”。`sendTtsContent` 只能证明前者或场景状态联动，不能单独证明眼镜 TTS 播放成功。

## 灵珠 / AIUI Studio 路线

“灵珠”不是给 APK 调用的底层 ASR/TTS SDK，而是 Rokid 的智能体平台路线。更准确地说，它像 Rokid 原生助手背后的 Agent 编排平台：Rokid 负责眼镜上的唤醒、语音交互、视觉输入和展示/播报体验，开发者在平台里创建智能体、配置模型、插件、工作流或外部服务。

论坛 3153 的社区案例把它说成基于 Coze Studio 定制的 AI 开放平台，示例是“万能说明书”：用户戴眼镜看物品或说明书，由灵珠智能体做视觉识别、步骤讲解和对话式引导。这个证据说明灵珠能支撑眼镜侧的语音/视觉 Agent 体验，但它没有证明普通第三方 APK 可以直接拿到系统 ASR 文本，也没有证明 APK 能直接调用眼镜原生 TTS。

对 RabiLink 来说，灵珠对应的是“父子级 / 平台托管”关系：

1. 用户通过 Rokid 原生入口和灵珠智能体说话。
2. Rokid/灵珠完成语音识别、上下文包装、视觉输入和交互承载。
3. 灵珠智能体通过插件、工作流、HTTP/SSE/WebSocket 或平台支持的外部服务调用 RabiRoute/Codex。
4. RabiRoute/Codex 返回文本、结构化结果或下一步动作。
5. Rokid/灵珠负责把回复显示或播报给用户。

这条路线的优点是体验最接近“原生助手”：少做麦克风、录音、TTS 播放和眼镜 UI 的底层适配。缺点是控制权在平台侧：我们拿到的通常是平台处理后的文本/图片/事件，不是原始音频流；可用接口、审核、鉴权、外部回调方式也要服从灵珠平台。

## 证据表

| 来源 | 关键信息 | 对 RabiLink 的判断 |
| --- | --- | --- |
| RokidAiSdk 官方文档 | RokidAiSdk 可以在 Android APK 内启动语音服务，ASR 回调里有完整识别文本，TTS 可调用 `playTtsVoice(text)`。 | 这是“有 ASR 文本/TTS 调用”的正式 SDK 路线，但需要语音产品凭证，不是 CXR token 或 `.lc` 文件。 |
| OpenVoice WebSocket ASR 文档 | 先做 `service=speech` 设备认证；一次识别用 `START` / `VOICE` / `END`；云端回 `INTERMEDIATE` / `ASR_FINISH` / `FINISH`。 | 证明 Rokid 云 ASR 协议存在；但它面向设备语音接入，不等于 Rokid Glasses 第三方 APK 自动可用。 |
| OpenVoice HTTP/WS TTS 文档 | TTS 用授权头提交文本、音色和编码，返回 mp3/pcm 等音频数据。 | 证明云 TTS 协议存在；但仍需要开放平台语音产品凭证。 |
| 论坛 2618 | 官方回复：ASR 不是眼镜自带能力。 | 眼镜端 CustomApp 里不能假设有系统 ASR 可调用。 |
| 论坛 2678 | 官方回复：接第三方 ASR 能力。 | CXR 眼镜路线要把 ASR 放在手机/电脑/云端。 |
| 论坛 2699 | 官方回复：面向 APP 端产品的云端 ASR/TTS API 目前没有开放计划。 | 不能把消费级眼镜 App 接口等同于 OpenVoice 设备端 API。 |
| 论坛 2493 | CXR-M AI 助手案例：SDK 提供 AI 按键监听、`sendAsrContent`、`sendTtsContent`、拍照和错误通知；不提供语音识别引擎、AI 大模型、TTS 合成。 | 最贴近 RabiLink 的可行路线：眼镜是交互和显示端，语音识别/合成由我们自己接。 |
| 论坛 3394 | 社区 Claude Code 眼镜项目：眼镜主要做麦克风和 HUD，转文字放手机/电脑侧。 | 社区实际项目也在走“眼镜 IO + 外部 ASR/Agent”的结构。 |
| 论坛 3153 | 灵珠开发案例：用灵珠平台创建眼镜智能体，做视觉识别、对话交互和“全语音闭环”物品解读。 | 这是平台托管 Agent 路线，证明能做原生感交互；不等于 APK 底层开放 ASR/TTS。 |
| 灵珠平台 / AIUI Studio | 平台侧创建、编排、调试和发布智能体，可接入插件、工作流和外部服务。 | 适合把 RabiRoute/Codex 做成灵珠调用的后端 Agent 或工具。 |
| CXR-L 示例工程 | `startAudioStream(1)` 后通过 `IAudioStreamCbk.onAudioReceived(data, offset, length)` 收音频字节，示例按 16 kHz、单声道、16 bit PCM 写 WAV。 | 证明底层可拿音频流；但拿到的是音频，不是用户说话文本，仍需外部 ASR。 |
| CXR-S 示例工程 | `CXRServiceBridge` 支持 `subscribe` / `sendMessage`，眼镜端按键事件可发回手机。 | 适合做按钮、控制和自定义消息通道，不是 ASR/TTS 引擎。 |

## OpenVoice / RokidAiSdk 怎么通讯

如果拿到了官方语音接入凭证，常规语音通讯是这样：

### ASR WebSocket

1. 建立到 Rokid 云端的 WebSocket。
2. 用 `key`、`device_type_id`、`device_id`、`service=speech`、`version`、`timestamp`、`sign` 做设备认证。
3. 每次识别创建一个 session id。
4. 发送 `START`，带语言、编码、VAD、是否需要 NLP、是否返回中间结果等参数。
5. 连续发送 `VOICE`，内容是音频块。
6. 发送 `END`。
7. 云端返回：
   - `INTERMEDIATE`：中间 ASR 或激活词相关信息；
   - `ASR_FINISH`：最终识别文本；
   - `FINISH`：NLP/action 等结果。

常见音频参数：16 kHz、单声道、16 bit PCM；也支持 OPU/OPUS/AMR 等编码。若只要“用户说了什么”，重点看 `ASR_FINISH.asr`，不要把中间片段当最终输入。

### ASR HTTP

HTTP 路线适合一次性文件或分段上传：

1. 请求头放同样的设备认证信息。
2. `multipart/form-data` 里放 `voice-config` JSON。
3. 音频作为二进制 form part 上传。
4. 完整音频可以用 `ONESHOT`；流式分段可按 `START` / `VOICE` / `END` 语义拆。

### TTS HTTP / WebSocket

TTS 的本质是“文本进、音频出”：

1. 认证时 `service=tts` 或 REST TTS 对应授权头。
2. 请求里传 `text`、`declaimer`、`codec`、`sample_rate` 等。
3. 返回 mp3/pcm 或流式音频片段。

RokidAiSdk Android AAR 又封了一层本地 Service：Demo 里通过 `ServerConfig` 填 `key/secret/deviceTypeId/deviceId/seed/workDir/configFile`，启动 `IRokidAudioAiService`，再从 `onIntermediateEntire(...)` 收最终 ASR 文本，用 `playTtsVoice(text)` 触发 SDK TTS。

## 三条路线的可行性

| 路线 | 当前可行性 | 该做什么 |
| --- | --- | --- |
| Glass SDK / 眼镜端系统 ASR/TTS | 当前真机验证不可用。CustomApp 里 Glass SDK Security Service 不可见，Android `SpeechRecognizer` / `TextToSpeech` 也不 ready。 | 保留诊断，不作为主路线。只有真机回 `RABI_ASR:<text>` 和 `RABI_TTS_OK:<text>` 才能重新判定。 |
| RokidAiSdk / OpenVoice 官方语音 | 协议和 SDK 存在，但需要语音接入产品凭证；当前普通应用 appId/appSecret、账号授权 key、`.lc` 文件都不能替代五段语音凭证。 | 等官方开通语音产品或提供测试 `key/secret/deviceTypeId/deviceId/seed`，再跑现有 readiness 和眼镜端 32 位 SDK 探针。 |
| CXR-M / CXR-L + 外部 ASR/TTS | 最可行。官方/社区资料都指向这种结构。 | 把 `.lc` 当 CXR-M 授权文件候选，优先接 CXR-M AI 场景：按键事件、音频或手机录音、外部 ASR、`sendAsrContent`、`sendTtsContent`、CustomView/CustomApp 显示；播放由外部 TTS 或已验证的原生 TTS 路线完成。 |
| 灵珠 / AIUI Studio 智能体 | 作为“原生助手体验”可行，作为“APK 底层 ASR/TTS 接口”不可行。 | 并行验证：创建 RabiLink 智能体，配置一个最小外部回调，把用户语音转成平台文本请求，再转发给 RabiRoute/Codex，确认眼镜端能显示或播报返回。 |

## `.lc` 文件的判断

用户从设备管理下载的 `.lc` 文件是 80 字节二进制授权文件。它不是 JSON，也不包含可见的 `key`、`secret`、`deviceTypeId`、`deviceId`、`seed` 字符串。

因此它更像 CXR-M / 设备绑定用的授权 blob，不是 OpenVoice/RokidAiSdk 的语音接入凭证。后续应把它接到 CXR-M SDK 初始化或设备授权测试里，而不是填进 RokidAiSdk 配置。

处理原则：

- 只允许导入到 App 私有目录。
- 日志只显示文件长度、SHA-256 摘要、导入状态。
- 不提交 `.lc` 文件，不打印二进制内容。
- 不把它当成 ASR/TTS 云协议密钥。

## 建议的 RabiLink 实施路线

### 第一阶段：CXR-M AI 场景探针

目标是验证“眼镜作为 AI 交互端”能不能成立。

要测的能力：

1. 导入 `.lc` 授权文件。
2. 初始化 CXR-M SDK。
3. 绑定/连接当前眼镜 SN。
4. 监听 AI 按键或 AI 场景事件。
5. 触发录音或接收音频流。
6. 用外部 ASR 得到文本。
7. 调 `sendAsrContent(text)` 把识别文本推到眼镜。
8. 调 `sendTtsContent(text)` 或 CustomView 把回复文本/状态推到眼镜。
9. TTS 合成和播放先由手机/云端负责，完成后调用对应的 finished/error 通知。

### 第二阶段：外部 ASR 选择

优先级：

1. 手机本机 Android `SpeechRecognizer`，只作为低成本验证。
2. FenneNote / 本机 Whisper，适合接 RabiRoute 工作站。
3. 腾讯云、阿里云、火山等流式 ASR，适合手机独立运行。
4. OpenAI / 其他云 ASR，作为跨平台备选。

### 第三阶段：消息端闭环

只要拿到最终文本，就统一转成 RabiRoute 的 `voice_transcript`：

```json
{
  "type": "voice_transcript",
  "source": "rokid",
  "text": "用户说的话"
}
```

回复输出分两层：

- 显示：CustomView / CXR-M `sendTtsContent` / 自定义眼镜 APK。
- 播放：手机 TTS、云 TTS、RokidAiSdk TTS 或系统 TTS，必须以实际听到播报或明确回调为验收。

### 并行阶段：灵珠智能体闭环

目标是验证“Rokid 原生助手 -> 灵珠 -> RabiRoute/Codex -> 灵珠 -> 眼镜”的父子级链路。

最小测试：

1. 在灵珠 / AIUI Studio 创建 `RabiLink` 智能体。
2. 给智能体配置外部 HTTP/SSE/WebSocket 工具或工作流。
3. 外部服务只做 `Hello`：接收平台传来的文本，返回固定回复。
4. 再把外部服务换成 RabiRoute webhook。
5. 验证眼镜端是否能通过自然语音触发，并看到或听到返回。

验收边界：

- 能在灵珠里拿到用户说话后的文本请求，说明平台 ASR 可以作为入口使用。
- 能在眼镜上看到或听到返回，说明平台 TTS/显示闭环可用。
- 这仍然不代表 APK 获得了原生 ASR/TTS 权限。

## 下一步验证清单

| 状态 | 动作 | 证据 |
| --- | --- | --- |
| 待做 | 找到 CXR-M SDK 里 `.lc` / auth blob 的初始化 API。 | 官方示例或 AAR 方法名，不靠猜。 |
| 待做 | APK 增加 `.lc` 导入探针。 | UI 显示 `imported=true;bytes=80;sha256=<摘要>`。 |
| 待做 | 接 CXR-M AI 场景 Hello World。 | 收到 AI 按键事件，并能把 `Hello` 推到眼镜。 |
| 待做 | 外部 ASR 最小闭环。 | 对眼镜/手机说话后，日志出现非空最终文本。 |
| 待做 | ASR 文本进 RabiRoute。 | 本地 webhook 收到 `voice_transcript`。 |
| 待做 | 回复显示/播报。 | 眼镜显示回复，或手机/眼镜实际播报并有完成回调。 |
| 待做 | 灵珠智能体 Hello World。 | 眼镜通过自然语音触发灵珠智能体，外部服务收到文本请求并返回固定回复。 |

## 参考链接

- RokidAiSdk 文档：<https://developer.rokid.com/docs/5-enableVoice/rokid-vsvy-sdk-docs/RokidAiSdk/RokidAiSdk.html>
- OpenVoice ASR WebSocket：<https://developer.rokid.com/docs/3-ApiReference/openvoice-speech-api.html>
- OpenVoice HTTP TTS：<https://developer.rokid.com/docs/3-ApiReference/openvoice-http-tts.html>
- RokidAiSdkDemo：<https://github.com/Rokid/RokidAiSdkDemo>
- 论坛 2618：<https://forum.rokid.com/post/detail/2618>
- 论坛 2678：<https://forum.rokid.com/post/detail/2678>
- 论坛 2699：<https://forum.rokid.com/post/detail/2699>
- 论坛 2493：<https://forum.rokid.com/post/detail/2493>
- 论坛 3394：<https://forum.rokid.com/post/detail/3394>
- 论坛 3153：<https://forum.rokid.com/post/detail/3153>
- 灵珠平台：<https://rizon.rokid.com/space/home>
- AIUI Studio / 灵珠入口：<https://open.rokid.com/>
- Rokid Glasses 自定义智能体报道：<https://www.vrtuoluo.cn/544727.html>
- CXR-S / 灵珠实战资料：<https://segmentfault.com/a/1190000047636145>
