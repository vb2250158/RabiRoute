# RabiLink AIUI 常驻与主动智能边界

更新时间：2026-07-14

本文回答两个问题：

1. 只把 RabiLink AIUI 保持在眼镜前台，能否形成可用的主动智能闭环？
2. 能否像 FenneNote 一样，在退出页面、锁屏或宿主回收后继续 24 小时录音转写？

## 确切结论

```text
AIUI 前台常驻：可以完成 RabiLink 主动智能的眼镜端闭环。
系统级 24 小时后台录音：AIUI 不能承诺，也不是当前实现。
```

当前 RabiLink AIUI 已实现：

- 眼镜前台的一轮一轮原生 ASR 自动续接，不要求每句话重复唤醒词。
- ASR 最终文本只作为 observation 写入 PC 统一账本，不逐句直接投递 Codex。
- Codex 在线程空闲时审阅新增记录；没有新记录时也可按周期反思用户目标、计划和未完成事项。
- 连接对话中单击触摸板，空闲时由 Desktop owner 立即开始审阅，执行中则 steer 当前轮次。
- Codex、定时器和规划器可在没有上行 `taskId`、甚至眼镜尚未打开时主动写入下行队列。
- 眼镜恢复连接对话后按 cursor 消费普通回复和主动消息，并调用 AIUI 原生 TTS 顺序播报。
- 用户 observation、Agent 已成功排队的下行和触摸板控制事件位于同一条 JSONL 时间线。
- 配置助手在同一页面使用 AIUI 原生 ASR 与 `LanguageModel` 理解自然语言，再调用白名单 RabiLink/WebGUI 配置动作。

当前 AIUI 不能保证：

- 页面隐藏、退出、锁屏或宿主回收后继续采集麦克风。
- 系统级 24 小时后台录音。
- FenneNote 的 PCM、电平、动态底噪、前置缓存、Whisper 概率或自定义 VAD。
- 眼镜端保存原始音频；当前只保存待同步文本。

所以“24 小时”必须拆成两个产品层级：

```text
RabiLink AIUI
  = 眼镜前台交互端
  = HUD + 原生 ASR + 原生 TTS + 配置助手 + 触摸板审阅

FenneNote 或未来 Android foreground service
  = 真正常驻感知端
  = 后台麦克风 + VAD/切句 + 断线恢复 + 系统生命周期
```

## 当前数据流

```text
眼镜前台 ASR
  -> /rokid/rabilink/input
  -> record-only observation
  -> PC worker 立即写入 rabilink-conversation.jsonl
  -> 不创建必须等待回答的页面任务
  -> Codex 固定线程空闲审阅 / 周期反思 / 触摸板引导

Codex / 定时器 / 规划器
  -> RabiRoute /api/agent/replies 输出安全门
  -> targetType=rabilink, proactive=true
  -> Relay 持久 outbox
  -> /rokid/rabilink/messages?stream=1
  -> AIUI 持久待播队列
  -> 眼镜原生 TTS
```

上行与下行是两条独立推进的队列。用户说话不是 Agent 主动下行的前提，Agent 下行也不会阻塞下一段 observation。

## 统一会话账本

当前人格目录保存：

```text
rabilink-conversation.jsonl
rabilink-conversation-review-state.json
rabilink-conversations/
  index.json
  YYYY-MM-DD.jsonl
  YYYY-MM-DD-02.jsonl
```

每行是一条独立 JSON：

- `direction=user_to_agent`：眼镜 observation，通常带 `requiresReview=true`。
- `direction=agent_to_user`：已经成功进入 RabiLink 下行队列的 Agent 消息。
- `direction=control`：触摸板审阅请求等控制事件。

跨本地日期或连续空档达到 `rabilinkConversationSplitAfterHours`（默认 6 小时）时，当前文件机械移动到日期分卷。归档不总结、不重写原文。索引使用原子替换，读取时间线时也扫描日期文件，因此索引损坏或进程在移动后退出不会把旧 observation 永久藏掉。

审阅游标同样使用同目录临时文件原子替换。游标损坏时回退为重新计算 pending 范围，优先容忍重复审阅，不静默丢记录。

## 前台 ASR 的真实能力

AIUI 官方 `SpeechRecognition.start()` 表示开始一轮识别。当前页面把它组织成受控循环：

1. 页面首帧完成后启动一轮识别。
2. 收到最终文本后执行保守后处理和持久排队。
3. `onend` 后仅在页面仍可见、用户未暂停、模型和 TTS 未占用麦克风时开启下一轮。
4. 快速空结束或错误采用指数退避；连续失败 5 次后暂停，避免 QuickJS/Ink 重建循环卡死。

参考 FenneNote 后，AIUI 端能够复刻的只有文本层规则：

- 压缩空白。
- 丢弃纯标点。
- 抑制 2.5 秒内完全相同的重复结果。
- 原生 TTS 后 12 秒内过滤高度相似的回声。
- 离线文本按 token 的不透明指纹隔离，最多保存 48 小时、2000 段。

不能复刻的音频层规则包括动态噪声门、前置音频缓存、自定义 VAD、Whisper 置信度和原始音频回放，因为 AIUI `SpeechRecognition` 没有向页面暴露这些数据。

## 原生 TTS 边界

当前官方 `speechSynthesis` 文档公开 `speak(utterance, mode?)`，并支持 `enqueue`/`immediate`，但没有承诺完整 utterance 生命周期事件，也没有公开可靠的 `cancel/pause/resume`。

旧实现等待 `utterance.onend` 才释放 `speechActive`，这能够解释真眼镜上“配置助手说一句后停住”：宿主不回调时，ASR 永远不会恢复。

当前实现：

- 使用文档定义的 `speechSynthesis.speak(utterance, "enqueue")`。
- 宿主提供 `onend/onerror` 时立即收尾。
- 宿主不提供事件时，按文本长度使用 1.8 到 90 秒的保守 watchdog 收尾并恢复 ASR。
- 单条 Agent 消息连续失败 3 次后保留在持久队列但让出队首，后续主动消息继续播报。
- 连接对话显示 `TTS 失败，单击重试` 时，触摸板单击重置失败项并重试。

watchdog 解决的是状态机永久卡住，不代表本地模拟已经证明真机播报时长。最终仍需在眼镜上确认不会过早恢复 ASR、不会把尾音重新识别，也不会在长文本结束后等待过久。

## 配置助手边界

配置助手与连接对话位于同一 InkView，不要求再次点击进入：

- 后滑/下滑/右方向进入配置助手。
- 前滑/上滑/左方向或返回键回到连接对话。
- 两种模式共享一个 `SpeechRecognition` 控制器，ASR、`LanguageModel` 和 TTS 串行交接。
- 页面内 `LanguageModel` 只负责把自然语言选择成白名单动作；它不是递归调用当前绑定灵珠智能体的完整 Agent Loop。
- 外层已绑定智能体仍可把归一化后的明确 `intent` 传给同一页面。
- PC RabiRoute 是配置唯一真源；删除、清空、外发、设备控制等高风险动作仍需确认。

不需要再导入一组 RabiLinkMessage MCP。AIX 页面、Relay mobile/WebGUI 代理和 RabiRoute 输出门已经覆盖输入、配置、持续下行和主动投递。

## 生命周期与可靠性

| 场景 | 当前行为 |
| --- | --- |
| 页面前台、网络正常 | ASR 自动续轮，持续下行长轮询，TTS 顺序播报 |
| 页面前台、网络断开 | observation 和未播消息保留在本地队列，恢复后重试 |
| Codex 在眼镜打开前主动发送 | Relay outbox 保留至少 48 小时，首次连接读取 backlog |
| TTS 中途切模式或隐藏页面 | 未确认完成的消息仍在持久队列，恢复连接对话后继续 |
| 页面退出或宿主回收 | ASR 停止；不能声称仍在后台录音 |
| 手机/眼镜离线 | HUD 电量显示 `--`；旧 CXR 状态不能冒充当前设备 |

## 真正 24 小时常驻的后续方案

若产品必须满足“锁屏、切应用、页面退出后仍持续转写”，需要独立生命周期的常驻采集端：

```text
Android foreground service / FenneNote
  -> 麦克风与系统常驻通知
  -> AudioRecord + VAD/切句
  -> 本地 ASR 或受控云 ASR
  -> 同一个 /rokid/rabilink/input observation 契约
  -> 同一个 PC JSONL、审阅器和主动下行队列
```

这个常驻端应复用现有 record-first 契约，不建立另一套会话语义。AIUI 继续负责眼镜 HUD、触摸板、前台语音和原生 TTS；常驻服务只负责系统生命周期无法由 AIUI 承担的采集部分。

RabiRoute 现在也支持把已有的 FenneNote 或其它命名 Webhook 转写源并入同一个 record-first 账本。做法是在承载 `RabiActive` 的同一条 Route 中增加对应消息端，并设置：

```json
{
  "messageAdapters": ["rolePanel", "rabilink", "fennenote"],
  "messageAdapterPolicies": {
    "rolePanel": {
      "inputEnabled": true,
      "outputEnabled": true,
      "supportedOutputs": ["text", "image", "voice", "file"]
    },
    "rabilink": {
      "inputEnabled": true,
      "outputEnabled": true,
      "supportedOutputs": ["text"]
    },
    "fennenote": {
      "inputEnabled": true,
      "outputEnabled": false,
      "supportedOutputs": []
    }
  },
  "fenneNoteWebhookPort": 8797,
  "fenneNoteWebhookPath": "/fennenote",
  "routeVariables": {
    "rabilinkRecordFirstSources": "fennenote"
  }
}
```

随后让 FenneNote 把转写发到该端口。命中的段落仍会写普通转写日志，同时以稳定消息身份追加为 `requiresReview=true` 的 observation；携带相同消息 ID，或没有 ID 但携带相同生产端时间戳与正文的 webhook 重试不会生成第二条账本记录，也不会直接创建 Codex turn。审阅器仍按空闲、周期或触摸板请求工作，Agent 下行仍只走 RabiLink 队列。

这只是可用的 PC 常驻补充源，不会把 PC 麦克风伪装成眼镜麦克风，也不会让 AIUI 获得后台生命周期。未来手机或眼镜 Android foreground service 应优先直接复用 Relay 的 `/rokid/rabilink/input` observation 契约。

安全要求：

- 必须显式开启，并持续显示录音状态。
- 默认不长期保存原始音频。
- 转写、原始音频、外发和删除分别授权。
- 防止 TTS 或系统播放音频再次进入 ASR 回流。
- 退出、暂停和清除必须有明确用户控制。

## 当前验收边界

本地自动化已经覆盖 record-first 双向队列、统一 JSONL、空闲/周期审阅、触摸板 steer、配置白名单、TTS 无生命周期回调、坏消息让出队首、离线 backlog、模式往返、Ink 卡片到沉浸 resize、黑帧和字体压力。

本地通过仍不等于真眼镜通过。最终必须使用当前发布版本完成：

1. Craft 上传、云端绑定、提审和手机添加。
2. 眼镜前台连续多轮 ASR。
3. 配置助手连续两轮自然语言配置，不停在第一句。
4. 普通回复和无前置输入的主动消息原生 TTS。
5. TTS 后 ASR 恢复且不回声。
6. 页面隐藏/恢复后的待播队列。
7. 真实触摸板切模式和单击审阅。
8. 未过期的 CXR 电量/充电状态。
9. 当前版本、20 分钟内、同一页面 session 的启动和 Relay/配置运行证明。

在这些外部证据完成前，准确表述是：

```text
RabiLink AIUI 的前台主动智能闭环已完成本地实现和自动化验收；
系统级 24 小时录音不属于 AIUI 能力；
当前 AIX 仍待 Craft 与真眼镜最终验收。
```

## 相关资料

- [RabiLink AIUI README](../examples/rabilink-aiui/README.md)
- [安装与排障](../examples/rabilink-aiui/docs/installation-and-troubleshooting.md)
- [验收报告](../examples/rabilink-aiui/docs/acceptance-report.md)
- [Relay 与双向队列](rabilink-relay-server.md)
- [主动智能总纲](../主动智能设计思路.md)
- [AIUI 快速开始](https://js.rokid.com/AIUI/guide/quickstart?lang=zh-CN)
- [AIUI 沉浸式应用](https://js.rokid.com/AIUI/guide/quickstart-first-immersive?lang=zh-CN)
- [SpeechRecognition](https://js.rokid.com/AIUI/api/ai/speech-recognition?lang=zh-CN)
- [SpeechSynthesis](https://js.rokid.com/AIUI/api/ai/speech-synthesis?lang=zh-CN)
- [LanguageModel](https://js.rokid.com/AIUI/api/ai/language-model?lang=zh-CN)
