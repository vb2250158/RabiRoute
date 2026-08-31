<!-- docs-language-switch -->
<div align="center">
<a href="./mobile-message-endpoint_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# Rabi 移动设备消息端

Rabi 移动设备消息端是独立于 Rokid AIUI / 灵珠智能体 MCP 的新消息端。手机是完整客户端和可靠后端；眼镜只是在用户开启开关后增加的麦克风、扬声器、HUD、相机和触摸板外设。没有眼镜时，手机仍可完成登录、聊天、持续收音、ASR/TTS、附件、通知、配置和主动消息接收。

## 初始化与日常界面

- 未初始化时进入 RabiLink 全局登录、默认 Rabi PC、语音模型和眼镜授权设置。
- 初始化后默认进入类似 QQ 的会话列表：头像、联系人名、最后一条消息、时间和逐会话未读数在一行内呈现；点联系人进入聊天，返回后继续选择其他人格。
- 联系人只来自启用了 `rabilink` 消息端的 Route。健康手表等非聊天 Route 不会被误当人格；未启用的 RabiLink Route 会明确显示原因和远程配置入口。
- 聊天详情顶部只保留返回、当前身份和可信连接状态。消息按日期分组，气泡外显示发送者和时间，语音、配置请求与文件使用明确类型标签，附件气泡可直接点击打开。
- 底部附件、输入框和发送按钮使用统一的 52dp 控件高度，支持多行输入、键盘发送和逐会话草稿恢复。
- 每个会话独立维护已读位置；打开 A 不会清除 B 的未读消息。旧版缺少 Route 的消息只会一次性迁移到一个确定会话，不会再同时出现在所有人格中。
- 文本、麦克风 ASR 消息、Agent TTS、图片、视频、独立音频文件和任意文件进入同一份手机私有聊天账本。附件可双向传输并在手机打开。
- 配置不再与普通聊天共用输入框。知道字段时在设置或远程 WebGUI 的对应位置修改；不知道字段名时从设置打开独立“配置助手”。自然语言请求仍携带明确标记，写入、删除、停止、覆盖和外部动作继续经过 RabiRoute 安全门，只有 PC 接口成功且读回确认后才能声称完成。

## 常驻服务和通知

连接后由 `RabiConversationService` 持有下行 cursor、可靠队列和手机/眼镜 I/O。通知栏有两个常驻入口：

1. `Rabi 持续会话`：点击打开聊天页。
2. `提示 Rabi`：点一下立即发送 `rabilink.review_request`，等价于 AIUI 连接会话中的触摸板单击。

Agent 普通回复和主动投递使用按会话稳定聚合的普通消息通知。通知携带 `routeProfileId`，点击后以 `singleTop` 直达对应人格会话；返回落到会话列表。同一会话的新通知更新原通知，进入详情并标记已读后清除。设置可控制收到 Agent TTS 后是否立即播放；关闭时 WAV 仍保存在私有聊天记录中，点击语音气泡可手动播放。

## 手机与眼镜模式

- 手机模式：Android 麦克风前台服务持续采集 16 kHz 单声道 PCM，先写手机私有动态分片，再通过受限 `audio-streams/rabilink/start|chunk|stop` 接口按序补传。Android 不做 VAD、切句、ASR 或声纹；目标 PC RabiSpeech 把该流作为虚拟远程麦克风，统一完成 VAD、切句、ASR、声纹和自动消息提交。录音设备不按零点或固定 24 小时重启；分片由 5 秒、160 KiB 或输入/Route/暂停等状态边界触发。PC 超时回收的是网络虚拟流，不影响手机继续录音和落盘。
- RabiSpeech 以 `source_device_id + chunk_id + bytes + sha256 + source_sequence` 保存处理真源；回环维护接口 `GET /v1/audio-streams/rabilink/ledger/tuples` 只按稳定来源和序号分页返回受限的终态元数据，不返回 PCM、路径、凭据或 worker lease。非事务 ASR feed 中断后保持 ambiguous，只有回环操作员明确 `replay` 或 `skip` 才能继续；每次决定都追加到独立 `resolution_audit`，进程重启与来源退休不会覆盖这份审计。
- 收到服务端 ACK 后，手机先把完整 tuple 作为 durable receipt 原子追加到 `audio-spool/ack-journal/`，容量预检成功后才把 segment metadata 改为 `acked`；重启时 receipt 会把仍为 `sealed`、`uploading` 或 `failed` 的 metadata 确定性补完为 ACK，后台失败标记不能覆盖已经持久化的 receipt。journal 固定保留 96 小时、最多 100,000 条或 128 MiB，容量不足且没有超过 96 小时的记录可回收时会在改变 metadata 前拒绝确认，不删除窗口内证据。PCM/metadata 清理由 `cleanup-tombstones/` 记录可恢复事务，任一删除边界重启只会继续已确认清理，不会把缺 PCM 误记为 gap 或 quarantine。72 小时在线 soak 在开始时冻结 journal watermark，结束时只取本次运行新增 tuple 与 RabiSpeech 分页账本逐条核对。
- 眼镜模式：前台服务在后台持有 CXR 和原生消息桥，启动眼镜 App。眼镜 App 配置完成后自动持续录音；默认焦点为“立即推送”，单击触摸板提示 Agent。TTS 使用同一条有序 Classic BT 通道传送 `PLAYBACK_BEGIN → PCM → PLAYBACK_END`；眼镜暂停采集、校验消息 ID 与字节数，并只在 `AudioTrack` marker 到达后回 `played` 和恢复录音。手机消息服务断开后按 1.5–30 秒指数退避自动重连，同时保留手动重连入口。
- 两种模式共享路由人格、文字/control/媒体可靠队列、cursor、聊天记录、下行 TTS 设置和动作安全门，切换眼镜不会创建第二套账号或会话。ASR/VAD/切句/语言设置只归目标 PC RabiSpeech，不在 Android 保存第二份真源。
- 手机/眼镜 PCM 与远程 Rabi TTS/ASR 客户端遵守同一宿主边界：远端只提交音频流，目标 PC 负责处理并把 `sourceHostId/sourceHostName`、不透明声纹 ID 和判定证据写入通用消息。主机不判断谁是谁或谁是用户；每个接通人格在自己的 `conversation/current.jsonl` 中保留会话，并可独立维护 `voice/voice-identities.jsonl`。
- 手机仍是可靠会话与下行 owner，可靠队列用 `sourceDeviceKind` 冻结每条输入的真实物理来源。眼镜麦克风、照片和触摸板提示标记为 `sourceDeviceKind=glasses`，手机音频标记为 `sourceDeviceKind=mobile`；两者的 `sourceDeviceId` 都使用当前伴侣后端正在拉取下行的稳定设备 ID，确保普通回复能回到这台手机，再由手机送往屏幕或眼镜。本次 PCM 连接另记为 `sourceStreamId`，不能拿带 `-phone-audio` / `-glasses-audio` 后缀的流 ID 当回复设备。两者共用同一 `sessionId` 时，Agent 和审计仍可按 `sourceDeviceKind/channelType` 区分操作设备，又不会把切换设备误判为新会话。`routeProfileId` 只选择接收人格/Route，不表示来源是角色面板；手机语音 AgentPacket 必须保持 `targetType=rabilink` 与 `adapterType=rabilink`。
- `RabiConversationService` 是输入模式的唯一状态 owner，模式只有 `PAUSED`、`PHONE`、`GLASSES`。每次应用设置都会先停止非目标采集端：切到眼镜会暂停手机 `AudioRecord`，切回手机会关闭 CXR/Phone SDK 眼镜桥，关闭持续聆听会同时停掉两端，避免两个麦克风在后台并行上送。

## 可靠性和安全

- 文字与控制上行：最多 2000 项，稳定 ID，断网自动补传；尚未确认的项目不再按年龄静默删除，队列满时拒绝新项目并明确报错。连续 PCM 使用独立 `audio-spool` 磁盘生命周期，不与文字队列争用上传线程。
- 文字和媒体在进入后台队列前固定 `routeProfileId` 与 `clientMessageId`，页面显示等待发送、正在发送、已交给 Rabi PC 或具体失败；切换页面不会改变已排队消息的归属。
- 媒体上行：最多 500 项、单项 64 MiB；尚未确认的本地项目不按年龄清理，队列满时显式拒绝新媒体。Relay 临时媒体对象仍按服务端七天 TTL、应用隔离和鉴权下载管理。
- 下行：持久不透明 cursor、按 `deliveryId` 的已投递去重、PCM 缓存；SSE `ready/outbox_available` 只唤醒，随后按 cursor 查询一次覆盖断网漏事件。Relay 每 15 秒发送传输 keepalive；Android 45 秒未收到任何 SSE 字节时只把半开连接视为停滞并重建，重连后仍只执行一次 `ready → cursor` 补漏，不读取业务状态做轮询。正常 Relay 重启沿用共享 cursor 代际；运行期状态回滚或游标损坏时才返回 `cursorReset=true`，手机从仍保留的消息重放并以本机终态记录去重，再保存新 cursor，因此不会因客户端游标永久领先服务端而永远滞后。Relay 对明确 `targetDeviceIds` 的消息在所有明确目标设备回 `delivered` 前不执行 Outbox TTL 清理；广播或仅按设备类型投递仍使用有限 TTL。单条 TTS 连续失败三次后让出队首并保留重试。
- 回执：`delivered` 只证明移动端已经接收并展示，绝不等同于 `played`。手机只能在本机 `AudioTrack` marker 到达后回 `played`；眼镜只能在自己的 marker 到达后通过 Classic BT 回传。`delivered/played/playback_failed` 先写手机私有 `receipt-queue`，既作为崩溃后的本地去重证据，也在恢复联网后可靠补传；Relay 持久化回执并发布 `outbox_receipt` 事件，不猜测设备播放状态。
- 眼镜语音下行只有在手机 SDK 已初始化、设备已认证，并且 Classic BT 的消息与音频通道都在线时才确认接收；通道未就绪会返回失败并进入既有延迟重试，不能因为 SDK 对象存在就提前移动 cursor。
- 手机 APK 与眼镜 APK 共用 `RabiGlassAudioProtocol` 作为命令、消息前缀、client ID 和音频 stream tag 的唯一真源；两端不再各自复制协议字符串。
- 纯附件下行不要求伪造正文：图片、视频、音频和任意文件即使没有文字，也会下载、写入聊天记录并产生普通消息通知。
- Android 的 `RabiDurableAudioSpool` 是连续 PCM 真源。录音回调先进入有界接收队列，独立单写线程负责活动 `.pcm.partial`、每秒 fsync、原子封口和 metadata；单次超大回调也会按偶数字节边界拆成多个不超上限的分片。metadata 包含本地序号、起止时间、字节数、SHA-256、来源、Route、封口原因、上传尝试和状态。进程启动只根据 partial ownership sidecar 恢复归属；归属缺失、坏对齐、metadata 损坏、PCM 缺失或 SHA 不符会把关联文件一起移入 quarantine、写稳定 gap 并继续后项。上传按本地序号逐段切到分片自己的来源/Route 流，响应必须同时匹配 `sequence + chunkId + accepted_bytes + sha256` 才标记 ACK；RabiSpeech 把已处理的稳定设备、chunkId、字节数、SHA-256 和结果写入本机 SQLite 幂等账本，进程重启后的同分片重放不会再次进入 ASR。未 ACK 和 quarantine 不会被自动删除；存储压力先回收允许清理的 ACK 副本，仍不足才累计 `rejectedBytes` 并写 gap。
- 设备诊断：最多 500 条、7 天离线补传；相同事件一分钟内只落盘一次，只记录粗粒度事件和状态，不记录聊天正文、转写、token 或请求体。
- 手机采集监督：`RabiPhoneAudioCapture` 独占 `AudioRecord`、partial WakeLock、采集指标、45 秒卡死检测和 1–30 秒受控退避重启；停滞检测根据最后一次成功读取安排一次性 deadline，暂停、切换模式或重启录音时取消旧 generation，不再固定间隔跑 watchdog。`RabiConversationService` 只负责编排传输、通知和手机/眼镜模式。聊天页显示本次采集时长、最近音频时间、累计 PCM 字节和自动恢复次数。
- 音频缓存与记录：`audio-spool` 保存的是待可靠传输的原始 PCM 分片，不是 Android ASR 结果或人格历史。PC RabiSpeech 仍是 VAD/ASR/声纹和成功转写记录的唯一真源。设置可配置 ACK 后副本保留 0–168 小时、录音队列容量和设备剩余空间水位；存储压力可提前清理已 ACK 副本。下行 TTS 继续使用独立 `audio-cache/tts-audio/` 与 `speech-records/` 生命周期。
- 重启恢复：消息连接的恢复意图与“持续聆听”分开持久化。已启动的文字、媒体和下行连接在进程或设备重启后，会先以 `dataSync` 前台类型恢复 cursor、可靠队列和两个通知；即使持续聆听关闭，也不会把消息队列永久留在旧状态。用户明确点击停止会关闭后续自动恢复。Android 不允许从开机广播直接启动麦克风时，用户打开 App 后再恢复持续收音，已排队消息不会丢失。
- 账号 token、聊天账本、TTS 和附件均在应用私有目录；PC 本地文件下行仍受 `allowedFileRoots` 限制。

## 验收边界

Android 和 TypeScript 自动化只能证明协议、队列、回执状态机和构建成立。发布前仍必须分别在一台 Android 手机和真实 Rokid 眼镜上验证：长时后台录音、锁屏/恢复、CXR 重连、物理触摸板、真实电量刷新、手机/眼镜扬声器实际播放确认、通知权限和厂商省电策略。

手机侧使用 `Test-RabiMobileDurableAudioSoak.ps1` 分别做 24 小时断网和 72 小时联网验收；`Start-RabiMobileDurableSoak.ps1` 可从同一证据目录恢复阶段并按最初保存的网络状态收尾。证据包含不含原音内容的状态 manifest、分片计数、首尾序号及声明/实测 SHA-256 匹配证明，不含 token 或 PCM。`Test-RabiMobileDurableAudioFaults.ps1` 覆盖短时断网、进程强停、残留 partial 恢复、启动后自动继续采集和联网补传；短测不能替代长稳结果。

2026-07-18 已在小米 Android 真机完成手机侧冒烟验收：APK 覆盖安装、初始化后默认聊天页、登录失效回退、前台服务、两个常驻通知，以及真实点击“提示 Rabi”后写入可靠 control 队列均通过；未发现应用崩溃或前台服务权限异常。Rokid 眼镜侧物理验收仍未完成，不能据此宣称整套发布版已经完全验收。

2026-07-22 的代码侧收口已补齐眼镜/手机真实来源冻结与眼镜音频通道门禁，并通过手机端审计、Relay 媒体回归和手机/眼镜双 APK 构建。该结果仍不替代真实 Rokid 上的触摸板、持续录音、断线恢复和扬声器确认。

仓库命令 `npm run check:rabilink:mobile` 会固定审计手机独立聊天、手机后端、可选眼镜、通知、媒体、人格、语音、重启恢复，以及旧 AIUI 的 85 条白名单配置动作，并运行 Relay 附件闭环回归。
