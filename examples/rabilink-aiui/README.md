# RabiLink AIUI

RabiLink AIUI 是 Rokid 眼镜上的 Agent 消息端。首页只有两个可滑动切换的模式：`连接对话`和`配置助手`。

安装、提审、手机添加、眼镜同步和已复现故障统一记录在 [docs/installation-and-troubleshooting.md](docs/installation-and-troubleshooting.md)。按原始需求逐项核验的当前结论与证据索引见 [docs/acceptance-report.md](docs/acceptance-report.md)。遇到“请先绑定灵珠智能体”、上传后手机搜不到、AIX 无法从手机打开、ADB Permission Denial、Craft ASR 不启动、进入沉浸界面卡死或电量显示 `--` 时，先按安装排障文档判断所处阶段。

主链路：

```text
打开或恢复连接对话
-> 原生 Agent 调用 pages/home/index(mode=transcription)
-> AIUI SpeechRecognition 前台自动续轮
-> AIX POST Relay /rokid/rabilink/input（只确认事件已接受）
-> 已绑定的 PC Rabi / Codex / 其他 Agent
-> 普通回复与主动消息写入同一条下行队列
-> AIX 按 cursor 持续消费 /rokid/rabilink/messages?stream=1
-> 眼镜原生 speechSynthesis 顺序播报

配置需求
-> 眼镜原生 Agent 先理解需求并归一化为明确指令
-> 原生 Agent 调用 pages/home/index(mode=configuration, intent=明确指令)
-> 配置助手直接调用现有 Relay mobile/WebGUI 后台动作
-> 页面显示并用眼镜原生 TTS 播报操作结果

主动智能
-> 定时器 / 规划器 / 其他 Agent POST /api/agent/replies
   targetType=rabilink, proactive=true, routeProfileId=<目标 Route>
-> RabiRoute POST Relay /worker/messages
-> 即使眼镜刚才没有说话，持续下行队列也会被唤醒并播报
```

不需要额外导入 RabiLinkMessage MCP/插件。输入事件、持续下行队列、主动投递和配置接口都由 AIX、Relay 与 RabiRoute 现有输出门覆盖。页面工具的 `token` 参数必须在智能体设置中引用记忆变量 `rabilinkToken`，不能由模型生成或向用户询问。

当前第一版支持：

- 作为带 JSON Schema 的 AIUI 页面工具被原生 Agent 调起，支持 `transcription` 和 `configuration` 两种模式。
- 由原生 Agent 以 `mode=transcription` 调起`连接对话`首页；每轮 `SpeechRecognition` 正常结束后，只在页面仍处于前台且用户未暂停、TTS 未占用麦克风时自动开始下一轮。
- Craft 浏览器中的 448×150 卡片即使收到 `mode=transcription` 也不自动启动 ASR；进入 Interactive InkView 后点击 Craft 麦克风，页面收到模拟唤醒事件后才开始识别。眼镜宿主注入设备身份时仍自动启动。
- ASR 错误或小于 800ms 的无结果快速结束会指数退避，连续失败 5 次后暂停并等待用户继续，避免 Craft/QuickJS 被识别器重建与重复渲染拖死。
- 最终 ASR 文本附带会话 ID、序号和时间戳，提交到 Relay 输入事件端点；断网时最多保留最近 100 段并按顺序补传。响应不向页面暴露 worker task 状态。
- 连接后始终按 `nextCursor` 消费全局持续下行流。普通回复和没有前置请求的主动消息进入同一显示、TTS 队列，不按 `taskId` 过滤，也不会在“任务完成”时关闭流。
- TTS 播报前中止当前 ASR，播报结束后再恢复下一轮，避免眼镜把自己的输出重新识别成输入。
- 切到配置助手时先停止当前连续 ASR，再在同一个 Interactive InkView 内显示对话 HUD；切回连接对话时恢复前台 ASR，不调用 `finish()`、不退出页面，也不要求再次点击“进入”。
- 配置助手只接收眼镜原生 Agent 归一化后的明确 `intent`，用严格命令匹配直接调用配置接口；不创建页面内单轮 ASR，不提交 Relay task，不维护回复轮询。
- 从页面工具参数临时接收 `rabilinkToken`。旧的 Relay/token 输入、25 页配置仪表盘和上下分页 UI 已从 AIX 模板删除；后台动作方法仍保留给语音命令和助手调用。
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
- 连接对话直接使用 AIUI 原生 `SpeechRecognition` 实现前台续轮；配置语义理解由眼镜原生 Agent 负责，不接第三方 ASR。
- 直接使用 AIUI 原生 `speechSynthesis` 播报连接对话下行消息和配置操作结果，不接第三方 TTS。

AIUI / 眼镜适配：

- 页面按当前 Craft Interactive InkView 的 480×352 surface 实现：主题宽度默认 480px，HUD 高度封顶为 352px；黑底、绿色 token、边框表达层级。
- 同一页面包含一张 448×150 非沉浸式入口卡：两种模式共享双段滑轨、运行状态、最新一句、左下时间和右下电量，不挂载第二张模式卡。Craft 自带的“初始化成功 / 进入 / 尺寸”底栏仍由宿主绘制。
- 连接对话和配置助手都从视野下沿向上生长；HUD 上方保留真实视野空场，正文不使用发光底色。
- 两种界面使用同一条双段滑轨显示当前模式：左侧是`连接对话`，右侧是`配置助手`，选中框随状态移动，并保留一行低强调的“滑动切换”提示。
- 暂停、继续和重试位于滑轨下方，只用图标加文字表达，不使用矩形按钮，也不与模式切换处在同一视觉层级；配置助手不显示伪“说话”按钮。
- 沉浸式 HUD 和 448×150 卡片的左下角显示 `HH:mm` 时钟图标，右下角显示电池图标与百分比；充电时电池内显示充电标记。
- 当前公开 AIUI 文档和 Ink `navigator` 没有承诺眼镜电量/充电 API。页面依次兼容 Web Battery、`wx.getBatteryInfo*`、`wx.getSystemInfo*`，以及 Relay 中由 RabiLink 手机端 CXR 状态服务上报的真实眼镜状态。Relay 状态超过 3 分钟未更新，或所有真实来源都不可用时显示 `--`，不会沿用过期百分比。
- 配置助手只展示“原生 Agent 指令、当前状态、操作结果和必要时的重试”，复杂配置不再缩进眼镜里的管理后台。
- Craft 稳定环境使用 Ink 0.13。该运行时在 448×150 卡片复用同一个 InkView 并 resize 到 480×352 时，复杂 `scroll-view` 会阻塞事件循环。RabiLink AIUI 因此保持“单页面、零 scroll-view”，并用小型稳定 HUD 切换模式。
- 不使用红蓝等第二色表达状态；单绿色显示上用边框、透明度、文字和选中填充区分层级。

边界：

- AIUI 端不保存 PC Rabi 配置真源。Route、Agent、目录和实例信息仍以 PC Rabi WebGUI / Manager API 为准。
- 官方 API 把 `SpeechRecognition.start()` 定义为“一轮识别”。本项目用 `onend` 自动开启下一轮，只承诺 AIUI 页面处于前台时连续转写；页面隐藏、退出、锁屏或宿主回收后会停止，不是 FenneNote 式后台常驻服务。
- [官方 ASR 指南](https://js.rokid.com/AIUI/guide/basic-ai-asr?lang=zh-CN)和[语音识别 API](https://js.rokid.com/AIUI/api/ai-speech-recognition?lang=zh-CN)都要求开始识别前界面已经处于可交互状态，并禁止同一实例并发启动多轮识别。当前 Craft 浏览器实现只在对应的 Interactive InkView 已打开时接收 `startRecognition`；卡片阶段会忽略该请求。
- Craft 的浏览器 ASR 是调试模拟器，不读取电脑麦克风：点击麦克风后由页面开启 `SpeechRecognition`，再在 Craft 输入框中输入文字并回车，宿主把文字注入成 `speech.result`。本项目以 Ink 的 `navigator.getDeviceSerialNumber()` 是否有宿主设备身份来区分启动策略；无设备身份时等待交互唤醒，有设备身份的眼镜端才自动开始前台转写。
- 页面 JavaScript 没有直接调用 Rokid 原生 Agent Loop 的公开 API。配置需求必须由页面外的原生 Agent 理解后，以 `mode=configuration` 和明确 `intent` 调起页面；页面不能在沉浸界面内递归调用原生 Agent。
- Craft 当前把“上滑 / 下滑”分别注入 `ArrowUp / ArrowDown`。连接对话用 `ArrowDown / ArrowRight` 进入配置助手；配置助手用 `ArrowUp / ArrowLeft / Backspace` 返回连接对话。配置页不占用下滑、右滑或确认键启动自己的 ASR。页面同时兼容浏览器 keyCode、Android DPAD keyCode 和 `detail` 包装事件。
- 眼镜端只通过 RabiLink Relay 访问已绑定 PC，不直接访问 PC 局域网端口。
- `rabilinkToken` 由智能体平台保存在记忆变量中，并在调用页面时临时注入；AIX 包、模型提示词和公开仓库都不保存真实 token。

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

`npm run check` 会检查配置覆盖和 Relay 合约，审计 480×352 黑绿 HUD、下沿布局、双段模式滑轨、无按钮次级操作、时间/电量角标、单页面和首屏高度预算；随后验证 85 条明确配置指令、严格 Agent intent、输入事件确认、持续下行流、无任务主动投递、TTS/ASR 麦克风交接、Web Battery、小程序兼容电量、Relay 手机状态、20 次同页模式往返、Craft Ink 渲染、启动安全和最终 AIX 结构。`npm run startup:safety` 可单独模拟“编辑器预览 + 运行智能体”并发存在、ASR 错误或瞬间空结束的场景；`npm run startup:soak` 会继续运行约 22 秒，确认第 5 次连续失败后停止自动重试。报告分别写入 `dist/ink-startup-safety.json` 和 `dist/ink-startup-soak.json`。`pages/home/index.ink` 是唯一维护真源；生成器会把它拆成传统四文件页面，并用 esbuild 把所有本地 `utils` 内联进 `pages/home/index.js`。

`npm run delivery:verify` 不会重新解释源码来冒充交付包：它直接读取 `dist/rabilink-aiui.aix`，逐文件与当前源码构建比对，并让这个最终 AIX 在真实 Ink 运行时完成模式切换。`npm run acceptance:local` 会串行执行本地验收矩阵并写入 `dist/local-acceptance.json`；报告明确区分“本地验收完成”和“真实眼镜验收尚缺”，避免把模拟器结果写成真机结论。

启动阶段只允许 `onLoad` 计算并提交首帧所需的轻量状态。当前 Ink 0.14 / Craft 运行链路不会可靠触发页面 `onReady`，因此不能把后台启动只挂在 `onReady` 上；`onLoad` 末尾只登记定时任务，等 `openBundle()` 返回后再依次读取本地状态、连接 Relay、启动 ASR。当前时序是首帧后约 160ms 激活本地状态，再延迟 120ms 执行网络工作，真机 ASR 再延迟到约 640ms 启动。

Craft 当前 Ink 运行时会在包含大量顶层 `ink:if` 抑制节点时进入同步 `apply_ops` / `child_sync_parents` 循环，也可能在连续 `setData` 后只重画最后变化的局部节点。页面因此只挂载一张共享紧凑卡和一个共享沉浸式 HUD；所有数据提交先遮罩当前 HUD、触发 1px 有界重排，解除遮罩时再重放全部 HUD 可见字段。旧的 25 页配置树和并行模式树都已删除。`npm run craft:headless` 会在独立无头 Chrome 中真实导入 `dist/rabilink-aiui.aix` 并验证 Craft 能解析页面和 Schema；真实 Ink 烟测还会检查模式标题像素完整度和左右安全区，并拒绝任何 `apply_ops is still spinning` 或 `child_sync_parents` 日志。

Craft 打包页会在“运行智能体”后先以 448×150 卡片创建 InkView，再在点击“进入”时把同一 canvas 移入 480×352 弹窗并调用 `resize(..., { resetScroll: false })`。`npm run interactive:resize` 会在 Ink 0.13 上精确复现这条路径，并在转写、配置两个入口各完成 20 次模式往返；`npm run interactive:resize:daily` 用 Ink 0.14 重复同样检查。

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

Craft 云端智能体名称和待发布版本的唯一真源是根目录 `craft-release.json`，当前本地目标为 `RabiLink 1.0.5`。它与 `package.json` 的本地开发包版本含义不同；此前云端已上传的是 1.0.4，重新上传前检查会阻止浏览器助手继续携带旧版本。

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

`npm run readiness` 会检查 AIX 包内容、源码排除、token 形态和 ADB 设备列表。真正要把“已测试眼镜”作为验收条件时，运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Test-RabiLinkAiuiReadiness.ps1 -RequireGlass
```

`npm run goal:evidence` 会按原始目标生成 `dist/goal-evidence.json`：AIUI 设计、WebGUI 配置覆盖、Relay 绑定、AIX/delivery、手机安装面、Craft 上传状态、眼镜设备和眼镜运行测试会分别给出 `status`、证据路径和下一步。眼镜运行测试以 `dist/runtime-proof-status.json` 里的真实 app 行为事件为准。这个脚本用于防止把“包已准备好”误当成“已经装到眼镜并测试完成”；需要严格验收时可加 `-RequireComplete`。

Craft 浏览器中的模式切换和模拟 ASR 重绘证据写在 `dist/craft-render-acceptance.json`。在线采样使用 `canvas.getImageData()` 冻结同一帧，再复制到离屏 Canvas 编码 PNG；不要用 Playwright 元素截图或直接 `canvas.toDataURL()` 判断局部重绘，因为 Craft 持续渲染时这两种二次读回可能产生截屏撕裂。报告中的 `partial_frames = 0` 只代表 Interactive InkView，不代表真实眼镜验收。

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

同时它会复制一份到 ASCII 临时路径 `C:\Users\<you>\AppData\Local\Temp\RabiLink-AIUI-Delivery`，用于绕开部分网页文件选择器对中文路径或开发目录的处理问题。`install-manifest.json` 会记录 AIX 大小、SHA256、Craft 源文件列表和当前 ADB 设备摘要；`scripts/RabiLinkAiuiCraftMetadata.ps1` 是上传脚本共用的 AIX 页面元数据读取器。真实 token 仍然不会写入交付包。

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

- https://js.rokid.com/AIUI/guide/quickstart-intro?lang=zh-CN
- https://js.rokid.com/AIUI/api/basic?lang=zh-CN
- https://js.rokid.com/AIUI/design/visual?lang=zh-CN
- https://js.rokid.com/AIUI/design/interaction?lang=zh-CN
- https://js.rokid.com/AIUI/components/view-containers?lang=zh-CN
