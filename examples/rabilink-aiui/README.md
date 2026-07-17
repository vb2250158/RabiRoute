<!-- docs-language-switch -->
<div align="center">
<a href="./README_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# RabiLink AIUI

RabiLink AIUI 是 Rokid 眼镜上的 Agent 消息端。首页只有两个可滑动切换的模式：`连接对话`和`配置助手`。

安装、提审、手机添加、眼镜同步和已复现故障统一记录在 [docs/installation-and-troubleshooting.md](docs/installation-and-troubleshooting.md)。按原始需求逐项核验的当前结论与证据索引见 [docs/acceptance-report.md](docs/acceptance-report.md)。遇到“请先绑定灵珠智能体”、上传后手机搜不到、AIX 无法从手机打开、ADB Permission Denial、Craft ASR 不启动、进入沉浸界面卡死或电量显示 `--` 时，先按安装排障文档判断所处阶段。

主链路：

```text
打开或恢复连接对话
-> 已绑定灵珠智能体调用 pages/home/index(mode=transcription)
-> AIUI SpeechRecognition 前台自动续轮
-> 最终文本经过保守的重复/原生 TTS 回声过滤
-> AIX POST Relay /rokid/rabilink/input（rabilink.observation）
-> PC worker 写入统一 rabilink-conversation.jsonl 并立即释放上行项
-> 不把单句转写直接投递给 Codex

自动审阅
-> Rabi 检测账本有未审阅观察，并等待固定 Codex 线程空闲
-> Codex 新开一轮，结构化读取当前 JSONL；需要时读取日期归档
-> 没有值得打扰的内容就保持安静

连续反思
-> 即使没有新转写，也按可配置周期等待固定 Codex 线程空闲
-> 重新检查用户意图、未完成承诺、计划、时间变化和本地 Agent 结果
-> 可静默准备资料；只有真正有价值时才主动下行

触摸板审阅
-> 连接对话中单击一次触摸板
-> 空闲时立即开启 Codex 审阅；正在执行时 turn/steer 到当前轮次
-> 单击不暂停 ASR，也不切换模式

Agent 下行
-> Codex / 定时器 / 规划器随时 POST /api/agent/replies
   targetType=rabilink, proactive=true, routeProfileId=<目标 Route>
-> RabiRoute 输出安全门 -> Relay /worker/messages
-> 成功排队的 Agent 消息也写入同一个 rabilink-conversation.jsonl
-> AIX 按 cursor 持续消费 /rokid/rabilink/messages?stream=1
-> 眼镜原生 speechSynthesis 顺序播报

配置需求
-> 已在页面时，滑到配置助手并直接描述需求
-> AIUI SpeechRecognition 采集完整原话
-> AIUI 原生 LanguageModel 理解语义并发出白名单 toolcall
   或由页面外已绑定灵珠智能体归一化后调用 mode=configuration, intent=明确指令
-> 配置助手直接调用现有 Relay mobile/WebGUI 后台动作
-> 页面显示并用眼镜原生 TTS 播报操作结果，再恢复下一轮配置 ASR

```

双向队列不是一次请求等一次回答，而是两条独立推进的队列：

```text
上行队列：眼镜 ASR -> Relay input -> PC worker -> 统一会话账本 -> 立即释放上行项
                                                        \-> 空闲审阅 / 触摸板引导

下行队列：Codex / 定时器 / 规划器 -> Rabi 输出安全门 -> Relay /worker/messages
          -> 统一会话账本 + 持久 cursor 流 -> 前台 AIUI -> 原生 TTS
```

连接对话的新上行使用 record-only observation，不创建需要 Codex 回答的来源任务。`taskId` 只保留给旧的直接消息兼容路径；它不会阻塞上行项，也不是主动消息的前提。下行生产者每次附带稳定 `deliveryId`；网络响应不确定时可以重试，Relay 会复用原队列项，避免眼镜重复显示或重复 TTS。PC 显示名变化时，Relay 仍使用稳定设备 GUID 核验绑定关系。

统一账本当前写入 `rabilink-conversation.jsonl`，用户观察使用 `direction=user_to_agent`，成功排队的 Agent 下行使用 `direction=agent_to_user`，触摸板请求使用 `direction=control`。跨本地日期或连续空档达到 `rabilinkConversationSplitAfterHours`（默认 6 小时）时，旧文件机械移动到 `rabilink-conversations/YYYY-MM-DD[-NN].jsonl`，并更新 `index.json`。归档不做总结、不改写原文。

账本写入由跨进程锁保护，避免 manager 写 Agent 下行与 gateway 写眼镜 observation 时和分卷互相踩踏。归档索引使用临时文件原子替换；即使进程在旧 JSONL 移动后、索引登记前退出，读取时间线时也会发现并恢复未登记分卷。审阅器按“历史分卷 + 当前文件”的完整时间线计算未审阅游标；即使 Codex 离线期间发生日期或空档分卷，旧 observation 也不会被当前文件边界漏掉。

下行是可恢复队列，不只是长轮询：Relay 将应用级 outbox 独立保留至少 48 小时，首次连接从仍在保留期内的 backlog 开始，不跳到当前队尾。AIUI 在保存 `nextCursor` 前，先把整批消息按 token 写入本地持久队列；页面隐藏、切换配置模式或 TTS 被中断时，尚未播完的消息仍保留，回到连接对话后按原顺序继续。单个 token 最多保留 2000 条、48 小时的待播报消息。

2026-07-14 最终部署后的真实公网验收已覆盖这条完整链路：无前置输入的 Codex 主动消息在 184ms 内进入眼镜队列；眼镜 observation 在 435ms 内完成 PC 落盘并释放上行；触摸板审阅随后启动绑定了 `RabiActive` 人格的真实 Codex，约 68 秒后以无 `taskId`、`proactive=true` 的独立消息回传。用户 observation 与 Agent 下行位于同一个当前 JSONL，两类消息重复数均为 0。远程 Rabi 配置也完成了“写入临时变量 -> 同路径读回 -> 精确回滚”验证。脱敏报告位于构建目录的 `dist/live-relay-codex.json`；这项证据不替代 `1.0.23` 在真眼镜上的前台 ASR、TTS 和触摸板复测。

不需要额外导入 RabiLinkMessage MCP/插件。输入事件、持续下行队列、主动投递和配置接口都由 AIX、Relay 与 RabiRoute 现有输出门覆盖。真机没有本地 `rbd_` 设备凭证时先进入独立的 `RabiLink Setup`，只显示完整 SN、Relay `/manage` 地址和绑定状态；外层传入的旧应用 token 会被忽略，不能绕过 Setup。用户在服务器后台把 SN 绑定到目标应用后，眼镜首次领取设备凭证并保存到当前 Agent 隔离的 `localStorage`，随后自动切回正常 RabiLink HUD。页面工具的 `token` 参数只保留给没有设备 SN 的 Craft 调试。

PC 全局“连接服务器”只让这台 Rabi 在 Relay 上线，不会自动选择 observation 的账本和 Agent。还必须启用一条 `rabilink` 输入/输出策略均开启、Agent 为 `codex`、人格为 `RabiActive` 的 Route。公开模板位于 `examples/data/route/RabiLink` 与 `examples/data/roles/RabiActive`，默认禁用且不含凭据；复制到已有 data、设置工作目录和固定线程、检查端口后再启用。

当前第一版支持：

- 作为带 JSON Schema 的 AIUI 页面工具被已绑定灵珠智能体调起，支持 `transcription` 和 `configuration` 两种模式。
- 由已绑定灵珠智能体以 `mode=transcription` 调起`连接对话`首页；每轮 `SpeechRecognition` 正常结束后，只在页面仍处于前台且用户未暂停、TTS 未占用麦克风时自动开始下一轮。
- Craft 浏览器中的 448×150 卡片即使收到 `mode=transcription` 也不自动启动 ASR；进入 Interactive InkView 后点击 Craft 麦克风，页面收到模拟唤醒事件后才开始识别。眼镜宿主注入设备身份时仍自动启动。
- ASR 错误或小于 800ms 的无结果快速结束会指数退避，连续失败 5 次后暂停并等待用户继续，避免 Craft/QuickJS 被识别器重建与重复渲染拖死。
- 最终 ASR 文本附带会话 ID、序号和时间戳，以 record-only observation 提交到 Relay；断网时最多保留最近 2000 段、最长 48 小时。离线观察按当前 token 的不透明本地指纹隔离，切换到另一应用 token 时不会把旧观察发给错误账号。页面重建后的首次前台启动会立即自动补传同一 token 的旧队列，并沿用原 `clientMessageId` 供 Relay 去重，不必等用户再说一句或再次隐藏/显示页面。响应不向页面暴露 worker task 状态，也不会逐句打断 Codex。
- 转写规则参考 FenneNote 的文本后处理边界：压缩空白、丢弃纯标点、抑制 2.5 秒内完全相同的重复结果，并在 Agent 原生 TTS 结束后 12 秒内过滤高度相似的回声。AIUI 没有向页面暴露 PCM、电平、动态底噪、Whisper 概率或可配置 VAD，因此不能复刻 FenneNote 的录音阈值、前置缓存和音频切句，也不会套用 Whisper 专属短语黑名单。
- PC worker 把用户观察和 Agent 已投递消息写入同一 JSONL。自动审阅只在固定 Codex 线程空闲且最后一段观察稳定后触发；连接对话单击触摸板则立即请求审阅，正在执行时作为当前 turn 的引导。
- 主动人格持续维护“当前任务、真正目标、障碍、下一步、机会和用户状态”的可修正假设。默认每 30 分钟做一次空闲连续反思；可通过 `rabilinkContinuousReflection` 和 `rabilinkReflectionIntervalMinutes` 关闭或调整。周期反思可以只做本地检索、分析和草稿准备，不要求每次向眼镜说话。
- 连接后始终按 `nextCursor` 消费全局持续下行流。首次连接会读取 Relay 仍在 48 小时保留期内的离线 backlog；每批消息先进入按 token 指纹隔离的本地持久 TTS 队列再推进同一指纹下的 cursor。普通回复和没有前置请求的主动消息进入同一显示、TTS 队列，不按 `taskId` 过滤，也不会在“任务完成”时关闭流。
- TTS 播报前中止当前 ASR；宿主有生命周期事件时按事件收尾，没有事件时由有界文本时长 watchdog 收尾，再恢复下一轮，避免眼镜把自己的输出重新识别成输入或永久停在播报态。
- 切到配置助手时先停止连接对话的识别轮次；模式帧提交后，在同一个 Interactive InkView 内启动配置 ASR。切回连接对话时重新交回识别所有权，不调用 `finish()`、不退出页面，也不要求再次点击“进入”。
- 配置助手把页面内 AIUI ASR 原话交给原生 `LanguageModel`，模型只能通过 `execute_configuration_action` 白名单工具选择已有动作；也可接收页面外 Agent 归一化后的严格 `intent`。两条路径都直接调用配置接口，不提交 Relay task，不维护回复轮询。
- 真眼镜只读取按 Relay 与 SN 隔离保存的设备凭证；页面工具参数中的旧应用 token 只在没有设备 SN 的 Craft 调试环境兼容。旧的 Relay/token 输入、25 页配置仪表盘和上下分页 UI 已从 AIX 模板删除；后台动作方法仍保留给语音命令和助手调用。
- 查看当前 token 绑定的 PC Rabi。
- 在多台 PC Rabi 之间切换目标。
- 读取目标 PC 的 Route 列表。
- 读取 Route 的 Agent 选项。
- 保存 Route 的 Agent 绑定。
- 读取和保存 PC Rabi WebGUI 的 `gateways` 配置。
- 配置 Route 启用状态、消息入口、Agent、人格、模型、Pipeline preset、pipeline 覆盖字段和端口。
- 配置消息端策略 `messageAdapterPolicies`，包括单个消息端的输入启停、输出启停和 `text/image/voice/file` 输出能力。
- 配置 `napcatInstances`，包括实例 ID、名称、启停、WS 端口、HTTP/WebUI 地址、token、启动命令、工作目录和 Bot 信息。
- 配置 `pipeline` 覆盖字段，包括输入/输出适配端、输出管道、提示词输出模式、TTS provider/voice/worker、播放建议、防回流和是否回复来源。
- 配置 `routeProfiles`，包括 Profile ID、名称、启停、角色、角色文件、目录、最近消息数量、pipeline preset 和变量 JSON。
- 新增 Route 草稿、复制当前 Route 草稿、确认后移除当前 Route 草稿，并在“保存配置”后写回 PC。
- 上移/下移当前 Route 草稿顺序，并在“保存配置”后写回 PC。
- 添加、编辑、移除 Route Variables 草稿，并在“保存配置”后写回 PC。
- 添加、编辑、启停、移除 `notificationRules` 草稿的常用字段，包括入口类型、目标群、匹配正则和 Agent 消息包装模板。
- 添加、编辑、启停、移除 `notificationRules[].schedules` 草稿，支持 `interval`、`daily_time`、`once_at` 三种计划类型。
- 配置群聊、@、直接回复、间接回复、私聊、心跳和语音转写等通知模板，留空可恢复默认模板。
- 配置消息端集成字段，包括 Webhook/FenneNote/小爱/RabiLink 路径、RabiLink host、心跳、企业微信和远端 Agent 默认目标。
- 配置 PC Rabi 实例名、全局 RabiLink Relay、route/roles 目录。
- 通过后台动作覆盖 `GatewayDefinition` 字段，启动、停止、重启 Route，并发送手动触发消息。
- 通过后台动作调用 PC WebGUI 的 Manager、网络、Agent、NapCat、Copilot、Marvis、AstrBot 和远端 Agent 能力；高风险动作会在眼镜端二次确认。
- 两种模式始终留在同一个 AIUI 页面；连接对话页后滑进入助手，助手页前滑返回连接对话，不创建第二个页面或原生 `scroll-view`。
- 连接对话和配置助手共享 AIUI 原生 `SpeechRecognition` 的单轮状态机，不并发启动；前者转发自由语音，后者使用页面内原生 `LanguageModel` 理解自然语言并触发白名单工具。外层 Agent 仍可直接传入明确 `intent`。
- 直接使用 AIUI 原生 `speechSynthesis` 播报连接对话下行消息和配置操作结果，不接第三方 TTS。
- 当前官方 `speechSynthesis` 文档只公开 `speak(utterance, mode?)`，没有承诺完整 utterance 生命周期事件，也没有公开 `cancel()`。页面使用文档定义的 `enqueue` 模式；宿主若不回调 `onend/onerror`，由保守的文本时长 watchdog 结束麦克风占用并恢复 ASR，避免配置助手说完一句后永久停住。单条消息连续失败 3 次后会保留在持久队列但让出队首，后续主动消息仍可播报；连接对话单击触摸板可重试失败项。
- AIUI 运行状态、原生 ASR/TTS/LanguageModel 错误和安全 console 摘要会异步写入 Relay 眼镜云日志；断网时按 token 指纹在本地保留最多 500 条、7 天，恢复网络后分批补传。ASR 原文、配置需求原文、Agent 回复和 token 不进入诊断日志。

AIUI / 眼镜适配：

- 页面按当前 Craft Interactive InkView 的 480×352 surface 实现：主题宽度默认 480px，HUD 高度封顶为 352px；黑底、绿色 token、边框表达层级。
- 448×150 非沉浸式入口和 480×352 沉浸界面复用同一棵 87px HUD：两种模式共享双段滑轨、运行状态、最新一句、左下时间和右下电量。Craft 自带的“初始化成功 / 进入 / 尺寸”底栏仍由宿主绘制。
- 连接对话和配置助手都从视野下沿向上生长；HUD 上方保留真实视野空场，正文不使用发光底色。
- 两种界面使用同一条双段滑轨显示当前模式：左侧是`连接对话`，右侧是`配置助手`，选中框随状态移动，并保留一行低强调的“滑动切换”提示。
- 暂停、继续和重试位于滑轨下方，只用图标加文字表达，不使用矩形按钮，也不与模式切换处在同一视觉层级；配置助手不显示伪“说话”按钮。
- 共享 HUD 左下角显示 `HH:mm` 时钟图标，右下角显示发布版本、电池图标与百分比；充电时电池内显示充电标记。发布版本由 `craft-release.json` 在构建时注入，当前显示为 `v1.0.23`。
- 两种尺寸下的标题、状态、正文、操作和设备状态都使用固定行高与显式裁剪，避免眼镜宿主字体度量大于 Craft 预览时把文字画进相邻行。
- 当前公开 AIUI 文档没有承诺可直接读取眼镜电量/充电的页面 API。页面只接受 Relay 中由 RabiLink 手机端 CXR 状态服务上报、且未过期的真实眼镜状态；浏览器、手机宿主和小程序通用电量均不采信。状态超过 3 分钟未更新时显示 `--`。
- 配置助手只展示“当前自然语言需求、原生 AI 状态、操作结果和必要时的重试”，复杂配置不再缩进眼镜里的管理后台。
- Craft 稳定环境使用 Ink 0.13。该运行时在 448×150 卡片复用同一个 InkView 并 resize 到 480×352 时，复杂 `scroll-view` 会阻塞事件循环。RabiLink AIUI 因此保持“单页面、零 scroll-view”，并用小型稳定 HUD 切换模式。
- 不使用红蓝等第二色表达状态；单绿色显示上用边框、透明度、文字和选中填充区分层级。

边界：

- AIUI 端不保存 PC Rabi 配置真源。Route、Agent、目录和实例信息仍以 PC Rabi WebGUI / Manager API 为准。
- 官方 API 把 `SpeechRecognition.start()` 定义为“一轮识别”。本项目用 `onend` 自动开启下一轮，只承诺 AIUI 页面处于前台时连续转写；页面隐藏、退出、锁屏或宿主回收后会停止，不能保证系统级 24 小时后台录音，也不是 FenneNote 式后台常驻服务。
- [官方 ASR 指南](https://js.rokid.com/AIUI/guide/basic-ai-asr?lang=zh-CN)和[语音识别 API](https://js.rokid.com/AIUI/api/ai-speech-recognition?lang=zh-CN)都要求开始识别前界面已经处于可交互状态，并禁止同一实例并发启动多轮识别。当前 Craft 浏览器实现只在对应的 Interactive InkView 已打开时接收 `startRecognition`；卡片阶段会忽略该请求。
- Craft 的浏览器 ASR 是调试模拟器，不读取电脑麦克风：点击麦克风后由页面开启 `SpeechRecognition`，再在 Craft 输入框中输入文字并回车，宿主把文字注入成 `speech.result`。本项目以 Ink 的 `navigator.getDeviceSerialNumber()` 是否有宿主设备身份来区分启动策略；无设备身份时等待交互唤醒，有设备身份的眼镜端才自动开始前台转写。
- 页面 JavaScript 没有递归调用 Rokid 原生 Agent Loop 的公开 API。沉浸页内使用的是 AIUI 原生 `LanguageModel.create()` 新会话，它支持 `tools/toolcall`，但不会自动继承已绑定灵珠智能体的记忆、变量和插件；页面外 Agent 仍可先归一化为 `intent`。
- Craft 当前把“上滑 / 下滑”分别注入 `ArrowUp / ArrowDown`。连接对话用 `ArrowDown / ArrowRight` 进入配置助手；配置助手用 `ArrowUp / ArrowLeft / Backspace` 返回连接对话。真机在模式切换后自动启动配置 ASR；Craft 浏览器仍需宿主麦克风唤醒。页面同时兼容浏览器 keyCode、Android DPAD keyCode 和 `detail` 包装事件。
- 眼镜端只通过 RabiLink Relay 访问已绑定 PC，不直接访问 PC 局域网端口。
- `rabilinkToken` 由智能体平台保存在记忆变量中，并在调用页面时临时注入；AIX 包、模型提示词和公开仓库都不保存真实 token。当前页面不读取或写入本地 token 设置，首次启动会删除旧包遗留的明文 token，并把旧 cursor/TTS 队列使用的首尾 token 片段迁移为不含凭证片段的稳定本地指纹。离线 observation、cursor 和未播完 TTS 都按该指纹隔离，切换 token 不会串队列。

导入 Craft 前，可通过 `RABILINK_AIUI_RELAY_URL` 在生成阶段覆盖 `utils/rabilink-defaults.js` 的公网 Relay 默认值。正式流程只使用页面工具参数引用的 `rabilinkToken`；眼镜页面不再提供 token 输入框。不要直接修改生成目录，也不要把真实 token 写进仓库或 AIX 包。

本地检查和打包：

```powershell
npm run check
npm run startup:safety
npm run startup:soak
npm run interactive:resize
npm run interactive:resize:daily
npm run craft:headless
npm run package:aix
npm run readiness
npm run craft:staging
npm run craft:upload:dryrun
npm run craft:status
npm run craft:open-embedded-helper
npm run delivery
npm run delivery:verify
npm run acceptance:local
npm run phone:inspect
npm run phone:inspect:deep
npm run phone:inspect:store
npm run runtime:proof
npm run device-status:e2e
npm run goal:evidence
npm run push:phone
```

`npm run check` 会检查配置覆盖和 Relay 合约，审计 480×352 黑绿 HUD、下沿布局、双段模式滑轨、无按钮次级操作、时间/电量角标、单页面和首屏高度预算；随后验证 85 条白名单配置动作、原生 `LanguageModel` 工具调用、严格外层 Agent intent、输入事件确认、持续下行流、无任务主动投递、TTS/ASR 麦克风交接、真实 CXR 眼镜电量、20 次同页模式往返、转场非黑帧、本地真实 Ink 包渲染、启动安全和最终 AIX 结构。125% 字体压力使用 `RABILINK_AIUI_INK_FONT_SCALE=1.25` 的独立 Ink 夹具验证，不会改写交付 AIX。`npm run startup:safety` 可单独模拟“编辑器预览 + 运行智能体”并发存在、ASR 错误或瞬间空结束的场景；`npm run startup:soak` 会继续运行约 22 秒，确认第 5 次连续失败后停止自动重试。报告分别写入 `dist/ink-startup-safety.json` 和 `dist/ink-startup-soak.json`。`pages/home/index.ink` 是唯一维护真源；生成器会把它拆成传统四文件页面，并用 esbuild 把所有本地 `utils` 内联进 `pages/home/index.js`。

`npm run delivery:verify` 不会重新解释源码来冒充交付包：它直接读取 `dist/rabilink-aiui.aix`，逐文件与当前源码构建比对，并让这个最终 AIX 在真实 Ink 运行时完成模式切换。`npm run acceptance:local` 会串行执行本地验收矩阵并写入 `dist/local-acceptance.json`；报告明确区分“本地验收完成”和“真实眼镜验收尚缺”，避免把模拟器结果写成真机结论。

启动阶段只允许 `onLoad` 计算并提交首帧所需的轻量状态。当前 Ink 0.14 / Craft 运行链路不会可靠触发页面 `onReady`，因此不能把后台启动只挂在 `onReady` 上；`onLoad` 末尾只登记定时任务，等 `openBundle()` 返回后再依次读取本地状态、连接 Relay、启动 ASR。当前时序是首帧后约 160ms 激活本地状态，再延迟 120ms 执行网络工作，真机 ASR 再延迟到约 640ms 启动。

Craft 当前 Ink 运行时会在包含大量顶层 `ink:if` 抑制节点时进入同步 `apply_ops` / `child_sync_parents` 循环，也可能在卡片放大后留下旧树的局部绘制。页面因此只挂载一棵共享 87px HUD；只有模式切换会触发 1px 有界重排并重放 HUD 字段，时钟、ASR、消息等普通更新不会再隐藏整帧。旧的 25 页配置树、独立卡片树和并行模式树都已删除。`npm run craft:headless` 会在独立无头 Chrome 中真实导入 `dist/rabilink-aiui.aix` 并验证 Craft 能解析页面和 Schema；真实 Ink 烟测还会检查模式标题像素完整度、转场最小亮像素和左右安全区，并拒绝任何 `apply_ops is still spinning` 或 `child_sync_parents` 日志。

Craft 打包页会在“运行智能体”后先以 448×150 卡片创建 InkView，再在点击“进入”时把同一 canvas 移入 480×352 弹窗并调用 `resize(..., { resetScroll: false })`。`npm run interactive:resize` 会在 Ink 0.13 上精确复现这条路径，在转写、配置两个入口各完成 20 次模式往返，并逐行检查品牌、模式轨、状态、消息和底栏五个像素带，不能再用“画面有亮点”冒充完整重绘；`npm run interactive:resize:daily` 用 Ink 0.14 重复同样检查。

`npm run craft:staging` 生成唯一的 Craft 导入目录 `dist/craft-upload`。该目录不会同时保留 `.ink` 和传统四文件，也不会携带 `utils/`，避免 Craft 优先加载旧 `.ink` 或漏打模块。`npm run package:aix` 使用完全相同的自包含运行内容生成本地导入包，并在根写入自动生成的 UUID `VERSION`、`AGENTS.md` 和 `.aixignore`；正式发布 AIX 仍以 Craft 导入该目录后执行“打包”的结果为准。

`npm run check` 还会只读审计 Rokid Craft 前端 bundle，确认当前官方上传接口仍是 `POST /api/craft/project/upload-agent`，上传表单字段是 `file` 和 `metadata`，鉴权头是 `X-Account-Token`、`X-Account-ID`、`X-Craft-Region`。这个审计不会读取登录态，也不会上传文件；它只用于确认后续如果做脚本化上传，不是在猜网页实现。

`npm run craft:upload:dryrun` 会按官方 Craft 前端当前使用的上传合约预览即将上传的 AIX、SHA256 和 metadata，不会发起上传。真实上传需要显式设置临时环境变量并使用 `npm run craft:upload`：

```powershell
$env:ROKID_CRAFT_ACCOUNT_TOKEN="..."
$env:ROKID_CRAFT_ACCOUNT_ID="..."     # 如果 token 内无法解析 accountId，则需要填写
$env:ROKID_CRAFT_URL="https://js.rokid.com/craft?defaultAgentId=...&region=cn&lang=zh-CN"
# 或者直接设置 $env:ROKID_CRAFT_AGENT_ID="..." 作为目标智能体 ID
npm run craft:upload:dryrun
npm run craft:upload
Remove-Item Env:ROKID_CRAFT_ACCOUNT_TOKEN
Remove-Item Env:ROKID_CRAFT_ACCOUNT_ID -ErrorAction SilentlyContinue
Remove-Item Env:ROKID_CRAFT_URL -ErrorAction SilentlyContinue
Remove-Item Env:ROKID_CRAFT_AGENT_ID -ErrorAction SilentlyContinue
```

上传端点返回的是 SSE 流。HTTP 200 只说明流已建立，不能单独判定上传成功；必须看到 `done`，并拒绝任何 `error` 事件。`metadata.tools` 也不能留空：当前单页应包含 `index` function、`target: _current`、`448 x 150` layout，以及来自 `pages/home/index.json` 的完整参数 schema。缺少时服务端会在 HTTP 200 流内返回“智能体缺少 tools 定义”。

命令行上传器会直接解包待上传 AIX，并从包内 `pages/home/index.json` 自动生成 `metadata.tools`；内嵌浏览器助手也由启动脚本从同一个 AIX 注入工具定义。普通浏览器助手带有同结构默认值，`npm run check` 会逐字段对照页面定义，Schema 变化但助手未同步时会直接失败。三个上传入口都把 HTTP 传输状态、SSE `done` 和 SSE `error` 分开记录，只有“HTTP 成功 + 收到 done + 没有 error”才会写成上传成功。

Craft 云端智能体名称和待发布版本的唯一真源是根目录 `craft-release.json`，当前本地目标为 `RabiLink 1.0.23`。它与 `package.json` 的本地开发包版本含义不同；AIX 页面也会显示这个版本，重新上传前检查会阻止浏览器助手继续携带旧版本。云端实际版本以 Craft 项目列表为准，本地文档不把历史上传记录当作当前状态。

`ROKID_CRAFT_URL` 可以直接粘贴当前 Craft 地址；脚本会从 `defaultAgentId` / `agentId` / `botId` 和 `region` 参数解析上传目标。上传后运行 `npm run craft:status` 会调用 `GET /api/craft/project/agents`，检查账号里是否能匹配到 `RabiLink AIUI`、`ROKID_CRAFT_AGENT_ID` 或 `ROKID_CRAFT_URL` 中的智能体 ID，并把报告写到 `dist/craft-upload-status.json`。脚本不会从浏览器 Cookie 或登录态里抓 token，也不会把 token 写进项目文件；没有 `-Execute` 时只做 dry-run。

如果 Chrome 已经登录 Craft，但不想把 `ROKID_CRAFT_ACCOUNT_TOKEN` 暴露给 PowerShell 或 Codex，可以用浏览器同源上传助手：

```text
scripts/craft-browser-upload-helper.js
```

最短准备命令：

```powershell
$env:ROKID_CRAFT_URL="https://js.rokid.com/craft?defaultAgentId=...&region=cn&lang=zh-CN"
npm run craft:open-browser-helper
Remove-Item Env:ROKID_CRAFT_URL -ErrorAction SilentlyContinue
```

这会打开 Craft，并把 `craft-browser-upload-helper.js` 放进剪贴板；它不会读取或导出账号 token。

打开目标 Craft 页面，例如 `https://js.rokid.com/craft?defaultAgentId=...&region=cn&lang=zh-CN`，在该页面 DevTools Console 里粘贴整个 helper 内容。它会在页面右下角插入 `RabiLink AIUI Craft Upload` 面板：选择 `dist/rabilink-aiui.aix`，点击 `Check session`、`Upload selected AIX`、`List agents`、`Download report`。这个 helper 只在 `js.rokid.com` 同源页面内读取 Craft session 并发起官方 `POST /api/craft/project/upload-agent`，不会打印账号 token，也不会把 token 写进文件。下载的 `rabilink-aiui-craft-upload-report.json` 只包含上传状态和账号可见性证据。

如果 Chrome 扩展选择本地 `.aix` 时返回 `Not allowed`，可以改用内嵌 AIX 助手。它会把当前 `dist/rabilink-aiui.aix` 作为 base64 放进剪贴板脚本，在 Craft 同源页面内直接构造 `File` 上传，不需要 Chrome 的本地文件访问权限：

```powershell
npm run craft:open-embedded-helper
```

在 Craft 页面 DevTools Console 粘贴后，点击 `Check session`、`Upload embedded AIX`、`List agents`、`Download report`。这个路径同样不会打印账号 token；区别只是 AIX 文件字节会内嵌在你粘贴的脚本里，并上传到当前 Craft 账号。

下载报告后，把它导入项目证据：

```powershell
npm run craft:import-browser-report
npm run goal:evidence
```

也可以在点击 `Download report` 前先开一个等待器；报告下载完成后会自动导入并刷新 `dist/goal-evidence.json`：

```powershell
npm run craft:watch-browser-report
```

默认会从 `Downloads\rabilink-aiui-craft-upload-report.json` 读取，也可以显式指定：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Import-RabiLinkAiuiBrowserCraftReport.ps1 -BrowserReportPath "C:\path\to\rabilink-aiui-craft-upload-report.json"
```

眼镜端真机运行后，可以让 Relay 侧证明它确实启动过、连过 Relay、绑过 PC 或读写过 PC WebGUI 配置。先在 RabiLink 智能体中把页面工具的 `token` 参数引用到 `rabilinkToken`，再让 Agent 调起目标 UI；需要验证保存链路时，再由用户在页面中执行一次明确允许的配置保存。随后在本地查询：

```powershell
$env:RABILINK_AIUI_RELAY_URL="https://your-relay.example.com"
$env:RABILINK_AIUI_TOKEN="..."
npm run runtime:proof
Remove-Item Env:RABILINK_AIUI_TOKEN
Remove-Item Env:RABILINK_AIUI_RELAY_URL -ErrorAction SilentlyContinue
```

报告会写到 `dist/runtime-proof-status.json`。默认只接受 `app-start`、`relay-connected`、`pc-bound`、`webgui-config-loaded`、`webgui-config-saved` 这些真实 app 行为事件；本地 smoke 的 `smoke-runtime` 不会被当作眼镜运行证据。

眼镜电量不依赖 AIUI 未公开的原生电量 API。手机端 `com.rabi.link` 使用已保存的 Rokid 授权建立“仅状态”CXR 服务连接，不配置 CXR session，也不打开 Custom View；每分钟读取 `GlassInfo.batteryLevel / ischarging`，再以同一个 RabiLink 应用 token 写入 `POST /api/rabilink/mobile/device-status`。AIUI 从 `GET /api/rabilink/mobile/state` 读取未过期状态。首次使用时，在手机 RabiLink 中用与智能体相同的 Relay URL 和应用 token 成功连接一次，之后低优先级前台服务会持续同步。

已经有运行中的手机状态服务时，可让编译后的 AIUI 页面直接读取真实 Relay 状态并生成无 token 报告：

```powershell
$env:RABILINK_E2E_RELAY_URL="https://your-relay.example.com"
$env:RABILINK_E2E_TOKEN="..."
npm run device-status:e2e
Remove-Item Env:RABILINK_E2E_TOKEN
Remove-Item Env:RABILINK_E2E_RELAY_URL
```

报告写入 `dist/device-status-e2e.json`，只保存电量、充电状态、来源和检查时间。

`npm run readiness` 会检查 AIX 包内容、源码排除、token 形态和 ADB 设备列表。手机 CXR/编译页设备报告默认只在最近 10 分钟内有效，旧电量截图或历史 JSON 不会被当作当前连接。真正要把“已检测眼镜”作为验收条件时，运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Test-RabiLinkAiuiReadiness.ps1 -RequireGlass
```

`npm run goal:evidence` 会按原始目标生成 `dist/goal-evidence.json`：AIUI 设计、WebGUI 配置覆盖、Relay 绑定、AIX/delivery、手机安装面、Craft 上传状态、眼镜设备和眼镜运行测试会分别给出 `status`、证据路径和下一步。眼镜运行测试只接受当前发布版本、20 分钟内、同一页面 session 同时包含 `app-start` 和 Relay/配置操作的 `dist/runtime-proof-status.json`；旧包或孤立历史事件不能冒充本次真机运行。这个脚本用于防止把“包已准备好”误当成“已经装到眼镜并测试完成”；需要严格验收时可加 `-RequireComplete`。

Craft 浏览器中的模式切换和模拟 ASR 重绘证据写在 `dist/craft-render-acceptance.json`。在线采样使用 `canvas.getImageData()` 冻结同一帧，再复制到离屏 Canvas 编码 PNG；不要用 Playwright 元素截图或直接 `canvas.toDataURL()` 判断局部重绘，因为 Craft 持续渲染时这两种二次读回可能产生截屏撕裂。仓库中的现有报告属于历史 AIX，不能证明当前 1.0.23；重新上传后必须核对报告内的 AIX VERSION/SHA256，并同时要求 `partial_frames = 0`、`black_frames = 0`。这仍只代表 Interactive InkView，不代表真实眼镜验收。

如果当前只能连到手机，也可以先确认手机端 Hi Rokid / Rokid companion 前置条件：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Test-RabiLinkAiuiReadiness.ps1 -RequireRokidCompanionApp
```

`npm run push:phone` 会把 `dist/rabilink-aiui.aix` 推到手机 `/sdcard/Download/rabilink-aiui.aix`，并在设备支持 `sha256sum` 时校验手机文件哈希。

`npm run phone:inspect` 会只读检查手机端 Rokid 伴侣安装面：ADB 设备、Rokid 相关包、手机上的 `rabilink-aiui.aix` 哈希、包声明的文件接收/深链入口，并写入 `dist/phone-install-surface.json`。默认不会启动手机 App，也不会上传文件。需要做深度 APK 字符串分析时运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Inspect-RokidAiuiPhoneInstallSurface.ps1 -PullApk
```

需要把 APK 字符串、`ecology://agent/manage` 深链、智能体管理 Activity 外部可启动性、当前手机 UI 层级和截图一起作为证据包时运行：

```powershell
npm run phone:inspect:deep
```

只想复查手机端公开 UI 路径时运行：

```powershell
npm run phone:inspect:store
```

这个检查会从 Rokid AI App 公开入口走到“主页 -> 智能体商店 -> 智能体管理 -> 搜索 RabiLink”，保存每一步截图到 `dist/phone-trace-*.png`，并把当前 Activity 写入 `dist/phone-install-surface.json`。它不点击安装加号，不提交提审，也不上传文件。

需要把手机端直接打开到智能体管理深链时，显式加：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Inspect-RokidAiuiPhoneInstallSurface.ps1 -OpenAgentManage
```

当前实测结论：Rokid AI App 的 APK 中能看到 `ecology://agent/manage`、`ecology://agent/dialogflow` 等智能体管理深链，以及 `Agent debug`、`Agent store`、`Install a new app`、`Upload files to glasses` 等安装/调试文案；但手机系统没有公开 `.aix` 文件打开入口，`ecology://agent/manage` 也不能从 ADB 外部 intent 直接解析打开。因此真机安装仍以 Craft 同步或 Rokid AI App 内部的眼镜应用管理 / AIUI 调试 / 智能体商店入口为准。

进一步用 `phone:inspect:deep` 实测：`com.rokid.ecology.agentStore.ui.manage.AgentManageActivity`、`MarkAgentActivity` 和 `DialogFlowActivity` 都会因 `Permission Denial / not exported` 拒绝 ADB 显式启动。也就是说手机端确实没有可从普通 ADB 直接跳到 AIUI 安装/上传页的公开入口；但从 Rokid AI App 主页点击“智能体商店”可以进入官方 `AgentStoreActivity`，右上角入口可以进入内部 `AgentManageActivity`。

2026-07-12 的真实发布排障还确认了一个更细的边界：`RabiLink 1.0.3` 在 Craft 显示“上传成功”后，手机智能体管理仍为空，商店搜索仍显示“没有找到匹配的智能体”。原因不是 AIX 未上传，而是 Craft 仍打开本地 `rabilink-aiui.aix` 工程，且云端版本尚未完成提审/审核。点击 Craft 左上项目名，在“云端项目”选择 `RabiLink 1.0.3` 后，顶部项目名变为 `RabiLink`，“提审”按钮才从“请先绑定灵珠智能体”恢复为可用。由此确定正式顺序是：上传 -> 切换云端绑定工程 -> 提审并等待审核 -> 手机商店添加 -> 同步眼镜。上传成功不能替代后四步。

`npm run delivery` 会重新生成 AIX、重新生成 Craft staging，然后产出一个干净交付包：

```text
dist/delivery/
  rabilink-aiui.aix
  craft-upload/
  scripts/
  install-manifest.json
  README-install.txt
```

同时它会复制一份到 ASCII 临时路径 `C:\Users\<you>\AppData\Local\Temp\RabiLink-AIUI-Delivery`，用于绕开部分网页文件选择器对中文路径或开发目录的处理问题。同一次 `npm run delivery` 只生成一个 UUID，并把它同时写进 AIX、`craft-upload/VERSION` 和 `install-manifest.json`；readiness 与 AIX 审计会拒绝三者不一致的交付物。清单还会记录 AIX 大小、SHA256、Craft 源文件列表和当前 ADB 设备摘要；`scripts/RabiLinkAiuiCraftMetadata.ps1` 是上传脚本共用的 AIX 页面元数据读取器。真实 token 仍然不会写入交付包。

如果要把 Craft 上传目录也作为硬性验收条件，先运行 `npm run craft:staging`，再运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Test-RabiLinkAiuiReadiness.ps1 -RequireCraftStaging
```

如果要把 `dist/delivery` 交付目录也作为硬性验收条件，先运行 `npm run delivery`，再运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Test-RabiLinkAiuiReadiness.ps1 -RequireDelivery
```

如果要把手机端安装面调查也作为硬性验收条件，先运行 `npm run phone:inspect`，再运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Test-RabiLinkAiuiReadiness.ps1 -RequirePhoneInstallSurface
```

如果要把 Craft 上传状态也作为硬性验收条件，先设置账号临时环境变量并运行 `npm run craft:status`，再运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Test-RabiLinkAiuiReadiness.ps1 -RequireCraftUploadStatus
```

官方真机发布/眼镜同步仍优先走 https://js.rokid.com/craft?region=cn&lang=zh-CN 。授权上传前先运行 `npm run craft:staging`；readiness 会确认 `dist/craft-upload` 只含一套自包含运行时页面，并排除源码 `.ink`、`utils/`、`dist/`、`scripts/`、`node_modules/` 和 package 文件。然后在 Craft 选择“导入本地文件夹”，准确选择 `dist/craft-upload` 本身，再点击“打包”生成官方 AIX。不要选择其父目录，也不要直接导入整个开发目录。

如果 Codex 通过 Chrome 插件自动选择本地文件失败，并出现 `Not allowed` 或文件选择器超时，需要在 Chrome 打开 `chrome://extensions`，进入 Codex extension 的 Details，开启 `Allow access to file URLs` 后再重试。也可以手动在 Craft 的导入菜单选择“本地 .aix”，文件为 `dist/rabilink-aiui.aix`；导入后再点击“打包”。

如果使用自建 Relay，可以只给私有构建注入 Relay URL；token 仍由智能体变量在运行时注入：

```powershell
$env:RABILINK_AIUI_RELAY_URL="https://your-relay.example.com"
npm run package:aix
npm run craft:staging
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Test-RabiLinkAiuiReadiness.ps1 -ExpectedRelayBaseUrl $env:RABILINK_AIUI_RELAY_URL -RequireCraftStaging
Remove-Item Env:RABILINK_AIUI_RELAY_URL
```

也可以只给 Craft staging 指定：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Prepare-RabiLinkAiuiCraftUpload.ps1 -RelayBaseUrl "https://your-relay.example.com"
```

可说的命令：

- 切到配置助手 / 切到连接对话
- 任意自然语言需求，例如“帮我看看为什么回复变慢了”；未匹配快速命令时会交给 PC Rabi
- 连接服务器
- 绑定这台 PC
- 读取配置 / 保存配置
- 启用路由 / 禁用路由
- 启用消息 / 禁用消息
- 读取路由
- 读取代理
- 保存绑定
- 读取网络
- 扫描 Agent
- 扫描消息端
- 检查 NapCat
- 配置 NapCat / 配置 OneBot / 修复 NapCat
- 验证 AstrBot
- 启动 Manager
- 启动路由 / 停止路由 / 重启路由
- 手动触发
- 新增路由 / 复制路由 / 移除路由
- 上移路由 / 下移路由
- 添加变量 / 应用变量 / 移除变量 / 上一个变量 / 下一个变量
- 添加规则 / 应用规则 / 移除规则 / 启用规则 / 停用规则 / 上一个规则 / 下一个规则
- 添加计划 / 应用计划 / 移除计划 / 启用计划 / 停用计划 / 上一个计划 / 下一个计划
- 应用模板 / 清空模板 / 上一个模板 / 下一个模板
- 应用集成
- 应用策略 / 输入策略 / 输出策略 / 上一个策略 / 下一个策略
- 添加 NapCat / 应用 NapCat / 移除 NapCat / 启用 NapCat / 禁用 NapCat / 上一个 NapCat / 下一个 NapCat
- 应用管道 / 清空管道 / TTS 播放 / 防回流 / 回复来源 / 上一个输出管道 / 下一个输出管道 / 上一个输出模式 / 下一个输出模式
- 添加 Profile / 应用 Profile / 移除 Profile / 启用 Profile / 禁用 Profile / 上一个 Profile / 下一个 Profile
- 上一个 / 下一个

参考文档：

- [AIUI 框架与逻辑开发笔记](docs/aiui-framework-and-logic-development.md)
- [AIUI 视觉设计与主题 Tokens](docs/aiui-visual-design-system.md)
- [AIUI 交互设计与 RabiLink 输入合同](docs/aiui-interaction-design.md)
- [AIUI Canvas 2D 接口速查](docs/aiui-canvas-2d-reference.md)
- [AIUI A2UI 组件与 RabiLink 使用边界](docs/aiui-a2ui-notes.md)
- [AIUI 全局运行时 API 与 RabiLink 使用边界](docs/aiui-global-runtime-reference.md)
- [安装、使用与排障](docs/installation-and-troubleshooting.md)
- [验收报告](docs/acceptance-report.md)
- https://js.rokid.com/AIUI/guide/quickstart-intro?lang=zh-CN
- https://js.rokid.com/AIUI/api/basic?lang=zh-CN
- https://js.rokid.com/AIUI/design/visual?lang=zh-CN
- https://js.rokid.com/AIUI/design/interaction?lang=zh-CN
- https://js.rokid.com/AIUI/components/view-containers?lang=zh-CN
