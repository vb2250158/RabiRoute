<!-- docs-language-switch -->
<div align="center">
<a href="./rabispeech-plugin_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# RabiSpeech TTS / ASR Provider 服务

RabiSpeech 是 RabiRoute 内、默认只监听回环地址的语音 Provider 服务。普通手动 TTS/ASR HTTP API 不进入 Agent，也不读取会话；常驻麦克风完成一段非空 ASR 后，由 Manager 把同一份文本广播给所有已开启“语音消息端”的 Route。各 Route 再独立执行 `speechPushMode=hot|keyword`，因此可以同时广播给多个人格，而不重复采集或重复跑 ASR。本地模型仍是默认值，OpenAI 兼容 API 与阿里云百炼 DashScope 只在本机配置显式启用后出现，不做本地到云端的静默回退。

```text
本机或任意远端客户端
  -> 本机 127.0.0.1:8781，或 RabiLink Relay + 通用应用 token
  -> RabiSpeech provider registry
  -> 本地 TTS / ASR worker，或显式启用的外部 API provider
  -> WAV 或转写结果
```

API key 只从 provider 配置点名的环境变量读取，例如 `OPENAI_API_KEY` 或 `DASHSCOPE_API_KEY`；配置、能力接口、日志和公开示例均不保存密钥。

## 当前模型

TTS：

- `onnx-vits`：固定声线，CPU，低资源。
- `gpt-sovits`：GPT-SoVITS 本地开源声线克隆；不是 OpenAI 云端 GPT TTS。
- `qwen3-tts-0.6b-base` / `qwen3-tts-1.7b-base`：本地 Qwen3-TTS 多语言参考音克隆。
- `indextts2`：中文克隆、情绪与时长控制。
- `cosyvoice3-0.5b`：本地 CosyVoice3，多语言、零样本与流式扩展能力。

ASR：

- `tiny` / `small` / `large-v3-turbo`：faster-whisper。
- `qwen3-asr-0.6b` / `qwen3-asr-1.7b`。
- `sensevoice-small`。
- `fireredasr2-aed`。

显式启用的 API 模型会和本地模型一起出现在 `/v1/models`，例如：

- `openai-api/gpt-4o-mini-tts`、`openai-api/gpt-4o-mini-transcribe`、`openai-api/whisper-1`；
- `dashscope-qwen/qwen3-tts-instruct-flash`：支持预置声线与角色发声指令；
- `dashscope-qwen/qwen3-tts-vc-2026-01-22`：使用已注册的 Qwen Voice Clone 声线。人格 `voice-profile.json` 只保存 `voice_env` 环境变量名，不保存真实 voice ID；
- `dashscope-qwen/paraformer-v2`：非实时会议转写，启用 speaker diarization，逐段返回 `speaker + start/end + text`。

会议模式复用 RabiSpeech 的本地静音切段，再提交 DashScope 异步文件转写任务。调用 `/v1/audio/transcriptions` 时选择 `model=dashscope-qwen/paraformer-v2`；语言会通过 `language_hints` 传入，已知参会人数时可额外传 `speaker_count`。结果按 `speaker + start/end + text` 返回；`SUCCESS_WITH_NO_VALID_FRAGMENT` 表示模型没有找到有效语音，RabiSpeech 将其记为空片段而不是服务故障，也不会重试。

Paraformer 文件转写的官方协议只承诺 `file_urls` 使用可公网访问的 HTTP / HTTPS URL，并明确不支持 Base64 音频、本地文件或二进制流。当前未配置正式上传器时仍存在 data URI 兼容路径；部分 DashScope 环境会把它临时转存到 OSS，但这不是公开生产合同。稳定部署应提供受控的临时上传 / OSS 签名 URL；在此之前，该兼容路径保持实验状态，不应作为高并发会议链路的可靠性保证。

角色声线从 `data/roles/<RoleId>/voice/` 读取。`voice/voice-profile.json` 是人格 TTS 配置唯一真源，统一维护模型、声线绑定、语言、语速和发声说明；Route 只维护语音消息端订阅、热/关键词投递与是否播放回复。主机麦克风、ASR 模型、VAD 和切句参数统一归 RabiSpeech。把角色 ID 传给 `voice` 即可使用角色，不需要创建 Route 或绑定 Agent。旧 Route TTS/ASR/VAD 字段仅作为兼容回退读取，不再由 WebGUI 新建或展示。TTS 播放由一条全局 FIFO 串行队列协调，跨 Route、会话、Agent、人格和模型都不抢播。

## 安装和运行

```powershell
cd plugin-adapters\rabi-speech
.\scripts\install.ps1
.\scripts\install_models.ps1 -List
.\scripts\test.ps1
.\scripts\start.ps1
.\scripts\install-service.ps1 -StartNow
```

默认只监听 `http://127.0.0.1:8781`。首次启动生成 Git 忽略的 `config.json`；模型、参考音、输出和私有绝对路径均不提交。

会议室远程声卡不改变这个控制面边界。在私有 `config.json` 启用 `remote_audio` 后，RabiSpeech 只额外开放带独立 Bearer 密钥的 TCP `8782` 音频 WebSocket 和 UDP `8783` 局域网发现。客户端只持续传 PCM、接收 WAV；VAD、切句、ASR、Route 广播、人格 TTS、FIFO 与防回流仍全部留在主机。安装见 [Rabi 语音客户端](../desktop/rabi-voice-client/README.md)。局域网直连不要求配置 RabiLink。

各模型下载、隔离环境和验证命令见 [本地语音模型下载说明](local-speech-model-downloads.md)。

## API 发现

先调用：

```http
GET /v1/models
```

响应包含 TTS/ASR 模型列表、安装状态、语言、功能，以及每个请求应传什么参数的 schema 和示例。其他发现接口：

```http
GET /health
GET /v1/capabilities
GET /v1/personas
GET /v1/microphone/status
GET /v1/microphone/devices
GET /v1/records
GET /openapi.json
POST /v1/microphone/start
PUT /v1/microphone/settings
POST /v1/microphone/stop
```

TTS：

```bash
curl -X POST "http://127.0.0.1:8781/v1/audio/speech" \
  -H "Content-Type: application/json" \
  -d '{"model":"local-tts/gpt-sovits","input":"你好，这是本机语音。","voice":"Rabi","response_format":"wav"}' \
  --output speech.wav
```

常用字段：`model`、`input`、`voice`、`language`、`instructions`、`response_format`、`speed`、`sample_rate`、`play`、`session_id`、`route_id`。最终以 `/v1/models` 返回的逐模型 schema 为准。

ASR：

```bash
curl -X POST "http://127.0.0.1:8781/v1/audio/transcriptions" \
  -F "file=@sample.wav" \
  -F "model=qwen3-asr-0.6b" \
  -F "language=zh" \
  -F "response_format=verbose_json"
```

必填 `file`；常用可选字段是 `model`、`language`、`response_format`、`speaker_count`、`session_id`、`route_id`。服务不接受通过请求远程安装模型或加载 Python 扩展。

为现有客户端保留两组同步兼容别名：

```http
POST /api/v1/services/audio/tts/SpeechSynthesizer
POST /api/v1/services/audio/asr/transcription
```

它们只是请求格式兼容层；最终使用本地还是 API provider 仍由显式选择的 provider/model 决定。ASR 别名只接受 `data:audio/...;base64,...`，不会替调用方下载任意远程 URL。

## RabiPC 语音消息端

RibiWebGUI 的“语音服务”页可：

- 查询当前电脑模型、人格、设备和预热状态；
- 选择人格直接合成并播放，模型、声线、语言、语速和表达方式从人格配置只读加载；
- 在全局播放队列卡用 `0–100` 滑条和精确输入调整主机音量；设置由 RabiSpeech 持久化，每条音频开始播放时读取，因此新值从下一条开始播放的音频生效，不属于 Route 或人格配置；
- 在页面顶部切换 TTS / ASR 管理；
- 配置由 RabiSpeech 进程持有的主机麦克风、ASR 模型、动态 RMS、录音/转写双阈值、前置缓存和静音切句；运行中修改会自动恢复监听；
- 像芬妮笔记一样在当前 ASR 区域查看最近转写预览，完整文本由后台按日期持续落盘；
- 查看当前模型需要的请求参数；
- 查看当前订阅 Route 数量；本页不再配置“投递 Route”或人工会话 ID。

Windows 会按 EXE 记住上一次 Core Audio 会话倍率。RabiSpeech 启动时建立一个持续无声的共享输出会话，把旧的 `1%` 只归一一次到 `100%`，随后只保活、不再回写音量。Windows 音量合成器中的 RabiSpeech 滑条因此在服务运行期间持续可调，真实播放复用同一会话；无声保活不进入 FIFO，也不触发麦克风防回流。

芬妮笔记风格的主机链路面板统一放在“语音服务 → ASR”，按 `主机麦克风 → VAD 切句 → ASR 转写 → 广播投递 → 回复与播放` 展示真实状态、计数器、最近事件和转写预览。Route 的“消息适配器 → 语音消息端”只保留当前 Route 的热投递/人格关键词策略、人格 TTS 摘要和回复自动播放开关，不再显示主机波形、计数器、运行日志或最近转写。语音消息端总开关仍是当前 Route 的订阅真源；关闭当前 Route 只取消自身订阅，最后一个订阅关闭后才停止主机麦克风。

语音消息端投递的 `voice_transcript` 会让该 Agent 回合进入 `character-tts-dialogue` 状态。`AgentPacket` 注入 `characterTtsDialogue=true` 和强制回传说明；Agent 把与屏幕回复同义的短句交回 `/api/agent/replies` 后，Outbox 绑定当前 Route 的人格 ID 和 `sessionId`，RabiSpeech 再从该人格的 `voice-profile.json` 解析模型、声线、语言、语速和表达指令，最后进入主机级 FIFO。这个自动状态只针对 `speech` / RabiSpeech 来源，不会让 QQ、角色面板或普通文字消息自动发声。

### 热投递与人格关键词

Route 的“热投递”开关直接对应 `adapterConfig.json.speechPushMode`：

- 开启（`hot`）：每段 ASR 转写完成后立即投递给已绑定 Agent；当前 Desktop turn 正在工作时使用 `steer`，否则使用 `start`。
- 关闭（`keyword`）：所有 ASR 仍然写入语音记录和人格双向会话账本；只在文本命中该人格 `personaConfig.json.speechTriggerKeywords` 中的人格名、常用称呼或唤醒词时才投递。
- 关键词列表为空时，转写会持续记录，但不会唤醒 Agent；系统不会暗中回退到 `hot`。

关键词归人格，因为同一个人格可能被多条 Route 复用；热/关键词模式归 Route，因为它决定这条语音入口的即时投递策略。

### ASR/TTS 双向上下文

RabiSpeech 自身按日保留 ASR/TTS 文本诊断记录；一旦语音经 Route 进入人格，RabiRoute 还会把 ASR 入站和成功 TTS 出站归一到：

```text
data/roles/<RoleId>/conversation/current.jsonl
```

Agent 的自动最近上下文只读当前人格、`speech` 逻辑消息端和同一 `sessionId` 的双向记录，ASR 与 TTS 合计占用 `recentMessageLimits.speech` 额度。该参数范围为 `0–200`，未设置时默认 `100`；`0` 只关闭自动注入，不停止记录。其他会话的 ASR/TTS 不会混入本次 AgentPacket。

当前默认值沿用旧 FenneNote 本机配置：`faster-whisper/small`、中文、系统默认麦克风、16 kHz、自适应 RMS 阈值、录音线 `0.01`、转写线 `0.015`、阈值以下持续 `500 ms` 切句、最短 `1000 ms`、最长 `60000 ms`、前置缓存 `1500 ms`、输入增益 `1.0`。RabiSpeech 保留原有自适应系数 `2.5` 和余量 `0.004`。这些是本机起点，不是所有麦克风的通用最优值。

如果“说了很多但某个 Route 没有消息”，在“语音服务 → ASR”的主机链路面板从左到右判断：

1. 麦克风显示“未启动”：确认至少一个 Route 的语音消息端总开关已打开；开关保存或服务恢复失败时查看面板错误和 RabiSpeech 状态。
2. 实时电平变化但“捕获片段”不增长：检查输入设备、底噪、录音线与动态阈值。
3. 已捕获但“识别成功”不增长：查看最近事件中的空片段、ASR 模型或识别错误。
4. 已识别但当前 Route 没有终态：确认该 Route 的语音消息端订阅和运行状态；若已关闭热投递，再检查文本是否命中该人格关键词。其他 Route 的成功不会冒充当前 Route 成功。
5. Route 成功但没有回复/播放：继续检查 Agent 投递记录、TTS 队列和播放错误。

运行事件仍只保存于当前 RabiSpeech 进程内，用于阶段、耗时和错误诊断。与芬妮笔记按日期写转写文件的方式一致，ASR/TTS 文本元数据统一追加到被 Git 忽略的 `plugin-adapters/rabi-speech/output/records/YYYY-MM-DD.jsonl`，并在服务重启后保留；WebGUI 在 ASR 页面内嵌展示最近的持久化双向记录，不再提供独立的会议记录选择、说话人摘录或导出卡片。默认不复制 ASR 原始录音。人格 TTS 的完成音频保存到对应的 `data/roles/<RoleId>/voice/cache/tts-audio/`；不属于已解析人格的直接 TTS 才使用 RabiSpeech 私有 fallback 缓存。两者都默认保留 `1440` 分钟（24 小时），按每个文件自己的 mtime 计算。记录 API 与 WebGUI 只暴露 POSIX 风格的安全逻辑相对路径：人格记录为 `<RoleId>/voice/cache/tts-audio/<file>`，fallback 为 `output/tts-audio/<file>`；旧记录可继续显示单个文件名，绝不返回本机绝对路径或包含 `..`、反斜杠越界的引用。界面显示的是“预计过期时间”，不代表清理任务已在该秒完成。文本记录与音频缓存互相独立，音频超过保留窗口不会删除文本记录；`GET /api/speech/records` 仅保留为诊断查询接口。

说话人身份分成两份本机真源：`output/speaker-profiles.json` 保存人物资料与 `recordId + speakerLabel` 人工绑定，`output/speaker-embeddings.json` 保存神经 embedding、人工确认原型和未知聚类。系统不把 diarization 的 `Speaker 1`、`0` 冒充身份，也不按长生命周期 `sessionId` 继承。原始注册音频不复制，embedding 不通过 API 返回。下拉确认仍只修正当前录音，同时把该样本加入人物多原型；后续自动判定必须同时通过有效语音时长、最高相似度和第一/第二名差距，任何低置信度结果都保持 unknown。

声纹模型在进入主进程前先由独立子进程做兼容探测。模型格式、ONNX/sherpa runtime 或 native 依赖不兼容时，主服务继续提供其他语音能力，并在 `voiceprint.reason` 暴露失败原因。人物确认原型按 `max_samples_per_profile` 保持有界，未人工确认的聚类和自动匹配样本按 `max_unconfirmed_samples` 保持有界；低于 `min_voiced_rms` 的帧和明显跨说话人重叠片段不进入 embedding 仓库。自动匹配结果不会反向成为训练原型，只有人工确认样本拥有原型解释权。

声纹匹配和多人分离是两层能力：前者回答“这段声音像谁”，后者回答“谁在什么时间说话”。只有 ASR 已返回可靠的 `speaker + start/end` 时才能分别提取多人 embedding；没有 diarization 标签的普通 ASR 会把一次 VAD 切片作为单个临时 `voice`，不能解决同一切片内轮流或重叠说话。

本机 RabiSpeech 控制面与 Manager 镜像接口保持不变。ASR 页按已知人物或跨录音未知声纹簇展示最近话语，并保留逐录音下拉纠正。默认 ERes2NetV2 模型需显式安装；模型缺失时回退纯人工模式。模型存在但 `validated=false` 时默认只做聚类和候选提示；本机只有显式设置 `experimental_auto_assign=true` 才允许带实验标记的自动认人，而且 capability 仍不会声明正式支持。完成本机基准并校准阈值后才可设置 `validated=true`。

`POST /api/speech/messages` 不再返回模糊的 `202 Accepted`。常驻麦克风省略 `routeId`，Manager 将一段文本广播给所有订阅 Route，并在 `deliveries[]` 中返回每个 Route 的独立终态；显式 `routeId` 只保留给调试和兼容调用。Manager 等待 Gateway 子任务返回 Desktop 投递终态（最多 40 秒），但不等 Agent 生成回答、Outbox 回传或 TTS 播放完成：

- `200` + `status=delivered`：目标 Desktop owner 已成功接受 `start` 或 `steer`。
- `200` + `status=recorded`：关键词模式下未命中，文本已完整记录，但未唤醒 Agent。
- `200` + `status=recorded` + `reason=no_enabled_speech_routes`：当前没有订阅 Route，转写保留在 RabiSpeech 记录中。
- `4xx/5xx`：显式 Route 不存在/未启用，或所有订阅 Route 均因 Desktop owner、IPC、超时等原因失败。

因此界面的“Desktop 已投递”和“仅记录”是两个真实终态；不能再用“Route 已受理”冒充 Desktop 已收到。

`server.tts_audio_dir`（或 `RABISPEECH_TTS_AUDIO_DIR`）现在只控制“未解析到人格”的 fallback，默认物理位置仍是 `plugin-adapters/rabi-speech/output/tts-audio/`。人格 TTS 缓存位置不受该参数改写，固定归对应角色目录。

### RabiPC 前后端契约

RibiWebGUI 不直接访问 `8781`，只访问 Manager 的 `/api/speech/*`。Manager 对浏览器使用 camelCase 字段，例如 `routeId`、`recordThreshold`、`dynamicThreshold`、`lastSubmitError`；`src/manager/speechControl.ts` 再在本机 Adapter 内映射为 RabiSpeech `/v1/*` 使用的 snake_case。前端请求、轮询、错误 envelope 和共享状态集中在 `ribiwebgui/src/speech/speechControlClient.ts` 与 `ribiwebgui/src/stores/speechStore.ts`，页面不应自行新增 `fetch("/api/speech/...")`。

直接调用 RabiSpeech `/v1/*` 时仍按 OpenAI 兼容格式和本文示例使用 snake_case；调用 RabiPC Manager `/api/speech/*` 时使用 `src/shared/speechControlContract.ts` 定义的 camelCase 契约。两者不要混用。

VAD 在达到静音窗口后始终结束当前候选片段；若有效语音不足最短时长，则立即记录 `segment_discarded` 并回到监听。这样短促碰麦、系统提示音或单个噪声尖峰不会占住整段 `max_utterance_ms` 才释放。

关闭浏览器或离开页面不会停止常驻监听；配置写入被 Git 忽略的 `plugin-adapters/rabi-speech/microphone.json`。Manager 启动、Route 保存和配置重载时都会按订阅重新协调：存在任意订阅就启动或保持监听，没有订阅才停止。旧 `route_id` 会迁移为 `null`，会话 ID 由主机内部生成和持久化，不是用户配置。

常驻录音控制接口只允许本机 RabiPC/Manager 回环调用，不加入 RabiLink 通用 token 的公网 allowlist。远端客户端可以通过 RabiLink 调用普通 TTS/ASR API，但不能用同一个通用 token 开关这台电脑的麦克风。直接手动 TTS/ASR API 与 Agent 无关；常驻 ASR 是否进入某条 Route 只由该 Route 的语音消息端订阅决定。

## RabiLink 中转

```text
客户端
  -> https://<relay>/api/rabilink/speech/*
  -> 应用通用 token 鉴权
  -> 选中的在线 PC 主动领取
  -> 固定回环 RabiSpeech
  -> 原 HTTP 请求同步返回
```

在 WebGUI 打开 RabiLink Relay 和“允许语音中转”，本机语音地址保持 `http://127.0.0.1:8781`。Manager 拒绝将语音代理目标改成局域网或公网地址。

鉴权可用：

```http
Authorization: Bearer <RabiLink 应用 token>
```

或：

```http
X-RabiLink-Token: <RabiLink 应用 token>
```

公网 Base URL 是 `https://<relay>/api/rabilink/speech`，因此常用完整路径为：

```http
GET  https://<relay>/api/rabilink/speech/health
GET  https://<relay>/api/rabilink/speech/v1/models
POST https://<relay>/api/rabilink/speech/v1/audio/speech
POST https://<relay>/api/rabilink/speech/v1/audio/transcriptions
```

不要把本机的 `http://127.0.0.1:8781/v1/...` 原样交给远端客户端。可复制的 PowerShell TTS、ASR、成功判据和错误恢复见[从远端调用 TTS 与 ASR](user-guide/speech-api.md)。

Relay 只在短时内存队列中保留请求/响应体；日志不记录正文、音频、请求头或响应正文。公共 OpenAPI 真源在 `examples/rabilink-relay/rabilink-speech-api.openapi.json`。

## Provider 扩展

provider 是本机插件扩展点，不是 Agent adapter。新增实现需：

1. 实现 `TtsProvider` 或 `AsrProvider` Protocol；
2. 提供 `register(registry, settings)`；
3. 由本机管理员在 `providers.extensions` 中登记模块。

远程调用方只能选择已注册模型，不能加载代码、下载模型或改变 allowlist。

## 性能、预热与硬件

首轮包含六个 TTS 和五个主要 ASR 的实机冷/热态测试，覆盖功能、模型体积、测试硬件、建议配置、效果代理指标、CUDA DLL 与 FireRed Windows 依赖问题：

- [RabiSpeech 性能与功能报告](rabispeech-performance-report.md)
- [独立 HTML 报告](../ribiwebgui/public/reports/rabispeech-model-benchmark.html)

报告中的冷请求包含 worker 启动、模型加载/预热和首次推理；热请求只测已加载 worker 的后续推理。不同电脑必须重跑，不能把 RTX 4080 SUPER 的数字当作所有机器的 SLA。

## CUDA DLL 排障

典型现象是 CPU 能运行，但 GPU 首次推理报告缺少 `cublas64_12.dll` 或 `cudnn64_9.dll`。`nvidia-smi` 的 CUDA 数字只表示驱动兼容上限。

RabiSpeech 使用 NVIDIA 官方 Windows Python wheels，把运行库安装到插件私有 `.deps`，启动时只为该进程追加 DLL 路径，不修改系统 PATH。修复后必须执行一次真实推理，并在 `/v1/capabilities` 检查实际设备、加载状态和 `warmup_error`；只测试 import 不足以验收。

## 当前限制

- HTTP 接口当前返回完整结果，尚未承诺流式首包。
- 默认上传上限 25 MiB；大模型冷启动可能超过旧版 180 秒客户端超时，应按部署机器调整。
- 16 GiB 显存使用单个 GPU worker 按需加载；全局 FIFO 负责避免并发抢占。
- 麦克风设备由运行 RabiSpeech 的那台 PC 提供；不要选择会混入扬声器的虚拟输入。TTS 播放期间会暂停触发并清空当前片段，但真实环境的回声、连续切句和阈值仍需用户按麦克风调校。
- 公网 RabiLink 的 TTS/ASR 延迟仍需客户端所在网络单独验收；麦克风开关不经公网中转。
