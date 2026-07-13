# RabiLink

## Description

RabiLink 是 Rokid 眼镜上的 Agent 消息端，同一个 AIUI 页面只有两个产品模式：`连接对话`和`配置助手`。

- `连接对话`：眼镜原生 ASR 把语音作为输入事件交给已绑定的 PC Rabi；普通 Agent 回复与主动投递共用一条持续下行队列，并由眼镜原生 TTS 依次播报。
- `配置助手`：眼镜原生 Agent 先理解用户需求，再带着明确配置指令调用 AIUI；页面只执行对应的 Relay / WebGUI 配置接口。

## 调用规则

- 用户打开 RabiLink、要求开始对话、恢复聆听或说“切到连接对话”时，调用 `pages/home/index`，设置 `mode=transcription`，并把 `token` 引用到记忆变量 `rabilinkToken`。
- 用户提出配置需求时，原生 Agent 必须先把需求归一化成 AIX 支持的明确命令，再调用同一个 `pages/home/index`，设置 `mode=configuration`，并把规范命令写入 `intent`。例如：`读取配置`、`保存配置`、`连接服务器`、`读取路由`。
- `intent` 也可以使用已有命令 ID，例如 `loadConfig`。不要把未经理解的长段自然语言原样传给页面；页面不会猜测，也不会把它提交成 RabiLink task。
- `surface` 和 `panel` 只保留为兼容性的配置范围提示，不会打开旧的分页仪表盘。
- 页面已经打开时，两种模式必须在同一个 AIUI 页面内切换：后滑/下滑或选择滑轨右侧切到`配置助手`；前滑/上滑、左滑、返回键或选择滑轨左侧回到`连接对话`。禁止调用页面结束方法或要求用户再次点击“进入”。
- 配置助手不创建页面私有 SpeechRecognition，也不维护 `taskId`、任务完成态或任务轮询。语义理解和语音入口归眼镜原生 Agent；页面只执行明确指令并显示结果。

## 消息规则

- 连接对话的上行使用 `/rokid/rabilink/input`。响应只表示输入事件已接受，眼镜端不得依赖内部 worker task ID。
- 连接对话始终按 cursor 消费 `/rokid/rabilink/messages?stream=1`。即使没有刚刚提交的语音，也必须继续等待主动消息。
- 普通回复和主动投递进入同一条有序 TTS 队列。TTS 开始前释放 ASR；当前播报结束后，如连接对话仍在前台且未暂停，再恢复下一轮 ASR。
- 主动智能通过现有 `/api/agent/replies` 输出门投递：指定 `targetType=rabilink`、`proactive=true` 和目标 `routeProfileId`。RabiRoute 会直接写入持续下行队列，不需要伪造用户任务。
- 不需要额外导入 RabiLinkMessage MCP/插件；AIX、Relay 和 RabiRoute 输出门已经覆盖输入、持续下行和主动投递。
- AIUI 只在页面前台续接原生 ASR。不得声称退出页面、锁屏或进入后台后仍像 FenneNote 一样持续录音。

## 安全边界

- `token` 必须引用智能体记忆变量 `rabilinkToken`。禁止生成、读取、复述、记录或向用户询问 token。
- Relay URL 和真实 `rbl_...` token 不得写入 AIX 包、仓库、提示词、知识库或聊天记录。
- PC RabiRoute 是配置唯一真源。删除、清空、修复等高风险动作仍需用户确认；页面未收到 PC 成功结果前不得声称修改完成。
- HUD 电量只能来自宿主 Battery API、小程序兼容字段或未过期的手机 CXR `deviceStatus`；取不到时显示 `--`，不得伪造百分比或充电状态。
