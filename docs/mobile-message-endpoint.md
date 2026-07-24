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

- 手机模式：Android 麦克风前台服务持续采集 16 kHz 单声道 PCM，并通过受限 `audio-streams/rabilink/start|chunk|stop` 接口按序上传约 500 ms chunk。Android 不做 VAD、切句、ASR 或声纹；目标 PC RabiSpeech 把该流作为虚拟远程麦克风，统一完成 VAD、切句、ASR、声纹和自动消息提交。完成结果标记为 `messageAdapterType=rabilink`、`channelType=rabilink.mobile_audio`，只投递给启用了 RabiLink/手机消息端的 Route，不会混进独立 `speech` 语音消息端。回复继续由 `/api/agent/replies` 进入 RabiLink 下行并在手机显示或播放。Android 不保存一条 24 小时原始录音；PC 端完成切句的 ASR 输入和 Agent TTS 按逐文件时间戳滚动缓存 24 小时。chunk 必须连续递增，15 秒无 PCM 时 PC 自动停止失活流并恢复之前的音频输入。
- 眼镜模式：前台服务在后台持有 CXR 和原生消息桥，启动眼镜 App。眼镜 App 配置完成后自动持续录音；默认焦点为“立即推送”，单击触摸板提示 Agent。TTS 使用同一条有序 Classic BT 通道传送 `PLAYBACK_BEGIN → PCM → PLAYBACK_END`；眼镜暂停采集、校验消息 ID 与字节数，并只在 `AudioTrack` marker 到达后回 `played` 和恢复录音。手机消息服务断开后按 1.5–30 秒指数退避自动重连，同时保留手动重连入口。
- 两种模式共享路由人格、文字/control/媒体可靠队列、cursor、聊天记录、下行 TTS 设置和动作安全门，切换眼镜不会创建第二套账号或会话。ASR/VAD/切句/语言设置只归目标 PC RabiSpeech，不在 Android 保存第二份真源。
- 手机/眼镜 PCM 与远程 Rabi TTS/ASR 客户端遵守同一宿主边界：远端只提交音频流，目标 PC 负责处理并把 `sourceHostId/sourceHostName`、不透明声纹 ID 和判定证据写入通用消息。主机不判断谁是谁或谁是用户；每个接通人格在自己的 `conversation/current.jsonl` 中保留会话，并可独立维护 `voice/voice-identities.jsonl`。
- 手机仍是可靠会话与下行 owner，可靠队列用 `sourceDeviceKind` 冻结每条输入的真实物理来源。眼镜麦克风、照片和触摸板提示标记为 `sourceDeviceKind=glasses`，手机音频标记为 `sourceDeviceKind=mobile`；两者的 `sourceDeviceId` 都使用当前伴侣后端正在拉取下行的稳定设备 ID，确保普通回复能回到这台手机，再由手机送往屏幕或眼镜。本次 PCM 连接另记为 `sourceStreamId`，不能拿带 `-phone-audio` / `-glasses-audio` 后缀的流 ID 当回复设备。两者共用同一 `sessionId` 时，Agent 和审计仍可按 `sourceDeviceKind/channelType` 区分操作设备，又不会把切换设备误判为新会话。`routeProfileId` 只选择接收人格/Route，不表示来源是角色面板；手机语音 AgentPacket 必须保持 `targetType=rabilink` 与 `adapterType=rabilink`。
- `RabiConversationService` 是输入模式的唯一状态 owner，模式只有 `PAUSED`、`PHONE`、`GLASSES`。每次应用设置都会先停止非目标采集端：切到眼镜会暂停手机 `AudioRecord`，切回手机会关闭 CXR/Phone SDK 眼镜桥，关闭持续聆听会同时停掉两端，避免两个麦克风在后台并行上送。

## 可靠性和安全

- 文字与控制上行：最多 2000 项，稳定 ID，断网自动补传；尚未确认的项目不再按年龄静默删除，队列满时拒绝新项目并明确报错。连续 PCM 不进入这条磁盘队列。
- 文字和媒体在进入后台队列前固定 `routeProfileId` 与 `clientMessageId`，页面显示等待发送、正在发送、已交给 Rabi PC 或具体失败；切换页面不会改变已排队消息的归属。
- 媒体上行：最多 500 项、单项 64 MiB；尚未确认的本地项目不按年龄清理，队列满时显式拒绝新媒体。Relay 临时媒体对象仍按服务端七天 TTL、应用隔离和鉴权下载管理。
- 下行：持久不透明 cursor、按 `deliveryId` 的已投递去重、PCM 缓存；SSE `ready/outbox_available` 只唤醒，随后按 cursor 查询一次覆盖断网漏事件。Relay 每 15 秒发送传输 keepalive；Android 45 秒未收到任何 SSE 字节时只把半开连接视为停滞并重建，重连后仍只执行一次 `ready → cursor` 补漏，不读取业务状态做轮询。正常 Relay 重启沿用共享 cursor 代际；运行期状态回滚或游标损坏时才返回 `cursorReset=true`，手机从仍保留的消息重放并以本机终态记录去重，再保存新 cursor，因此不会因客户端游标永久领先服务端而永远滞后。Relay 对明确 `targetDeviceIds` 的消息在所有明确目标设备回 `delivered` 前不执行 Outbox TTL 清理；广播或仅按设备类型投递仍使用有限 TTL。单条 TTS 连续失败三次后让出队首并保留重试。
- 回执：`delivered` 只证明移动端已经接收并展示，绝不等同于 `played`。手机只能在本机 `AudioTrack` marker 到达后回 `played`；眼镜只能在自己的 marker 到达后通过 Classic BT 回传。`delivered/played/playback_failed` 先写手机私有 `receipt-queue`，既作为崩溃后的本地去重证据，也在恢复联网后可靠补传；Relay 持久化回执并发布 `outbox_receipt` 事件，不猜测设备播放状态。
- 眼镜语音下行只有在手机 SDK 已初始化、设备已认证，并且 Classic BT 的消息与音频通道都在线时才确认接收；通道未就绪会返回失败并进入既有延迟重试，不能因为 SDK 对象存在就提前移动 cursor。
- 手机 APK 与眼镜 APK 共用 `RabiGlassAudioProtocol` 作为命令、消息前缀、client ID 和音频 stream tag 的唯一真源；两端不再各自复制协议字符串。
- 纯附件下行不要求伪造正文：图片、视频、音频和任意文件即使没有文字，也会下载、写入聊天记录并产生普通消息通知。
- 正式 Android 后端已经移除旧的整段 ASR 磁盘队列，以及直接调用远端 `audio/transcriptions` 后再手工发布语音消息的旁路。Android 在 PC 确认前保留当前 pending PCM chunk、序号和稳定 `chunkId`；同流同序号重试以及 ACK 丢失后的跨流重试，都由 RabiSpeech 按 `sourceDeviceId + chunkId + PCM SHA-256` 幂等确认且不会重复送入 ASR。系统网络可用事件和 RabiLink SSE 恢复会立即触发续传，只有服务端临时故障使用一次性退避。PCM 网络执行器和最新音频缓冲都有界；弱网长期阻塞时会保留待确认块、丢弃过旧 PCM，并以新的临时 `sourceStreamId` 追上实时流，避免 AudioRecord/CXR 回调无限堆积内存或恢复后永久滞后；稳定回复目标 `sourceDeviceId` 不变。PC 端通过一次性 15 秒到期事件回收旧失活流。Android 进程死亡会丢弃尚未确认的内存 PCM，不把它伪装成已可靠保存；文字、control、媒体与下行 TTS 仍沿用各自的可靠队列和显式重试。
- 设备诊断：最多 500 条、7 天离线补传；相同事件一分钟内只落盘一次，只记录粗粒度事件和状态，不记录聊天正文、转写、token 或请求体。
- 手机采集监督：`RabiPhoneAudioCapture` 独占 `AudioRecord`、partial WakeLock、采集指标、45 秒卡死检测和 1–30 秒受控退避重启；停滞检测根据最后一次成功读取安排一次性 deadline，暂停、切换模式或重启录音时取消旧 generation，不再固定间隔跑 watchdog。`RabiConversationService` 只负责编排传输、通知和手机/眼镜模式。聊天页显示本次采集时长、最近音频时间、累计 PCM 字节和自动恢复次数。
- 音频缓存与记录：ASR 音频、转写和声纹证据只由 PC RabiSpeech 按逐文件 24 小时语义保存；Android 不再创建 ASR 音频缓存或 ASR 元数据。移动端只在收到需要本机/眼镜播放的下行语音时，把 TTS PCM 保存在 `audio-cache/tts-audio/`，并在 `speech-records/` 写安全相对路径、`audio_expires_at` 和追加式 TTS 元数据。文字、control、媒体和失败下行仍使用各自的可靠队列，不能把播放缓存当待传队列或人格历史。
- 重启恢复：消息连接的恢复意图与“持续聆听”分开持久化。已启动的文字、媒体和下行连接在进程或设备重启后，会先以 `dataSync` 前台类型恢复 cursor、可靠队列和两个通知；即使持续聆听关闭，也不会把消息队列永久留在旧状态。用户明确点击停止会关闭后续自动恢复。Android 不允许从开机广播直接启动麦克风时，用户打开 App 后再恢复持续收音，已排队消息不会丢失。
- 账号 token、聊天账本、TTS 和附件均在应用私有目录；PC 本地文件下行仍受 `allowedFileRoots` 限制。

## 验收边界

Android 和 TypeScript 自动化只能证明协议、队列、回执状态机和构建成立。发布前仍必须分别在一台 Android 手机和真实 Rokid 眼镜上验证：长时后台录音、锁屏/恢复、CXR 重连、物理触摸板、真实电量刷新、手机/眼镜扬声器实际播放确认、通知权限和厂商省电策略。

手机侧 24 小时验收使用 `apps/rabilink-android/scripts/Test-RabiMobileAudioSoak.ps1`。脚本按固定间隔读取前台服务和应用私有采集指标，保存 JSONL 证据，并检查服务常驻、最近音频年龄和 PCM 字节持续增长。它应在目标发布机型上运行，不能用模拟器或一次构建成功替代。

2026-07-18 已在小米 Android 真机完成手机侧冒烟验收：APK 覆盖安装、初始化后默认聊天页、登录失效回退、前台服务、两个常驻通知，以及真实点击“提示 Rabi”后写入可靠 control 队列均通过；未发现应用崩溃或前台服务权限异常。Rokid 眼镜侧物理验收仍未完成，不能据此宣称整套发布版已经完全验收。

2026-07-22 的代码侧收口已补齐眼镜/手机真实来源冻结与眼镜音频通道门禁，并通过手机端审计、Relay 媒体回归和手机/眼镜双 APK 构建。该结果仍不替代真实 Rokid 上的触摸板、持续录音、断线恢复和扬声器确认。

仓库命令 `npm run check:rabilink:mobile` 会固定审计手机独立聊天、手机后端、可选眼镜、通知、媒体、人格、语音、重启恢复，以及旧 AIUI 的 85 条白名单配置动作，并运行 Relay 附件闭环回归。
