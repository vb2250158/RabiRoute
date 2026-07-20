# RabiSpeech 本机 TTS / ASR 服务

RabiSpeech 是 RabiRoute 内的本地语音服务插件。普通 HTTP API 不进入 Agent，也不读取会话；只有 RabiPC 中用户明确选择“提交 Route”时，转写文本才会作为消息进入路由。

```text
本机或任意远端客户端
  -> 本机 127.0.0.1:8781，或 RabiLink Relay + 通用应用 token
  -> RabiSpeech provider registry
  -> 本地 TTS / ASR worker
  -> WAV 或转写结果
```

阿里云、OpenAI 等付费 TTS/ASR API 已退出活动实现。旧云端文件只作归档，不参与 provider 发现、自动回退或运行时选择。

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

角色声线从 `data/roles/<RoleId>/voice/` 读取。把角色 ID 传给 `voice` 即可使用角色，不需要创建 Route 或绑定 Agent。TTS 播放由一条全局 FIFO 串行队列协调，跨 Route、会话、Agent、人格和模型都不抢播。

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
GET /openapi.json
POST /v1/microphone/start
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

必填 `file`；常用可选字段是 `model`、`language`、`response_format`。服务不接受通过请求远程安装模型或加载 Python 扩展。

为现有客户端保留两组同步兼容别名：

```http
POST /api/v1/services/audio/tts/SpeechSynthesizer
POST /api/v1/services/audio/asr/transcription
```

它们只是本地请求格式兼容层，不调用阿里云。ASR 别名只接受 `data:audio/...;base64,...`，不会下载任意远程 URL。

## RabiPC 语音消息端

RibiWebGUI 的“语音服务”页可：

- 查询当前电脑模型、人格、设备和预热状态；
- 选择模型与人格直接合成并播放；
- 在页面顶部切换 TTS / ASR 管理；
- 配置由 RabiSpeech 进程持有的本机麦克风，以动态 RMS、录音/转写双阈值、前置缓存和静音时长切句并本地转写；
- 查看当前模型需要的请求参数；
- 仅在用户明确选择时，把转写结果提交给 Route。

Route 的“消息适配器 → 语音消息端”展开区还提供一套芬妮笔记风格的实时链路面板，按 `麦克风 → VAD 切句 → 本地 ASR → Route 投递 → 回复与播放` 展示真实状态、计数器、最近事件和转写预览。柱状波形使用 RabiSpeech 采集的最近 120 个 100ms RMS 样本：安静、超过录音线、超过转写线分别使用不同颜色，并叠加录音、转写和自适应动态阈值线。消息端总开关只表示这条 Route 允许使用语音入口，不等于本机麦克风已经开始监听；必须在链路面板或语音服务页点击“开始语音聊天”。这两种状态会分开显示，避免把“配置已启用”误判为“语音已经送达”。

语音消息端投递的 `voice_transcript` 会让该 Agent 回合进入 `character-tts-dialogue` 状态。`AgentPacket` 注入 `characterTtsDialogue=true` 和强制回传说明；Agent 把与屏幕回复同义的短句交回 `/api/agent/replies` 后，Outbox 从当前 Route 冻结人格、声线、TTS 模型、语言、情绪指令与 `sessionId`，再进入 RabiSpeech 主机级 FIFO。这个自动状态只针对 `speech` / RabiSpeech 来源，不会让 QQ、角色面板或普通文字消息自动发声。

当前默认值沿用旧 FenneNote 本机配置：`faster-whisper/small`、中文、系统默认麦克风、16 kHz、自适应 RMS 阈值、录音线 `0.01`、转写线 `0.015`、阈值以下持续 `500 ms` 切句、最短 `1000 ms`、最长 `60000 ms`、前置缓存 `1500 ms`、输入增益 `1.0`。RabiSpeech 保留原有自适应系数 `2.5` 和余量 `0.004`。这些是本机起点，不是所有麦克风的通用最优值。

如果“说了很多但 Route 没有消息”，按链路面板从左到右判断：

1. 麦克风显示“未启动”：点击“开始语音聊天”；消息端总开关不能替代这一步。
2. 实时电平变化但“捕获片段”不增长：检查输入设备、底噪、录音线与动态阈值。
3. 已捕获但“识别成功”不增长：查看最近事件中的空片段、ASR 模型或识别错误。
4. 已识别但“Route 成功”不增长：确认当前监听绑定的 Route、自动投递开关和 Route 运行状态。
5. Route 成功但没有回复/播放：继续检查 Agent 投递记录、TTS 队列和播放错误。

运行事件只保存于当前 RabiSpeech 进程内，记录阶段、时间、模型、耗时和错误等诊断元数据，不复制转写正文；右侧“最近转写”是本机私有预览，服务重启后不会保留。

`POST /api/speech/messages` 使用真正的 `202 Accepted` 语义：Manager 完成 Route 校验并启动投递子任务后立即返回，Agent/Codex 继续在后台处理。RabiSpeech 的“Route 已受理”因此表示消息端已经接单，不表示 Agent 已完成回复；最终结果继续以 Route 投递记录和回复/播放阶段为准。旧实现会同步等待完整投递，Codex 首次接单超过 RabiSpeech 的 15 秒 HTTP 超时时会出现 `ReadTimeout`，即使消息稍后其实已经成功送达。

### RabiPC 前后端契约

RibiWebGUI 不直接访问 `8781`，只访问 Manager 的 `/api/speech/*`。Manager 对浏览器使用 camelCase 字段，例如 `routeId`、`recordThreshold`、`dynamicThreshold`、`lastSubmitError`；`src/manager/speechControl.ts` 再在本机 Adapter 内映射为 RabiSpeech `/v1/*` 使用的 snake_case。前端请求、轮询、错误 envelope 和共享状态集中在 `ribiwebgui/src/speech/speechControlClient.ts` 与 `ribiwebgui/src/stores/speechStore.ts`，页面不应自行新增 `fetch("/api/speech/...")`。

直接调用 RabiSpeech `/v1/*` 时仍按 OpenAI 兼容格式和本文示例使用 snake_case；调用 RabiPC Manager `/api/speech/*` 时使用 `src/shared/speechControlContract.ts` 定义的 camelCase 契约。两者不要混用。

VAD 在达到静音窗口后始终结束当前候选片段；若有效语音不足最短时长，则立即记录 `segment_discarded` 并回到监听。这样短促碰麦、系统提示音或单个噪声尖峰不会占住整段 `max_utterance_ms` 才释放。

关闭浏览器或离开页面不会停止常驻监听；配置写入被 Git 忽略的 `plugin-adapters/rabi-speech/microphone.json`，RabiSpeech 重启后会恢复 `enabled=true` 的监听。必须在 ASR 标签主动点击“停止本机监听”才会持久关闭。

常驻录音控制接口只允许本机 RabiPC/Manager 回环调用，不加入 RabiLink 通用 token 的公网 allowlist。远端客户端可以通过 RabiLink 调用普通 TTS/ASR API，但不能用同一个通用 token 开关这台电脑的麦克风。直接 TTS/ASR API 与 Agent 无关；“提交 Route”是独立、显式的消息端动作。

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

<!-- docs-language-switch -->
<div align="center">
<a href="./rabispeech-plugin_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->
