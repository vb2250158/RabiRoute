# 声纹、多电脑人格同步与统一语音消息链路继续完善任务书

> 文档类型：Codex 目标模式执行任务书。
>
> 日期：2026-07-24。
>
> 语言说明：本文会直接约束 Agent 的实现语义，属于 plan / goal 类文档，不创建机械英文翻译。面向用户的正式说明、README、Runbook 和版本日志仍必须同步维护中文/英文版本。
>
> 工作区提醒：当前仓库已有大量与本任务同方向的未提交代码、测试和文档。执行时必须先审计现状、保留用户改动并在现有唯一入口上继续完善；禁止 reset、覆盖、复制出第二套平行实现，禁止把已经实现的能力重新写一遍后冒充完成。

## 一、目标

继续完善 RabiRoute / RabiLink / RabiSpeech 的语音与人格数据基础设施，使用户在真实长期使用中获得以下结果：

1. 一天持续录音后，系统能区分“用户本人”“其他已知人物”“未知人物”和“存在冲突的人物”，不能只依赖 ASR Provider 的临时 speaker `0/1` 标签。
2. 多台属于同一 RabiLink 应用、使用同一应用 token 的电脑可以互相发现，并同步人格文件夹。局域网可达时优先点对点直连；不可达时由 RabiLink Relay 做受限中转。Relay 不保存主人格副本。
3. PC 麦克风和手机/眼镜音频流复用同一套主机 VAD、切句、ASR、声纹和通用消息存储能力，但保留不同的消息端身份、来源设备、回复目标和路由语义。
4. 手机无网、Relay 暂时不可用、ACK 丢失、PC 重启或设备重新联网后，链路能自动恢复并补投该补的消息；不能重复识别、重复投递，也不能无限补传已经过时的实时音频。
5. ASR 完成后先保存完整、通用、可审计的主机级消息事实，再根据 Route 是否订阅对应消息端决定是否投递 Agent；人格历史只保存该人格实际消费的上下文和人格自己的声纹关系解释。
6. 所有公开行为、配置、首次上手、排障、接口、成熟度和限制都与代码同步；已被替代的旧方案先归档，再从正式索引和调用说明中移除。
7. 语音基础设施最终服务于主动智能：系统持续积累上下文、理解用户意图并尽可能主动提供帮助；不能把“主动”误实现成固定轮询账本、重复消费或没有上下文判断的机械逐句回声。
8. 系统逐步摸清不同用户的性格倾向和情景偏好，并与 Agent 人格、当前状态、收益和风险综合决策；用户可查看和纠正这些理解，单次行为不能形成永久标签。

这不是把 RabiRoute 扩展成 Agent OS。RabiRoute 仍只负责消息进入、事件记录、路由判断、上下文模板、处理端投递以及回复/审批边界；ASR、声纹推理和 TTS 模型继续归 RabiSpeech，实际回答和工具执行继续归目标 Agent。

## 二、先审计，不要从零开始

目标模式开始后先完成以下只读检查，并把结果写入自己的工作计划：

1. 阅读 `AGENTS.md`、`README.md`、`README_zh.md`、`docs/README.md`、`docs/project-function-map.md`、`docs/code-architecture.md` 及对应英文版。
2. 阅读并核对以下专题文档与真实代码：
   - `主动智能设计思路.md`
   - `docs/rabilink-active-intelligence-requirements.md`
   - `docs/persona-data-sync.md`
   - `docs/rabispeech-plugin.md`
   - `docs/speech-message-endpoint-design.md`
   - `docs/rabilink-relay-server.md`
   - `docs/mobile-message-endpoint.md`
   - `docs/rabilink-phone-edge-hub.md`
   - `docs/current-capabilities.md`
   - `examples/data/roles/RabiActive/README.md`
3. 检查 `git status` 和相关 diff，区分用户已有改动、本任务已完成部分、未完成部分和文档超前部分。不得清理或回退不属于当前任务的改动。
4. 先运行与本任务直接相关的已有单元测试、构建产物烟测和隔离验收，记录真实失败点。不能仅凭文件存在判断功能已经完成。
5. 如果需要修改任何 Agent adapter、Desktop 会话 owner、会话发现或投递链路，必须先完整阅读并遵守 `skills/create-rabiroute-agent-adapter/SKILL.md`；真实 prompt 仍只能通过 Desktop IPC 投给目标任务 owner。

当前代码中已经出现以下方向，优先复用并补齐，不得另建旁路：

| 能力 | 当前应核对的主要拥有者 |
| --- | --- |
| 本机声纹 embedding、聚类、验证门禁 | `plugin-adapters/rabi-speech/rabispeech/speaker_recognition.py` |
| ASR/TTS 文本记录 | `plugin-adapters/rabi-speech/rabispeech/speech_records.py` |
| 主机级语音原始消息 | `src/speechIngressStore.ts` |
| Python/HTTP/人格账本共用转写规范化 | `src/shared/speechTranscript.ts` |
| 语音事实到 Route 事件的字段映射 | `src/routing/speechIngressForwarding.ts` |
| Manager 接收完成 ASR | `src/manager/speechMessageIngress.ts` |
| 人格自己的声纹关系解释 | `src/personaVoiceIdentities.ts` |
| 人格语音历史只读联结 | `src/personaVoiceTranscriptView.ts` |
| 人格文件读取、归档、合并、冲突 | `src/personaSync.ts` |
| peer 发现、LAN/Relay 传输编排 | `src/personaSyncCoordinator.ts` |
| 人格同步派生索引 | `src/personaSyncManifestIndex.ts` |
| 独立局域网数据面 | `src/manager/personaSyncLanServer.ts` |
| Android 连续 PCM 采集与待确认缓冲 | `RabiPhoneAudioCapture`、`RabiPcmUploadBuffer` 及共享协议 |
| 每条 Route 的人格对应与 Agent 投递 | `src/forwarding.ts` |
| 下行可靠队列、回执和安全门 | RabiLink Relay Outbox、RabiRoute Outbox / Action Gate |

如果文档与真实构建产物不一致，以真实调用链和测试为证据：先修正中文事实源和成熟度，再维护英文版。

`examples/data/roles/RabiActive/README.md` 当前仍包含 AIUI 前台连续转录、固定间隔检查和旧账本文件名等历史描述；`docs/rabilink-active-intelligence-requirements.md` 已把手机后端 + 眼镜原生前端、事件驱动审阅和统一会话账本定义为现行主线。目标模式必须核对真实代码后校准或归档旧示例，不能把历史 AIUI 语义重新带回正式链路。

最新产品决策：低打扰、不打扰和更主动都不是固定默认，而是主动决策的不同结果。系统先量化用户当前状态，再结合情景、Agent 人格、用户偏好、Route、收益和风险，决定后台准备、轻提示、主动建议、直接行动或暂不介入。

技术上的去重、幂等和事件驱动只用于避免重复处理，不能决定人格表现。谨慎人格和行动型人格面对同一状态可以采用不同介入方式，但都必须尊重用户明确指令、权限和高风险动作门禁。

不同用户的偏好和性格也不同。目标实现必须新增独立 `UserIndividualModel`，把稳定性格假设、按情景学习的偏好、当前心理状态和情景心理特征分开；不能把它们压成一个人格分，也不能把 Agent 人格误当成用户性格。

性格参考五因素连续维度，只提供低权重候选策略。当前明确指令、用户确认设置和重复纠正拥有更高优先级。一次拒绝、一次情绪变化或一次行为不能形成永久用户结论。

## 三、选定的总体设计

### 方案比较

| 方案 | 说明 | 判断 |
| --- | --- | --- |
| A. 主机事实 + 人格解释 + 边缘可靠队列 | PC 保存通用语音事实；人格保存“这个声纹与我是什么关系”；手机保存待确认上行和下行播放队列；Relay 只发现、唤醒和中转 | **强烈建议，继续沿用现有实现** |
| B. Relay 保存主人格和全部语音事实 | 多设备看似简单，但会制造服务器第二真源、扩大隐私面并让离线合并退化为覆盖 | 不采用 |
| C. PC 麦克风和手机各做一套 ASR/声纹/历史 | 短期接线快，但模型、VAD、身份、去重和路由语义会长期漂移 | 不采用 |

### 唯一真源

| 业务事实 | 唯一真源 | 说明 |
| --- | --- | --- |
| 原始/规范化 ASR 消息 | 当前处理 PC 的主机级语音消息库 | 先记录，后路由；不因 Route 关闭而丢失完成的 ASR 事实 |
| VAD、切句、模型、声纹 embedding | RabiSpeech | Android/浏览器不复制一套判断逻辑 |
| “这个声音是谁”在主机诊断层的候选 | RabiSpeech 本机资料/声纹仓库 | 只用于候选和诊断，不直接定义人格关系 |
| “这个人对当前人格是谁、是不是用户” | 人格目录中的追加式声纹关系事件 | 可同步、可冲突、可显式收敛，不由 Manager 猜测并回写 |
| Route 是否消费某类语音 | Route 配置 | `speech` 与 `rabilink` 是不同消息端类型 |
| 手机待确认 PCM、cursor、下行播放状态 | 手机本机可靠队列 | Relay 不替手机解释 `played` |
| 人格文件正文 | 各 PC 的人格目录 | Relay 不保存服务器主人格 |
| 同步 manifest 索引 | 可删除、可重建的派生缓存 | 命名和行为都不能伪装成正式人格真源 |

### 主链路

```text
PC 麦克风 ───────────────┐
                         ├─> RabiSpeech VAD / 切句 / ASR / 声纹
手机或眼镜有序 PCM -> Relay -> PC worker ┘
                                      |
                                      v
                           主机通用语音消息存储
                                      |
                  ┌───────────────────┴───────────────────┐
                  v                                       v
         speech 消息端订阅                         rabilink 消息端订阅
                  |                                       |
                  └────────> Route / 人格 / Agent <───────┘
                                      |
                                      v
                           Outbox / 回复安全门
                                      |
                    PC 播放或按 sourceDeviceId 回手机/眼镜
```

ASR 处理链可以共用，但消息端身份不能合并。Agent 必须能从 AgentPacket / reply context 中明确知道：这是本机麦克风语音，还是某台手机/眼镜经 RabiLink 传来的语音；回复时不得用临时 stream ID 代替稳定设备 ID。

### 主动智能是上层消费语义

声纹、ASR、消息存储和多设备同步是主动智能的感知与上下文基础，不是主动决策本身。主动智能必须继续遵守以下边界：

1. “持续感知”先形成时间、位置、活动、情绪、身体、注意力、社交、任务、交互、设备和安全等用户状态维度。是否立即说话、后台准备、先询问或直接行动，再由状态、情景、人格、配置和风险综合决定。
2. 每条完成 ASR 先进入主机通用消息库；进入人格后，根据 Route 策略分为即时交互和 record-first observation。即时交互可以按 `hot/keyword` 进入普通投递链；record-first observation 先进入统一会话账本，不逐段唤醒 Agent。
3. 主动审阅只由新增待审阅 observation、手动审阅请求、Agent 空闲后的受控一次性计划事件或明确 timer/heartbeat 触发。禁止固定周期重读 JSONL、查询覆盖率或扫描“有没有变化”。
4. 普通直达消息已经进入 Route/Agent 投递链后，审阅器不得再读一次账本并重复唤醒。
5. 用户 observation、人格/Route 来源、Agent 主动下行、投递终态和回执应位于同一条可审计时间线，便于 Agent 理解“发生了什么、我做了什么、用户是否收到”。主机原始语音库仍与人格统一会话账本分层。
6. 多 Route 批次审阅必须保留每条 observation 的来源 Route 和人格关系，不能回退到默认人格或把所有记录投给同一回复面。
7. 主动介入综合用户状态与可打扰度、主情景与并行情景、Agent 人格主动性、用户偏好、行动收益、时效、置信度和风险。低打扰是合法结果，但不能在基础设施中硬编码为所有人格的默认表现。
8. 用户模型继续区分稳定性格、学习偏好、当前心理状态和情景心理特征。用户可查看依据、确认、纠正、删除、暂停学习和导出；心理数据默认本地保存。
9. 主动帮助应维护用户自主感、胜任感和关系感，不得以互动时长、服从度或情感依赖作为优化目标，也不得从被动信号做临床诊断。
8. 首版不承诺 24 小时原始录音长期保存。可以持续处理并提取上下文，但原始音频默认不长期保存；照片、短视频和完整录音文件按可靠附件任务处理，不与实时 PCM 混用。

## 四、声纹机制继续完善

### 用户结果

用户不应在一天结束后面对一大批无法判断来源的转写。人格查看语音历史时至少能看到：

- `user`：当前人格已确认这是用户本人。
- `other`：当前人格已确认是其他人物，可附显示名和关系。
- `unknown`：声纹证据不足或尚未确认。
- `conflict`：多电脑合并后对同一声纹关系存在并发解释，或同一录音存在无法安全归并的证据。

### 必须补齐的行为

1. 不信任 Provider 跨 turn 的 `speaker=0/1`。每个连续说话 turn 独立提取 embedding，再聚类或匹配已确认原型。
2. 自动识别必须失败关闭。有效语音时长、RMS/峰值、最高相似度、第一/第二候选差距、重叠说话和模型验证状态任一不满足时保持 unknown。
3. 人工确认只确认当前 turn，并把有效 embedding 加入受控原型；不能因为一次误选把整段会话或 Provider label 永久绑定。
4. 主机人物候选不得直接写入人格上下文。人格只接收不透明 `sourceHostId + voiceprintId` 证据，再形成自己的 `displayName / relationship / isUser / aliases / notes` 解释。
5. 多 PC 上本地 cluster ID 可能碰撞，身份键必须包含稳定处理主机 ID；临时 session、设备显示名和数组位置不能充当长期身份。
6. 声纹关系采用追加事件、supersedes 和 tombstone。同步后出现多个并发 head 时保留冲突，不能按 JSONL 行顺序或最后写入时间偷偷决定结果。
7. 原始私人音频、embedding、人物资料和转写正文不得进入仓库、公开报告或 Relay peer 列表。公开验收只保存脱敏计数、哈希、门禁状态和耗时。

### 测试要求

可以使用 TTS 构造快速烟测，但必须清楚它只能验证管线，不代表真实声纹准确率：

1. 使用至少 3 个明显不同的 TTS 声线，生成相同与不同文本。
2. 生成多段单人 turn、交替说话音频，以及把多个声线按时间拼接到一个 WAV 的多说话人样本。
3. 额外生成短片段、低音量、背景噪声和局部重叠样本，确认系统倾向 unknown，而不是强行认人。
4. 验证同一声线跨不连续 turn 能聚合，不同声线不会因为 Provider 都标成 `0` 而合并。
5. TTS 烟测通过后，再用经过明确授权的真实多人私有数据做目标机器验证。正式自动绑定门禁不能被合成样本替代。
6. 测试脚本和报告不得提交生成音频；应使用临时目录，结束后清理，只保留脱敏结果。

## 五、多电脑人格数据同步继续完善

### 用户结果

- 同一 RabiLink 应用 token 下的 PC 能发现彼此，并显示稳定设备身份、在线状态和支持能力。
- 同一局域网内优先直连，速度快且不让人格正文长期停留在服务器。
- 不同网络、NAT 或 LAN 失败时自动退到 Relay 受限中转。
- 同步是合并，不是“最后上传者覆盖所有电脑”。
- Agent 可以通过本机 Manager API 发起同步、读取冲突证据并提交明确解决方案。
- 电脑离线后重新上线，可以从现有共同基线继续收敛，不需要重建整个人格目录。

### 信任与发现

1. 相同应用 token 定义发现作用域，但 token 不应出现在日志、报告、URL、文件名或公开响应中。
2. peer 必须有稳定 GUID；显示名只用于 UI，不作为共同基线或长期身份。
3. 自动发现不等于静默覆盖。首次同步、删除传播和冲突解决必须有明确状态与审计证据。
4. LAN listener 只暴露 persona-sync 的 `manifest / files / merge` 数据面，不能把完整 Manager/WebGUI 暴露给局域网。
5. Relay proxy 使用严格 allowlist，不能变成任意 URL 代理；Relay 不保存主人格、共同基线或可浏览的文件副本。

### 合并语义

- `*.jsonl`：按稳定事件 ID 或内容哈希集合合并；相同 ID 不同正文必须转冲突。
- 普通文件：有共同基线时做三方判断；单边变化快进，双边变化留冲突。
- 首次同步的一侧缺失：按新增复制，不能误判为删除。
- 已有共同基线后的单边缺失：作为删除意图传播；覆盖或删除前先归档。
- 删除与编辑并发：保留正式文件并生成冲突证据，禁止静默删除或复活。
- 人格声纹关系：JSONL 合并后仍要检测语义分支；文件合并成功不等于人物关系已经收敛。
- 锁、临时文件、派生 manifest、TTS 缓存和其它可重建缓存不参与同步。
- 路径必须阻止 `..`、绝对路径、符号链接和 Windows junction 穿越。

### 自动同步策略

先保证显式同步和恢复语义正确，再增加自动化。推荐：

1. 文件事件只维护本机 manifest 派生索引并发出“有变化”事件，不在每次保存后立即跨机洪泛同步。
2. 可配置的自动同步由独立 coordinator 触发，例如设备重新上线、用户手动请求、Agent 明确调用、应用启动后的单次对账或受控防抖窗口。
3. 同一 peer/人格并发请求 single-flight；失败后保留可解释状态，不启动隐蔽无限轮询。
4. peer 离线、Relay 失败或目标文件已经变化时，返回 `not_published / pending / conflict` 等真实终态，不能声称完成。
5. 后续如果提供 WebGUI，应展示最近同步时间、实际传输方式、待处理冲突和“本地解决但尚未发布到远端”的状态。

## 六、统一语音消息存储与消息端分离

### 存储原则

ASR 成功后先写一次主机通用消息，再广播给订阅该消息端的 Route。不要让每条 Route 各保存一份“原始消息”，也不要因没有 Route 订阅而丢失已经完成的通用 ASR 事实。

建议以版本化 envelope 保存，核心字段稳定，扩展字段放在受控子对象中；“尽量多记录”不等于无限收集隐私或把 Provider 私有响应原样永久保存。

```json
{
  "schemaVersion": 1,
  "recordId": "<stable-record-id>",
  "messageAdapterType": "speech | rabilink",
  "routeKind": "speech | rabilink",
  "sourceDeviceId": "<stable-device-id>",
  "sourceStreamId": "<temporary-stream-id>",
  "sourceHostId": "<processing-host-id>",
  "captureStartedAt": "<iso-time>",
  "captureEndedAt": "<iso-time>",
  "asrCompletedAt": "<iso-time>",
  "receivedAt": "<iso-time>",
  "text": "<transcript>",
  "language": "<language>",
  "provider": "<provider-id>",
  "model": "<model-id>",
  "durationMs": 0,
  "sampleRateHz": 16000,
  "channels": 1,
  "audioFormat": "pcm_s16le",
  "rms": 0.0,
  "peak": 0.0,
  "segments": [],
  "words": [],
  "voiceprintEvidence": [],
  "transport": {
    "relayTaskId": null,
    "chunkCount": 0,
    "lastChunkId": null
  },
  "extensions": {}
}
```

约束：

- `recordId` 是完成 ASR 消息的幂等身份；重复补交不能再次写库或投递。
- `sourceDeviceId` 是稳定回复目标；`sourceStreamId` 只是本次连接，断线重建后可以变化。
- 主机级存储保留不透明声纹证据，但删除主机人物姓名、资料 ID、候选人物名和“已验证用户”等人格解释。
- 人格历史只在 Route 实际消费后追加，并保持来源消息端、设备、时间、声纹证据和回复上下文。
- PC 麦克风使用 `messageAdapterType=speech`；手机/眼镜经 Relay 使用 `messageAdapterType=rabilink`。二者文本相同也不能变成同一来源类型。
- Route 选择器不是来源身份；带 `routeProfileId` 的手机消息仍然是 RabiLink 来源。

## 七、手机离线、恢复与可靠投递

### 上行 PCM

1. 手机按稳定 `chunkId` 和从 1 开始的流内序号发送有序 PCM，只有收到 PC/Relay 确认后才推进已提交位置。
2. ACK 丢失后允许在新 stream 中重发同一个 `chunkId`。PC 以 `sourceDeviceId + chunkId + PCM SHA-256` 去重，重复块不能再次进入 VAD/ASR。
3. 手机明确无网时由系统网络回调阻塞发送；网络恢复立即唤醒。只有服务端可达性失败时才使用有界的一次性退避。
4. 实时语音采用有界最新缓冲。长时间断网后丢弃已经失去实时价值的过旧 PCM，恢复后尽快追上当前语音；不能把数小时旧音频按实时对话突然全部投递。
5. 对需要完整保存的“录音文件上传”另定义离线文件任务，不与实时 PCM 缓冲混为一谈。文件任务可以断点续传和最终补投，实时流则优先低延迟和新鲜度。
6. PC/worker/Relay 重启后，重复块、已完成 record 和已投递 Route 都要有幂等证据，避免重复唤醒 Agent。
7. “一天持续陪伴”应理解为持续处理、提取事件和积累人格上下文，不默认等于把全天原始 PCM 或录音永久上传、保存和回放。采集状态必须可见、可暂停，Android 后台采集必须使用可见 Foreground Service。

### 下行回复

- Relay 拥有带明确目标的 Outbox 消息和设备回执。
- 手机拥有持久 cursor、可靠下载队列和本机播放编排。
- `delivered` 只表示目标设备已可靠接收；`played` 必须由真正完成播放的手机或眼镜产生。
- 网络恢复后先由事件唤醒，再按持久 cursor 做一次增量补漏；SSE 不是唯一数据真源。
- 明确目标设备的消息在所有目标 `delivered` 前不能仅因短 TTL 被清理。
- 回执先进入设备本地持久队列，联网后补传；重复回执必须幂等。

## 八、Route、Agent 与回复边界

1. Manager 对每条完成 ASR 只接收和保存一次，再按消息端类型广播给全部订阅 Route。
2. 每条 Route 独立决定热投递、关键词唤醒、record-first observation、人格对应、回复自动播放和是否允许通过 RabiRoute 回传。
3. `src/forwarding.ts` 继续是路由模板、人格上下文和处理端投递的核心；不要让 RabiSpeech、Android 或 Relay 反向定义 RouteDecision。
4. AgentPacket 必须包含来源消息端、稳定设备、处理主机、记录 ID、时间、分段声纹证据和安全的 reply context。
5. 手机语音默认回复原 `sourceDeviceId`；PC 麦克风默认留在 PC/Agent 或按 Route 配置播放。目标不明确或 policy 禁止时返回 blocked/draft，不猜测外发目标。
6. 人格是否回应“其他人说的话”属于人格与 Route 的决策，不属于主机声纹层。声纹层只提供证据和当前人格关系视图。
7. record-first observation 进入统一会话账本后，只能由事件驱动审阅器在合适时机消费；审阅完成并安全落盘后才推进持久审阅状态。
8. Agent 主动下行不依赖某条上行任务 ID，但必须保留 Route、人格、明确目标和 Outbox 安全语义，并写回同一人格时间线。

## 九、实施顺序

### 阶段 0：基线审计

- 盘点已有未提交实现和测试。
- 运行最小相关测试，记录失败与未覆盖场景。
- 确认现有数据目录、API、Schema 和文档是否已经发生迁移。
- 把“已经完成、需要修正、尚未实现、需要实体设备验收”分开列出。

### 阶段 1：声纹正确性闭环

- 完成多 turn、unknown、重叠、低质量和人工确认语义。
- 完成多声线 TTS 合成烟测脚本和脱敏报告。
- 确认真实人物自动绑定门禁不能被测试捷径绕过。
- 验证人格关系事件在多 PC 合并后的冲突与收敛。

### 阶段 2：通用消息与两类入口

- 固化版本化语音消息契约和字段清洗规则。
- 验证 PC 麦克风与手机流共用处理链，但生成不同消息端类型。
- 验证主机只写一次、人格按实际消费写入、同人格多 Route 不重复。
- 验证 AgentPacket 和回复目标使用稳定设备身份。
- 验证即时交互与 record-first observation 使用同一消息事实但不同消费策略，普通直达消息不会被主动审阅器重复消费。

### 阶段 2.5：主动审阅和可配置主动性

- 固化新增 observation、手动请求、Agent 空闲和明确 timer/heartbeat 的事件驱动 wake 条件。
- 删除或隔离固定周期读账本、覆盖率轮询和历史 AIUI 自动续接旁路。
- 验证多 Route 批次保留来源 Route/人格，并按记录决定回复面。
- 验证安静、标准、主动和高主动等策略可以由人格/配置选择，而不是在基础设施里硬编码静默优先；主动下行仍写回统一会话账本并经过动作安全门。
- 设计并实现追加式用户模型事件、可重建 `UserIndividualModel` 和当前情景最小注入切片；先完成明确偏好与用户纠正，再逐步加入低权重性格假设。
- 验证同一会议情景下，不同用户偏好与不同 Agent 人格可以产生不同介入方式，同时不绕过明确指令和风险门禁。

### 阶段 3：手机断网和恢复

- 覆盖无网启动、传输中断网、ACK 丢失、PC 重启、Relay 重启、SSE 重连和长时间离线。
- 区分实时 PCM 最新缓冲与可最终补投的录音文件任务。
- 验证上行、完成 ASR、Route 投递、下行消息和回执的各级幂等。

### 阶段 4：多电脑人格同步

- 先通过本机双节点构建产物验收。
- 再用两台实体 PC 验证 LAN-first、Relay fallback、离线重连、并发编辑、删除/编辑冲突和大目录性能。
- 补齐 Agent 调用接口或最小 WebGUI 状态面板，但不创建浏览器第二存储。

### 阶段 5：文档、归档与发布口径

- 根据最终真实行为更新中英文 README、架构、功能地图、RabiSpeech、Relay、手机消息端、人格同步、用户指南、排障和版本日志。
- 旧文档若被替代，先复制到 `archive/` 下对应原相对路径，再从正式索引中移除或标记为过时；不要维护两套都像现行方案的说明。
- 示例只使用占位 token、localhost、模板变量和脱敏路径；不得提交 `data/`、音频、转写、embedding、真实设备 ID 或私人关系资料。

## 十、验证矩阵

| 场景 | 必须观察的结果 |
| --- | --- |
| 同一 TTS 声线、不同文本、多个不连续 turn | 聚合为同一候选声纹 |
| 不同 TTS 声线被 Provider 都标成 `0` | 不合并为同一人物 |
| 低音量、过短、噪声、重叠 | 保持 unknown 或低置信，不强认 |
| 用户与旁人交替说话一天 | 人格历史可按 user/other/unknown/conflict 筛选和汇总 |
| PC 麦克风与手机说相同文本 | 进入同一处理能力，但保留 `speech`/`rabilink` 不同来源 |
| 手机断网后恢复 | 自动恢复；实时流追上当前，待确认块不重复识别 |
| ACK 丢失并重建 stream | 同 chunk 重发被去重，后续新 chunk 正常推进 |
| Agent 回复手机 | 使用稳定 `sourceDeviceId`，不使用旧 stream ID |
| 同 token 两 PC 同网 | 自动发现并实际使用 LAN 数据面 |
| LAN 被防火墙阻断 | 受限 Relay fallback 成功，不暴露完整 Manager |
| 双方同时改普通文件 | 正式文件不被静默覆盖，生成可解决冲突 |
| 一侧删除、一侧编辑 | 生成删除/编辑冲突并保留证据 |
| 双方并发修改人格声纹关系 | JSONL 合并保留多个 head，显示语义冲突 |
| 离线 PC 重连 | 从共同基线继续同步，状态可解释且不重复洪泛 |
| Manager/Relay/手机任一重启 | cursor、recordId、chunkId、deliveryId 继续保证幂等 |
| record-first 连续 observation | 逐段落账但不逐段唤醒，settle 后只产生一次受控审阅 |
| 普通 hot/keyword 直达消息 | 只走普通 Route 投递，不被审阅器再次消费 |
| 没有新 observation 或到期 timer | 不重读账本、不查询覆盖率、不制造空轮询 |
| 多 Route observation 批次 | 每条记录保留原 Route/人格，回复不回退默认人格 |
| 人格或用户选择高主动模式 | Agent 可以更积极提示、追问、准备和发起任务，不被基础设施静默压制 |
| 人格或用户选择安静模式 | 按配置减少主动表现，但仍正常记录和维护上下文 |
| 两个用户在同一会议情景中偏好不同 | 一个即时收到短任务卡，另一个会后收到汇总；结果可解释并可纠正 |
| 单次拒绝或情绪波动 | 只更新当前证据或形成低置信假设，不写成永久性格或全局偏好 |
| 用户纠正系统对其偏好的理解 | 追加纠正事件，当前模型立即重建，旧结论不再参与主动决策 |

最低应执行并按实际仓库脚本调整的验证包括：

```powershell
npm run build:backend
npm run check:built-manager
npm run check:speech-ingress-separation
npm run check:persona-sync:dual-node
```

同时运行相关 TypeScript、Python、Android/协议和 Relay 测试。实体双 PC、真实手机断网、真实多人声纹和公网 Relay 测试不能被 mock 或单机双节点代替。

## 十一、完成定义

只有同时满足以下条件，目标模式才可以把任务标记为完成：

- 声纹链路能可靠区分已确认用户、其他人物、未知和冲突；低质量样本不会强行绑定。
- 多声线 TTS 管线烟测通过，并完成至少一次经过授权的真实多人目标机验证，或者明确标注仍待实体数据验收，不能虚报成熟度。
- PC 麦克风和手机/眼镜音频流共用唯一 ASR/声纹拥有者，同时在存储、路由和回复上下文中保持不同消息端身份。
- 即时语音与 record-first observation 的消费语义清楚；主动审阅事件驱动、无业务空轮询、无重复消费，主动程度由人格和用户配置决定。
- 用户个体模型区分稳定性格假设、情景偏好、当前心理状态和情景心理特征，并具有证据、置信度、有效期、纠正和删除语义。
- 用户可查看、确认、纠正、暂停、删除和导出系统对自己的长期理解；Agent 人格与用户性格保持两个独立真源。
- 手机无网、重连、ACK 丢失和服务重启场景具备可验证恢复语义，没有重复 ASR、重复 Route 投递或错误回复目标。
- 同应用 token 的两台实体 PC 可以发现彼此；LAN 可达时确认实际直连，LAN 不可达时确认受限 Relay fallback。
- 人格同步覆盖新增、单边修改、双边修改、JSONL 合并、删除传播、删除/编辑冲突、声纹语义冲突和解决结果发布。
- 所有正式状态都有唯一真源；缓存、manifest、UI view model 和 Relay 中转没有变成第二事实源。
- 相关测试通过，失败/限制有明确记录；未执行实体测试时不能用“已完成”替代“代码就绪、待实体验收”。
- 所有受影响公开文档均完成中英文同步，旧文档已按需要归档，索引、示例和版本日志不再指向过时链路。
- 最终交付说明列出：复用与修改的模块、关键数据流、测试命令与结果、实体设备证据、文档变更、仍存在的限制和未解决风险。

## 十二、实现自查

- 是否把主机声纹候选误当成人格最终身份？
- 是否让 Android、Relay、WebGUI 或某条 Route 保存了第二套 ASR/VAD/人物真源？
- 是否为了“参数多”而永久保存了无必要的隐私或 Provider 原始响应？
- 是否把临时 stream、显示名、数组位置或 Provider speaker 标签当成长期身份？
- 是否在网络恢复时同时由 SSE、轮询和定时器重复触发补投？
- 是否把主动智能误写成逐条 ASR 必须回答，或用固定轮询账本冒充持续感知？
- 是否让已经直达 Agent 的消息又被主动审阅器重复消费？
- 是否把“避免重复处理”错误扩张成全局静默、少参与或低主动性的产品原则？
- 是否让同 token 自动发现退化成无提示自动覆盖或远程任意文件访问？
- 是否只验证了单机 mock，却把多 PC、断网或真实声纹写成已完成？
- 是否复用了 `forwarding.ts`、Outbox、人格目录和现有 Manager 模块，而不是增加旁路？
- 是否检查并同步了中英文公开文档，或明确说明为何某个内部重构无需更新？
