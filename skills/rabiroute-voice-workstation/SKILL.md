---
name: rabiroute-voice-workstation
description: 设计、实现或审查 RabiPC 语音消息端与 RabiSpeech TTS/ASR 工作站。覆盖常驻麦克风、RMS/VAD 切句、Route 热投递/人格关键词唤醒、双向语音上下文、直接人格 TTS、24 小时音频缓存、显式 API Provider、会议说话人分离、主机级 FIFO 和公开安全边界。不得恢复对 FenneNote 或 OumuQ 的运行时依赖。
---

# RabiPC 语音工作站

## 系统边界

```text
浏览器麦克风 / 音频文件 / HTTP 客户端
  -> RabiPC 语音消息端
  -> RabiSpeech 本地 TTS / ASR，或用户显式启用的 API Provider
  -> 可选 RabiRoute Route / Agent
  -> RabiSpeech 主机级 FIFO 播放
```

RabiSpeech 的普通手动 TTS/ASR API 不接入 Agent。常驻麦克风完成非空转写后只向 `POST /api/speech/messages` 提交一次且不指定 Route；Manager 广播给所有已启用语音消息端的 Route。每个 Route 再独立执行 `speechPushMode`，因此同一段 ASR 可以同时进入多个人格，但主机只采集和识别一次。

本地 Provider 是默认安全基线。外部 API Provider 必须满足：配置显式启用；密钥或声线 ID 只来自点名环境变量；远端地址使用 HTTPS；不做失败后的隐式云端回退；`local_only` / `relay_safe` 如实反映启用状态。会议区分发言人应使用专门的 diarization 能力并返回 speaker turns，不得把普通短句 ASR 描述成已支持分人，也不得把说话人标签冒充已验证声纹身份。

## 活跃接口

底层本地服务：`http://127.0.0.1:8781`

- `GET /health`
- `GET /v1/models`
- `GET /v1/models/<provider>/<model>`
- `GET /v1/capabilities`
- `GET /v1/events`
- `GET /v1/records`
- `GET /v1/speaker-profiles`
- `PUT /v1/speaker-identities`
- `PUT /v1/speaker-bindings`
- `POST /v1/audio/speech`
- `POST /v1/audio/transcriptions`
- `GET /v1/microphone/status`
- `POST /v1/microphone/start`
- `PUT /v1/microphone/settings`
- `POST /v1/microphone/stop`
- `GET /v1/playback/status`
- `PUT /v1/playback/settings`
- `POST /v1/playback/stop`

RabiRoute Manager 同源代理：`http://127.0.0.1:8790`

- `GET /api/speech/status`
- `GET /api/speech/events`
- `GET /api/speech/models`
- `GET /api/speech/personas`
- `GET /api/speech/records`
- `GET /api/speech/speakers`
- `PUT /api/speech/speaker-identities`
- `PUT /api/speech/speaker-bindings`
- `POST /api/speech/tts`
- `POST /api/speech/asr`
- `GET /api/speech/messages`
- `POST /api/speech/messages`
- `PUT /api/speech/microphone/settings`
- `POST /api/speech/microphone/reconcile`
- `PUT /api/speech/playback/volume`

模型列表的每一项都要返回方法、endpoint、Content-Type、必填字段、可选参数和示例。调用方不得靠写死表格猜当前模型能力。

## 麦克风常驻转写

- 只在用户主动开启后获取浏览器麦克风权限。
- Route 的语音消息端总开关是该 Route 的主机 ASR 订阅真源；任意一个 Route 订阅时保持常驻监听，关闭一个只取消自身订阅，最后一个关闭才停止麦克风。
- 计算 PCM RMS，低于声音阈值时不触发新语段。
- 保留短前置缓冲，避免吞掉句首。
- 说话后按静音时长切段，同时设置最短与最长语段保护。
- ASR 请求顺序处理，避免多个 GPU 大模型争用显存。
- RabiSpeech 播放队列活跃时暂停麦克风触发，防止 TTS 回录形成反馈环。
- 常驻 ASR 每段只提交一次，由 Manager 广播给所有订阅 Route；语音服务页不得提供“投递 Route”或人工会话 ID，Route 页也不得重复主机 ASR/VAD 参数。
- 主机实时波形、五段链路、计数器、运行日志和最近转写只放在“语音服务 → ASR”；Route 的语音消息端只保留订阅开关、热投递/人格关键词、人格 TTS 摘要、职责说明、回复自动播放和单次广播说明。
- VAD/切句参数使用滑条加精确数值输入，当前统一覆盖录音阈值、转写阈值、自适应倍率、自适应余量、静音窗口、最短语段和最长语段。
- 手动 ASR 和直接人格 TTS 不要求 Route 或 Agent。

## 热投递与关键词唤醒

- `speechPushMode` 归 Route：`hot` 表示每个已完成、非空的 ASR 片段立即进入普通 `start/steer` 投递链；`keyword` 表示先记录，再决定是否唤醒。
- `speechTriggerKeywords` 归人格：放人格名、常用称呼和唤醒词，多条 Route 绑定同一人格时共用。
- `keyword` 模式下所有 ASR 仍写语音记录和人格会话账本；只有文本命中当前人格关键词才投递 Agent。
- 关键词为空时保持“只记录”，绝不暗中回退 `hot`。
- 公开 HTTP 终态必须区分 `delivered`、`recorded`、`failed`；`recorded` 是关键词未命中时的正常结果，不算投递失败。
- 普通消息端命中规则后默认直接投递。Heartbeat 的忙碌跳过和语音的热/关键词模式是两个独立、显式的例外。

## 人格与播放

人格资料属于 `data/roles/<RoleId>`。`persona.md` 是人格真相源；`voice/voice-profile.json` 是 TTS 模型、声线、语言、语速和表达指令的唯一配置真源；声音参考、台词索引、`voice/cache/reference-audio/` 和 `voice/cache/tts-audio/` 也归对应人格。只知道人格名时也能直接调用 TTS，Provider 声线 ID 必须通过该人格点名的环境变量解析，不能写进公开配置。没有解析到人格的直接 TTS 才使用 RabiSpeech 私有 fallback 缓存，不得伪装成人格资产。

RabiSpeech 是唯一播放所有者。所有 Route、会话、Agent、人格和模型的完成音频进入同一个 FIFO；不得让下游 worker 或浏览器另起并发播放器。

主机播放音量同样只归 RabiSpeech：范围 `0–100`，唯一运行时真源是 `output/playback-settings.json`，WebGUI 只能经 Manager 的滑条加精确输入更新。每条音频开始播放时冻结当时音量，因此修改从下一条开始播放的音频生效。Windows 使用 SoundFile / PortAudio 解码和播放，不能回退到会误读流式 WAV 头的 `winsound`。Windows 11 音量合成器按进程映像展示应用身份，因此安装/启动链必须使用带 RabiSpeech 版本资源的真实 `runtime/RabiSpeech.exe`。服务运行期间保持一个持续无声的共享输出会话：启动时把历史 Core Audio 倍率只归一一次到 `100%`，之后只保活、不回写，保证系统滑条一直可调。无声保活不得进入 FIFO，也不得触发麦克风防回流。

TTS 记录保留生成文本、Provider、模型、人格、会话、Route、播放状态、安全相对缓存引用和预计到期时间。音频缓存按每条记录自己的文件时间戳保留 24 小时，不按自然日整批删除；服务启动时扫描一次，之后只维护最早到期的一次性 cleanup deadline，新成品仅在更早到期时重排。预计到期仍不是硬实时承诺，因为进程停机和系统调度可能延后删除。Manager/WebGUI 只可暴露 POSIX 风格逻辑相对路径：人格记录使用 `<RoleId>/voice/cache/tts-audio/<file>`，fallback 使用 `output/tts-audio/<file>`，旧记录兼容单文件名；绝对路径、`..`、反斜杠越界必须省略。语音消息端触发的 Agent 回复必须走普通回复 API，由 Outbox 冻结当前 Route 的人格与语音参数后入队；Agent 不直接调用 worker。

## 双向上下文与说话人

- 所有消息端的统一人格会话真源是 `data/roles/<RoleId>/conversation/current.jsonl`，必须同时记录 inbound 与 outbound，并保存消息端、会话、发送方向和可用的说话人字段。
- `current.jsonl` 不设总条数上限。显式整理时，先检查是否存在超过 72 小时未活跃项；触发后把连续前缀中超过 24 小时可编辑窗口的完整输入集合归档到 `archive/<n>~<m>.jsonl`。
- 自动注入额度按人格、消息端和会话过滤，收发合计；每个消息端独立配置 `0–200`，默认 `100`。`0` 只关闭自动注入，不停止记录或删除历史。
- ASR 与成功 TTS 回传使用同一 `speech` 上下文额度，并尽量保留相同 `sessionId`，让 Agent 能理解前后问答。
- 说话人资料库是主机级共用真源。支持人工创建资料与把 `sessionId + speaker label` 绑定到某人；若没有经过验证的 matcher，必须明确显示自动声纹识别不可用。
- Agent 使用 `PUT /api/speech/speaker-identities` 原子查找/创建人物、合并别名并绑定当前会话标签；人工设置仍放在语音服务 ASR 页，两条入口共用同一资料库。
- 主机每个可提取分段的正式人格证据是稳定不透明的 `voiceprintId`（来自该主机 cluster）。`speakerId` 和 `speakerSuggestionId` 只供主机诊断，不能参与人格 `isUser` 分类或 AgentPacket 人格身份注入。
- `validated=true` 必须同时配置通过私有真实语料门禁生成的 `validation_report_path`；运行时必须核对目标模型 ID、模型 SHA-256、hard threshold、min margin 和目标引擎 policy 结果，不匹配时关闭正式自动认人。
- 人工标注区按未知/已知说话人折叠，并按分段标签或人物资料展示最近 10 句话；这只是辅助确认，不把聚类标签冒充生物声纹。
- 人格通过 `GET /api/roles/:roleId/voice-transcripts` 读取 `conversation/current.jsonl` 与自身 `voice/voice-identities.jsonl` 的派生联结。`matchedCount` 和 coverage summary 必须按完整筛选结果计算，不能被明细 `limit` 截断；统计不回写任何真源，也不作为主动智能轮询源。
- 自动声纹正式支持必须由真实同人/异人语料、显式校准 policy 和 `--require-pass` 报告证明。示例 policy 只是起点；未通过时保持 `validated=false`，不得把实验候选或未知聚类描述成已校准认人。

## RabiLink 中转

Relay 只代理 allowlist 内的原始请求/响应，并使用通用应用 token。远端请求不能加载 Python 模块、修改模型 allowlist、下载模型或读取本机任意文件。只暴露规范化语音 API 和 OpenAPI，不暴露 worker 端口、模型路径或参考音频路径。

手机/眼镜 PCM 启动请求必须分开提交稳定 `source_device_id` 和临时 `stream_id`。前者进入 `sourceDeviceId` 并作为普通回复的唯一设备目标，后者只进入 `sourceStreamId` 用于诊断本次连接；不得把流 ID 写进 `targetDeviceIds`。

整个语音与主动智能链使用事件流：Android、PC worker 和 Manager 订阅 Relay SSE；RabiSpeech 通过 `/v1/events` 推送状态，Manager 通过 `/api/speech/events` 转发。cursor 只用于重连补漏，settle/重试/Heartbeat 只使用一次性 timer 事件；禁止固定间隔查询消息、重读账本、扫描配置或刷新状态。

## 动作安全

- 本地 TTS/ASR、模型查询和播放属于语音服务动作，不意味着 QQ/NapCat 外发。
- 常驻 ASR 的目标集合只由各 Route 的语音消息端订阅决定；显式 `routeId` 只保留给调试/兼容 API。外部消息发送仍经过 RabiRoute Action Gate。
- 不记录或公开 token、真实 Relay URL、私聊转写、录音、人格私有材料、模型权重和绝对路径。

## 验证

至少验证：

1. RabiSpeech `/health` 与模型列表。
2. 一个直接人格 TTS WAV。
3. 用该 WAV 完成一个真实 ASR 请求，并检查文字、speaker turns 和同会话记录。
4. Manager TTS/ASR 代理。
5. 播放状态和停止接口。
6. WebGUI 构建与语音消息端主要控件。
7. 两个 Route 同时订阅时，一段 ASR 只识别一次并返回两条 `deliveries[]`；关闭其中一个不停止麦克风，关闭最后一个才停止。
8. 没有订阅 Route 时返回 `recorded + no_enabled_speech_routes`；显式 `routeId` 调试调用继续兼容。
9. `hot` 返回 `delivered`；`keyword` 未命中返回 `recorded`；命中人格关键词返回 `delivered`；空关键词不回退热投递。
10. 人格双向账本能同时看到 ASR 与 TTS，TTS 写入对应人格的 `voice/cache/tts-audio/`，24 小时预计到期时间正确，WebGUI 不暴露绝对/越界路径，自动注入额度只影响注入不影响记录。
