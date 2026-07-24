<!-- docs-language-switch -->
<div align="center">
<a href="./rabilink-active-intelligence-requirements_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# RabiLink 主动智能需求与实施方案

> 状态：手机后端 + 眼镜原生前端主线的实施追踪。2026-07-18 起暂停 AIUI 新功能；保留的 AIUI 代码只作历史证据。

## 最终架构

```text
眼镜原生前端
  -> 采集 PCM 发给手机；不保存 Relay 凭据，不运行 ASR
手机眼镜后端
  -> 拥有眼镜设置、Relay 凭据、目标 PC、cursor 和传输队列
  -> 调用 Relay 受限语音代理
Rabi PC 眼镜消息端
  -> RabiSpeech VAD/切句/ASR/声纹
  -> 主机通用语音库 -> 已启用 rabilink Route
  -> 用户状态量化 / 情景识别 -> 人格会话上下文
  -> hot/keyword/observation 策略 -> Agent 人格综合决策

Agent / 定时器 / 规划器
  -> RabiRoute Outbox 和动作门 -> Relay 持久下行
手机
  -> 订阅 Relay 事件流 -> 收到下行事件后按 cursor 补消息 -> 请求 Rabi PC TTS -> 把 PCM 发给眼镜
眼镜
  -> 顺序播放音频
```

手机不是第二个 RabiRoute 配置源。Route、Agent、工作区和线程配置只存在于 Rabi PC；手机通过远程 WebGUI `/manage` 修改。

连接后的投递关系与 NapCat 一致：消息端只提供标准化事件，已开启且允许 `rabilink` 的 Route 决定事件进入哪个绑定人格。

每个人格拥有自己的语音历史、统一会话和其它人格文件。主机只保留一次原始语音与不透明声纹证据，不判断谁是谁，也不判断谁是用户。

`isUser` 等关系由收到语音的各人格写入自己的 `voice/voice-identities.jsonl`。

主动智能只响应 observation、Route、人格关系、Agent 空闲、手动触发和明确的 timer/heartbeat 事件。禁止周期重读账本或查询覆盖率来发现变化；覆盖率接口只是人工/Agent 按需诊断视图。

## 必须达成

1. 眼镜通过手机和 Relay 连接目标 Rabi PC，公网凭据不落在眼镜。
2. 手机可打开 PC 远程配置，但不存在第二套 Route、Agent 或 Codex 绑定编辑器。
3. ASR 最终文本先写主机通用语音库，再由已启用的 `rabilink` Route 执行 `hot/keyword` 策略；无订阅时只记录，不绕过 Route 直接投递。
4. 用户观察、Agent 下行和手动审阅请求进入同一条可审计 JSONL 时间线。
5. Codex 可在空闲、周期或明确引导时审阅新上下文。
6. Codex、定时器和规划器不依赖上行 `taskId` 也能主动排队消息。
7. 手机按 cursor 恢复下行，请求 PC TTS，并把 PCM 顺序发给眼镜。
8. ASR/TTS 只在 Rabi PC 眼镜消息端运行，手机和眼镜都不维护语音模型。
9. 照片和短视频按可靠消息附件处理；首版不承诺实时视频或 24 小时录音。
10. 高风险外部动作继续经过 RabiRoute 动作安全门。
11. PC 维护版本化的用户当前状态和情景快照；Agent 根据状态、情景、人格和用户配置综合决定不打扰、后台准备、提示、建议或行动。
12. 每个人格维护可查看、可纠正、可删除和可同步的用户个体模型，区分稳定性格假设、学习偏好和当前心理状态，不以单次行为给用户定型。
13. Companion App 用唯一持久状态提供 `PAUSED / PHONE / GLASSES` 三态切换；进入新模式前先释放旧采集端，眼镜未真实连接时保持暂停并显示原因。
14. 用户可提交明确主动性偏好，但 App 与 Relay 只把它作为 observation 和消息元数据；最终介入判断仍归 PC 上下文、Route 动作门与目标 Agent 人格。

## 真源划分

| 数据 | 拥有者 |
| --- | --- |
| Route、人格、策略、语音 Provider 和 Agent 配置 | PC RabiRoute |
| 原始语音与处理证据 | PC 主机级 `data/speech/messages/YYYY-MM-DD.jsonl`，每段只存一次 |
| 人格语音记录与统一会话上下文 | 各人格目录的 `voice-transcripts.jsonl` 与 `conversation/current.jsonl` |
| 声纹是谁、是不是该人格的用户 | 各人格自己的 `voice/voice-identities.jsonl`；主机和 Route 不判断 |
| 公网上下行邮箱与临时附件对象 | Relay |
| Relay 凭据、目标 PC、Route/人格选择、请求输入模式、明确主动性偏好、cursor、待传队列和消息恢复意图 | 手机 App |
| 当前实际输入模式、采集状态、连接状态与最近错误 | 手机前台服务；设置页只通过运行状态事件展示 |
| 麦克风/播放状态与最小 HUD 状态 | 眼镜 App |
| 模型、工具、沙箱、审批和当前 turn | PC Agent runtime |
| 用户当前状态与情景快照 | PC 主动智能上下文层；从设备事件和会话证据派生，可重建 |
| 稳定性格假设与学习偏好 | 目标人格的用户资料域；通过追加式证据和纠正派生，随人格同步 |
| Agent 自身的性格、语气和主动倾向 | 人格配置；与用户个体模型分开维护 |
| 介入强度与表现方式 | 目标 Agent 人格结合用户状态、情景、用户模型、明确指令和风险决定 |

手机和眼镜都不能成为第二套 Agent、记忆系统或配置真源。

## 用户状态量化与情景识别边界

> 状态：目标合同。当前语音、声纹、设备、健康、Route 和统一账本已经提供部分证据，但统一 `CurrentUserState` 和情景生命周期仍需实现与实体验收。

设备上报的是观察事件，不是最终情景。手机、眼镜、手表、电脑和 RabiSpeech 不应分别写出一套“用户正在开会”或“用户心情不好”的正式结论。

PC 主动智能上下文层先把事件融合为用户状态维度，再派生主情景和并行情景。RabiRoute 可以记录事件、提供安全快照并把它加入 AgentPacket，但不替 Agent 人格决定最终行动。

### 用户状态维度

| 维度 | 示例变量 |
| --- | --- |
| 时间 | 本地时间、时段、日期类型、距日程事件时间、当前状态持续时长 |
| 环境 | 地点类别、室内外、噪声、光照、天气、隐私级别 |
| 活动 | 静止、步行、驾驶、运动、操作电脑、做饭 |
| 情绪 | 愉悦度、激活度、压力、烦躁、信心 |
| 身体 | 心率相对基线、疲劳、睡眠、姿态、运动强度 |
| 注意力 | 专注度、认知负荷、困惑、犹豫、被打断程度 |
| 社交 | 是否独处、人数、说话人关系、是否有人对用户说话 |
| 任务 | 当前项目、阶段、进度、阻碍、紧急度、承诺 |
| 交互 | 可打扰度、可看屏幕、可听语音、双手是否忙、可用设备 |
| 设备与安全 | 网络、电量、传感器新鲜度、风险、权限和隐私模式 |

每个维度使用适合的值类型，并携带 `confidence`、`observedAt`、`expiresAt`、`evidenceRefs`、`sourceKinds` 和 `userConfirmed`。时间等确定事实不需要伪造模型分数；心情应使用多轴值，不能只有一个“开心/不开心”标签。

### 用户个体模型与心理学边界

> 状态：目标合同，尚未实现。当前人格目录已有偏好、记忆、会话和声纹关系等证据，但没有统一 `UserIndividualModel`、追加式模型事件或用户控制界面。

用户个体模型至少分为四层：

1. 稳定性格假设：参考五因素连续维度，只作低权重先验。
2. 学习偏好：按会议、工作、通勤、休息等情景保存提醒、媒介、解释和确认偏好。
3. 当前心理状态：愉悦度、激活度、压力、疲劳、认知负荷、挫败感和动机需要。
4. 情景心理特征：责任、思考要求、逆境、正负性、欺骗风险和社交性等可解释维度。

稳定性格和学习偏好属于人格用户资料域。当前心理状态与情景特征仍由 PC 上可重建的上下文层拥有；用户资料只引用当前快照，不能复制一份过期状态成为第二真源。

目标数据合同不要求独立人工 UID。当前模型由人格目录定位；只有未来多个 Agent 人格明确共享同一用户资料时，才由受控入口引入 `userProfileRef`。

```json
{
  "schemaVersion": 1,
  "stableTraits": {},
  "preferences": {},
  "currentPsychologicalStateRef": "current-user-state",
  "situationCharacteristicsRef": "current-scenarios",
  "evidenceCursor": "<profile-event-ledger-position>",
  "updatedAt": "<iso-time>"
}
```

推断和纠正必须写追加式事件。证据优先级为当前明确指令、用户确认设置、重复纠正、跨时间重复行为、单次弱推断。用户纠正后，旧结论可以保留审计关系，但不得继续作为有效偏好参与决策。

AgentPacket 只注入与当前情景相关的最小用户模型切片、来源和置信度，不注入完整心理画像。RabiRoute 负责安全记录、读取和投递；它不替 Agent 人格解释用户，也不允许性格分数绕过动作门或权限。

用户控制面至少要支持查看依据、确认、纠正、删除、暂停学习和导出。不得从被动信号做临床诊断，不得优化互动时长、服从度或情感依赖，敏感关系推断默认关闭。

### 情景与介入

情景允许分层和并行：宏观情景可以是工作，活动情景可以是开会，微观情景可以是有人向用户分配任务。系统保留一个主情景、多个并行情景、置信度、备选解释、证据和生命周期。

最终介入策略由以下信息综合决定：

```text
用户当前状态与可打扰度
+ 主情景与并行情景
+ Agent 人格主动性倾向
+ 用户个体模型中的情景偏好和低权重性格假设
+ 用户当前明确指令
+ 行动收益、时效和置信度
- 行动风险与不可逆成本
```

输出可以是不打扰、后台准备、轻提示、主动建议、请求确认、直接行动或紧急介入。同一会议情景下，谨慎人格可以会后总结，行动型人格可以即时在眼镜上提示；基础设施不能把所有人格压成同一种表现。

用户纠正必须产生可审计事件，例如“我没有在开会”“我现在是在写方案”“这种情况以后直接提醒我”。纠正重新派生当前状态与情景，不覆盖原始设备证据。

状态和情景更新必须由新事件、用户纠正或明确到期事件驱动。禁止固定周期重读完整账本来发现变化；当前快照是可重建 read model，不是第二套事件真源。

## 队列契约

### 音频上行

眼镜把带 tag 的 16 kHz mono 16-bit PCM 发给手机。Classic Bluetooth 与 P2P 可能同时送达控制消息，因此开始/停止必须幂等。手机不做 VAD、切句或 ASR，而是通过受限 `audio-streams/rabilink/start|chunk|stop` 接口把有序 PCM chunk 持续传给目标 PC RabiSpeech。`source_device_id` 保存订阅下行事件流的伴侣后端稳定身份并用于回复，手机/眼镜物理来源由 `device_kind` 区分，`stream_id` 只标识本次 PCM 连接。RabiSpeech 统一完成 VAD、切句、ASR 和声纹，并把完成结果自动写入主机通用语音库，再按 `routeProfileId` 进入 `rabilink` Route。`/api/rabilink/speech/messages` 只保留兼容与调试用途。

### 媒体上行

手机先把二进制上传到 `/api/rabilink/devices/media`，成功后才发布带 `attachments` 的 observation。PC worker 使用同一鉴权把对象下载到 Route 私有数据目录，再写账本并交给 Agent。二进制上传失败时不得产生悬空 observation。

当前真机照片回调已接线；协议接受视频文件，手机媒体磁盘队列也已实现，但真眼镜视频回调和弱网/进程恢复验收仍待完成。媒体是串行慢传的消息附件，不是实时流。

### 主动审阅

审阅器只在“仅记录 observation”或手动审阅请求的账本追加事件到达时 wake，并且只在安全处理后推进持久审阅状态。普通直达消息已经进入 Route/Agent 投递链，不会再额外唤醒审阅器读取一次账本。持续语音 observation 必须把来源 `routeProfileId` 写入统一账本；自动审阅从待审阅记录选择回复 Route，多 Route 批次会把完整 Route 集合交给 Agent，并要求按记录分别投递，不能回退到默认人格。settle、忙碌重试和周期反思都是一次性计划事件；没有新增待审阅 observation、手动请求或到期 timer 时不会重读 JSONL。

### 下行

用户可见文本经过 `/api/agent/replies`、输出策略、Relay Outbox 和持久消息端。Relay 通过 `/api/rabilink/events` 推送 `outbox_available`；手机收到事件后用 cursor 读取一次增量，断线重连时也只按 cursor 补漏，然后调用 `/api/rabilink/speech/v1/audio/speech`，从 WAV 提取 PCM 并发给眼镜。手机把 `delivered/played/playback_failed` 先写本地回执队列再补传；Relay 持久化回执并发出 `outbox_receipt`。`played` 只能来自手机或眼镜自己的 `AudioTrack` marker，不能由 Relay、估算时长或“PCM 已写入通道”推断。

手机私有文字、控制、媒体、回执与下行队列统一使用 fsync 后原子替换。启动时清理未完成临时文件；坏 JSON、缺失媒体二进制和孤立附件移入隔离目录并形成可见错误，不能让毒化项目永久堵住后续队列。可靠事实保留到成功确认或用户明确处理；实时 PCM 单独使用待确认块与有界最新缓冲，断网恢复后追上实时而不是重放全部过期声音。

## 隐私与安全

- 不记录 token、转写正文、音频正文或私有附件内容。
- 原始音频默认不长期保存。
- 下载附件只进入 Route 私有数据目录，并排除在源码提交之外。
- Relay 语音权限是明确的 ASR/TTS 白名单，不等于 WebGUI、worker API、PC 麦克风控制或任意本机 URL 权限。
- 采集状态必须可见、可暂停；后台运行必须使用带常驻通知的 Android Foreground Service。
- 外发、删除、购买和设备控制继续遵守现有审批规则。
- 心理状态、性格假设和偏好默认只留在本地人格资料域，不进入 Relay 主存储、公开日志或开源示例。
- 用户必须能暂停个性化学习，并能查看、纠正、删除和导出系统对自己的长期理解。

## 验收顺序

1. 构建两个 APK（自动化已完成），验证手机侧真实安装和启动眼镜前端。
2. 验证真眼镜 PTT 经 PC ASR 只产生一条账本 observation。
3. 验证 PC 主动文本经 PC TTS、手机转发后在眼镜播放。
4. 验证重连/cursor 恢复和跨传输重复控制消息抑制。
5. 验证照片以本地已鉴权附件到达 PC。
6. 手机后端迁移到可见 Foreground Service（代码已完成），继续验证系统回收、重启和通知交互。
7. 文本/control、媒体和设备回执都使用磁盘可靠队列；未确认项目不再按年龄静默清理，达到容量上限时显式拒绝新项目。继续验收弱网退避、进程死亡时短暂 PCM 的产品取舍，以及手机/眼镜真实扬声器播放。
8. 接入真眼镜视频文件采集；可靠文件消息完成后才评估实时视频。

## 当前完成度审计（2026-07-24）

| 要求 | 当前证据 | 状态 |
| --- | --- | --- |
| 眼镜只采集、手机持有 Relay 凭据、PC 处理语音 | Android 主链只发送有序 PCM；PC `audio-streams/rabilink/*` 强制拥有 VAD、切句、ASR 与声纹 | 代码与自动化通过，仍需真眼镜验收 |
| Route 像 NapCat 一样决定人格投递 | 主机原始消息只写一次；`speech` 与 `rabilink` 分开订阅；`hot/keyword` 返回真实 `delivered/recorded/failed` | 已通过闭环测试 |
| 人格拥有会话、文件和身份解释 | 每个人格分别写 `voice-transcripts.jsonl`、`conversation/current.jsonl`、`voice/voice-identities.jsonl`；主机删除人物名并只保留不透明证据 | 已通过闭环测试 |
| 手机/眼镜回复原路返回 | `sourceDeviceId` 是稳定下行目标，`sourceStreamId` 只表示临时 PCM 流；AgentPacket、Outbox 与 Relay 闭环锁定该边界 | 已通过闭环测试 |
| 三态模式单一真源与互斥采集 | 设置持久化 `PAUSED / PHONE / GLASSES` 请求模式；Service 拥有实际运行模式并先释放旧采集端；眼镜连接事件到达前和断线后保持暂停，运行卡片由广播事件刷新 | 代码、单测与架构审计通过；真机蓝牙切换仍待验收 |
| 明确主动性偏好不越权 | `agent_decides / quiet / balanced / proactive` 可靠写为 `rabilink.preference` observation，并随文字、控制、媒体和 PCM 元数据进入 PC；App/Relay 不把它变成本地介入规则 | 代码、Relay 元数据测试与人格账本测试通过 |
| 事件驱动、无业务空轮询 | Relay/RabiSpeech SSE、文件事件、账本 wake 和一次性 deadline 已启用；Android 已知断网时 SSE/可靠发送等待系统网络事件，仅在已知离线期间用五分钟 OS 网络检查兜底厂商漏回调且不读业务数据，网络可用但服务失败才退避；生产源码门禁只允许五类登记例外 | 已通过门禁、移动端架构审计与 Android 事件门单测；仍需真机验证厂商回调漏发场景 |
| 可见 Android 后台宿主 | `RabiConversationService` 已是 `START_STICKY` Foreground Service，带通知、启动恢复和输入模式切换 | 代码与 APK 构建通过，仍需系统回收/重启真机验收 |
| 可靠文字、媒体、回执与下行队列 | 各类可靠事实先原子写入手机私有磁盘；成功后删除，失败保留并由事件/受控退避重试；坏 JSON、缺失二进制和孤立附件隔离并显示错误，不再堵住后续项目 | 代码与自动化通过，仍需弱网和损坏恢复真机验收 |
| 连续 PCM 短时重试 | 未确认 chunk 保持原 sequence 和内容，PC 对相同 sequence/hash 幂等；连续失败会重建 transport 并保留当前进程内 pending PCM | 代码通过；进程被系统杀死时短暂内存 PCM 不承诺恢复 |
| 下行 cursor、TTS、顺序播放与回执 | 手机订阅 `outbox_available`，按 cursor 查询一次增量；明确目标的 Relay 消息在 `delivered` 前不按 TTL 删除；手机/眼镜只在各自 AudioTrack marker 后回 `played`；眼镜先确认暂停采集再接收 PCM，销毁时明确失败 | 协议、持久队列、状态机、并发时序与自动化通过；真机扬声器播放仍待验收 |
| 真人声纹 | 当前模型探针真实输出 192 维 embedding；未知簇持久化、全天有界原型和重叠拒绝已测试 | 私人校准集仍为 0/32，正式自动认人未验收 |
| 多 PC 人格同步 | 同 token 发现、LAN 优先、Relay fallback、JSONL union、普通文件快进/删除/冲突/解决回发均有实际 HTTP/Relay 子进程测试 | 自动化通过，仍需两台实体 PC 长期验收 |
| 用户状态与情景识别 | 已明确多维状态、证据外壳、情景层级和“状态 + 情景 + 人格”介入合同 | 设计完成；统一状态服务、情景引擎和实体场景验收尚未完成 |

因此当前不能把“APK 可构建”和“模型可推理”写成实体环境完成。最终剩余证据是：真人声纹阈值报告、两台实体 PC 的断线/冲突/长期同步，以及手机/眼镜的弱网持续 PCM、系统回收与真实播放。

## 统一实体环境验收状态

`npm run check:active-intelligence:physical -- [参数]` 是失败关闭的一次性证据汇总入口。它不启动模型、Manager、手机或眼镜测试，不轮询设备，也不把自动化绿灯当成实体环境完成。默认从受 Git 忽略的窄目录读取最近的人格同步、Android soak 和 Rokid 真机摘要；正式声纹报告必须显式传 `--speaker-report <json>`。汇总只写证据 SHA-256、时间、检查项和 `missing / partial / passed / stale / invalid` 状态，不写 token、正文、人格名、设备序列号、主机名或私有路径。默认只要任一领域未通过就退出 `2`；仅查看状态时可显式加 `--allow-incomplete`。

四个领域都必须独立通过：

- `voiceprint`：私有数据集必须声明 `real_person_private`，正式资格为真，完整 policy 与全部目标引擎通过，且报告内 dataset hash 与当前 manifest 一致；合成 TTS 不能冒充正式证据。
- `personaSync`：schema v2 实体同步证据必须同时满足 `syncPassed`、显式的两台不同物理主机确认和 `formalAcceptanceEligible`，并由人工观察证据确认 LAN、Relay fallback、断线恢复、冲突解决和长期运行。普通功能同步成功不能冒充正式实体证据。
- `android`：真实设备 soak 至少 23.5 小时且 PCM 持续增长，并确认断网自动恢复、系统回收恢复、开机恢复和手机扬声器真实播放。
- `rokid`：真实设备脚本必须实际请求并得到 TTS 与非空 ASR 证据；另需确认持续 PCM、触摸板、实际听到播报和连接恢复。

必须人工确认的物理事实写在本机忽略文件 `output/acceptance/active-intelligence-physical-observation.json`。不要直接编辑或一次性把全部值改为真；使用受控命令逐项确认、撤销或重置：

```powershell
npm run record:active-intelligence:physical -- --list
npm run record:active-intelligence:physical -- --confirm personaSyncLan
npm run record:active-intelligence:physical -- --revoke personaSyncLan
npm run record:active-intelligence:physical -- --reset
```

每个 `--confirm` 都必须显式写出 allowlist 内的检查 ID；命令不启动测试、不轮询设备，也不提供“全部通过”捷径。已有文件会先复制到同目录 `archive/`，再原子更新当前文件。工具首次生成随机环境证据后只保存 SHA-256，后续沿用该 hash；不会保存主机名、设备序列号、账号、备注或自由文本。当前文件格式为：

```json
{
  "schemaVersion": 1,
  "kind": "active_intelligence_physical_observation",
  "generatedAt": "2026-07-24T12:00:00.000Z",
  "operatorConfirmed": true,
  "environmentIdHash": "<64 lowercase hex characters>",
  "checks": {
    "personaSyncDistinctPhysicalHosts": false,
    "personaSyncLan": false,
    "personaSyncRelayFallback": false,
    "personaSyncDisconnectRecovery": false,
    "personaSyncConflictResolution": false,
    "personaSyncLongRun": false,
    "androidOfflineRecovery": false,
    "androidProcessReclaimRecovery": false,
    "androidBootRecovery": false,
    "androidPhonePlayback": false,
    "rokidContinuousPcm": false,
    "rokidTouchpad": false,
    "rokidPlaybackHeard": false,
    "rokidConnectionRecovery": false
  }
}
```

示例调用：

```powershell
npm run check:active-intelligence:physical -- `
  --speaker-report plugin-adapters\rabi-speech\output\benchmarks\speaker-validation.json
```

## AIUI 历史边界

AIUI 无法直接与 CXR-L 通讯，也不再属于当前主链。现有 AIUI 页面、测试和发布记录保留作回归与协议历史；Craft 提审或 AIUI ASR/TTS 真机验收不再阻塞手机/眼镜 App 里程碑。
