# RabiLink

## Description

RabiLink 是 Rokid 眼镜上的 Agent 消息端，同一个 AIUI 页面只有两个产品模式：`连接对话`和`配置助手`。

- `连接会话`：眼镜原生 ASR 的最终文本只追加到 PC Rabi 的统一会话账本，不逐句打断 Agent。Codex 在线程空闲时主动审阅；用户单击触摸板时立即提示审阅，线程执行中使用 `turn/steer` 引导。普通 Agent 回复与主动投递共用持续下行队列，并由眼镜原生 TTS 依次播报。
- `配置助手`：同页 AIUI 原生 ASR 采集语音，AIUI 原生 `LanguageModel` 理解自然语言并通过白名单 `toolcall` 选择配置动作，页面再调用 Relay / WebGUI 接口；眼镜外层 Agent 也可直接传入明确 `intent`。

## 调用规则

- 用户打开 RabiLink、要求开始会话、恢复记录或说“切到连接对话”时，调用 `pages/home/index` 并设置 `mode=transcription`。已有 `rabilinkToken` 时把 `token` 引用到该记忆变量；尚未配置时省略 `token`，仍然先打开页面并显示等待连接。
- 页面已经打开时，用户可滑到`配置助手`后直接描述配置需求。页面用同一个 AIUI `SpeechRecognition` 控制器按单轮识别，把完整原话交给页面内 `LanguageModel`；模型只能通过 `execute_configuration_action` 白名单工具选择已有动作，不能直接声称配置成功。
- 页面外已绑定的灵珠智能体仍可先把复杂需求归一化成明确命令，再调用同一个 `pages/home/index`，设置 `mode=configuration` 并写入 `intent`。`intent` 也可以使用命令 ID，例如 `loadConfig`；不要把未经理解的长段自然语言原样传入。
- `surface` 和 `panel` 只保留为兼容性的配置范围提示，不会打开旧的分页仪表盘。
- 页面已经打开时，两种模式必须在同一个 AIUI 页面内切换：后滑/下滑或选择滑轨右侧切到`配置助手`；前滑/上滑、左滑、返回键或选择滑轨左侧回到`连接对话`。禁止调用页面结束方法或要求用户再次点击“进入”。
- 连接会话模式下，触摸板单击/确认键不是暂停键，而是“现在审阅会话记录”。Codex 空闲时开始新 turn；已有 turn 执行时通过 `turn/steer` 作为引导加入当前任务。不得因此停止 ASR 或下行轮询。
- 配置助手与连接对话共享页面内受控的 AIUI `SpeechRecognition`，但各自拥有独立模式状态，禁止 ASR、模型理解和 TTS 并发抢占。配置助手不维护 `taskId`、任务完成态或任务轮询；模型不确定时只追问，不回退为 RabiLink task。
- 页面内 `LanguageModel` 是 AIUI 原生模型会话，不是递归进入已绑定灵珠智能体的完整 Agent Loop；它不会自动继承外层智能体的记忆、变量或插件。外层 Agent 仍可通过页面 schema 传入已归一化的 `intent`。

## 消息规则

- 连接会话的上行使用 `/rokid/rabilink/input`，并带 `type=rabilink.observation`、`deliveryMode=observe` 和稳定 `clientMessageId`。响应只表示观察已接受；PC worker 把它写入账本，不直接 forward 到 Agent。
- 统一账本是当前人格目录的 `rabilink-conversation.jsonl`。用户观察和成功投递的 Agent 下行都写入该文件；每行一个 JSON。跨本地日期或超过 `rabilinkConversationSplitAfterHours` 空档后，旧文件机械移动到 `rabilink-conversations/<日期>.jsonl`，`index.json` 只保存时间范围和条数，不生成总结。Manager 与 Gateway 并发写入时必须由数据目录中的跨进程锁保护去重、分卷、索引和追加。
- 自动审阅只处理 `requiresReview=true` 的新增用户观察，并只在固定 Codex 线程空闲时启动。待审阅时间线必须合并归档索引、归档分卷和当前 JSONL，不能因 Codex 离线期间发生分卷而跳过 observation。审阅提示必须要求 Agent 读取 JSONL；不得把触发提示本身当作用户正文。
- 连接对话始终按 cursor 消费 `/rokid/rabilink/messages?stream=1`。首次连接从空 cursor 读取 Relay 保留期内的 backlog；即使没有刚刚提交的语音，也必须继续等待主动消息。
- Relay 下行 outbox 独立于 task 生命周期，默认保留 48 小时。AIUI 收到消息批次时必须先按 token 持久化待播报项，再保存 `nextCursor`；页面隐藏、切模式或 TTS 中断不得删除未播完消息。
- 普通回复和主动投递进入同一条有序 TTS 队列，并在成功进入 Relay 后写回同一会话账本。TTS 开始前释放 ASR；成功播报后才移除持久消息；当前播报结束后，如连接会话仍在前台且未暂停，再恢复下一轮 ASR。
- 主动智能通过现有 `/api/agent/replies` 输出门投递：指定 `targetType=rabilink`、`proactive=true` 和目标 `routeProfileId`。RabiRoute 会直接写入持续下行队列，不需要伪造用户任务。
- 不需要额外导入 RabiLinkMessage MCP/插件；AIX、Relay 和 RabiRoute 输出门已经覆盖输入、持续下行和主动投递。
- AIUI 只在页面前台续接原生 ASR，不保存原始音频。离线文本队列最多保留 48 小时、2000 段待同步；不得声称退出页面、锁屏或进入后台后仍像 FenneNote/Android 前台服务一样持续录音。

## 安全边界

- `token` 是可选调用参数；未配置时页面必须仍可打开。传入时只能引用智能体记忆变量 `rabilinkToken`，禁止生成、读取、复述、记录或向用户询问 token。
- 本地 observation、cursor 和待播 TTS 队列必须按不含凭证片段的稳定 token 指纹隔离；禁止用 token 首尾掩码作为存储键，也禁止在切换 token 后继承另一账号的待同步或待播数据。
- Relay URL 和真实 `rbl_...` token 不得写入 AIX 包、仓库、提示词、知识库或聊天记录。
- PC RabiRoute 是配置唯一真源。删除、清空、修复等高风险动作仍需用户确认；页面未收到 PC 成功结果前不得声称修改完成。
- HUD 电量只能来自未过期的手机 CXR 眼镜 `deviceStatus`；浏览器、手机宿主或小程序通用电量字段不得冒充眼镜电量。取不到时显示 `--`，不得伪造百分比或充电状态。
