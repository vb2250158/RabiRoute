# RabiLink 原生主动智能应用设计

日期：2026-07-09

本文是 RabiLink 手机端和眼镜端从“设备探针 / Rabi Glass Test”走向可落地原生应用的实施方案。

设计重点不是再做一个需要唤醒词的官方助手技能，而是实现 FenneNote 式主动智能：用户开启后，RabiLink 持续处于交互状态，能一直听、持续形成上下文，并随时连接本地 Rabi / Codex / 其他 Agent。

## 核心结论

第一版走原生路线：

```text
RabiLink 手机 App = 主应用、常驻录音桥、配置主控台、Relay/本地 Agent 连接器
Rabi Glass 眼镜 App = 低干扰 AR HUD、状态显示、少量快捷控制
RabiLink Lab = 保留现有测试接口，收进高级入口
灵珠 / 官方助手 = 既有兼容路径，保留但不作为本文主线
```

第一版不以“眼镜端原生 ASR/TTS”作为主链路前提。根据现有真机资料，普通第三方 CustomApp 不能假设直接拿到系统 ASR 文本或系统 TTS。原生路线的可落地主链路是：手机常驻录音和转写，眼镜做 HUD 和控制，本地 Agent 在 PC 侧处理。

第一版成功句：

```text
打开 RabiLink 主动智能后，不喊 Hi Rokid，不点官方助手，只自然说话，也能进入 RabiRoute / 本地 Agent；PC Rabi 的回复能回到手机和眼镜。
```

## 产品北极星

你买眼镜想要的不是“我问一句，AI 答一句”，而是随身本地 Agent 感知层：

```text
我不一定需要说出完整指令；
RabiLink 能持续听我说、听我所听、看我所看；
它把现场上下文整理成可控、可审计的事件流；
本地 Rabi / Codex / 其他 Agent 基于这些上下文理解我正在做什么；
在合适时机给我提示、记录、提醒、分析或接续操作。
```

落地顺序：

1. 听我说：手机常驻录音、切句、ASR、投递本地 Agent。
2. 听我所听：区分用户麦克风、系统音频、眼镜/手机环境声，避免 TTS 回流。
3. 看我所看：眼镜拍照或截图作为显式事件，先手动触发，再评估低频自动采样。
4. 行为分析：把语音、视觉、时间、位置、PC Agent 状态整理成事件，不直接把原始流无限上传。

安全边界：

- 用户显式开启后才持续感知。
- 手机和眼镜都持续显示当前是否在听、看、分析。
- 原始音频和图片默认不长期保存。
- 保存、上传、投递、重试、清除都要可见、可暂停、可配置。

## 和官方路线的关系

官方 Rokid / 灵珠路径保留，不删除、不重做、不作为本文主线。

官方路线的价值：

- 可以继续作为现有 RabiLink Relay / OpenAPI / 灵珠工具入口。
- 适合“用户主动叫一次助手”的场景。
- 适合验证官方平台能否把文本请求转到 RabiRoute。

官方路线不是主线的原因：

- 官方 AI assistant 通常要求 `Hi Rokid`、触摸或手势激活。
- 它默认是一次性问答或平台托管会话。
- 它不能满足“开启后一直处于交互状态”的主动智能目标。

本文主线是原生 RabiLink：

```text
手机常驻录音
-> 手机 ASR
-> RabiLink Relay
-> PC Rabi worker
-> RabiRoute rabilink 消息端
-> 本地 Agent
-> Relay 下行消息
-> 手机通知 / Rabi Glass HUD
```

参考：

- [Rokid Glasses 官方页](https://global.rokid.com/pages/rokid-glasses)
- [Rokid Academy](https://global.rokid.com/pages/academy)
- [Hi Rokid - Google Play](https://play.google.com/store/apps/details?hl=en_US&id=com.rokid.sprite.global.aiapp)
- [Hi Rokid - App Store](https://apps.apple.com/us/app/hi-rokid-rokid-glasses/id6749669942)
- [RokidAiSdk 文档](https://developer.rokid.com/docs/5-enableVoice/rokid-vsvy-sdk-docs/RokidAiSdk/RokidAiSdk.html)
- [OpenVoice Speech API](https://developer.rokid.com/docs/3-ApiReference/openvoice-speech-api.html)
- [OpenVoice HTTP TTS](https://developer.rokid.com/docs/3-ApiReference/openvoice-http-tts.html)

## v1 范围

### 必做

| 项 | 交付物 | 入口 |
| --- | --- | --- |
| 手机首页产品化 | `RabiLink` 首页显示主动智能、眼镜、Relay、PC、Route、Agent 状态 | `examples/android-rabi-link-probe/app/src/main/java/com/rabi/link/MainActivity.kt` |
| 测试入口收纳 | 保留测试接口，改名 `RabiLink Lab`，放到设置高级入口 | `TestCenterActivity.java`、`MainActivity.kt` |
| 手机控制台 | 原生页负责主动智能开关、录音、通知、眼镜桥和 Lab；复杂 Rabi/Route/Codex 配置可直接打开 WebGUI | `MainActivity.kt` + WebView/外部浏览器 + 新 `modules/rabilink/*` |
| 常驻录音服务 | Android foreground service，开启后无需唤醒词，持续听、VAD、切句 | 新 `modules/rabilink/voice/*` |
| 主动智能状态机 | `listening / segmenting / transcribing / dispatching / waiting / replying / muted / offline / error` | 新 `modules/rabilink/session/*` |
| 手机 ASR | 第一版支持一个云 ASR Provider，可抽象成 OpenAI-compatible/DashScope | 新 `RabiLinkAsrClient` |
| Relay task 提交 | Android SDK 增加 `submitRabiLinkTask` | `sdk/android/rabiroute-sdk/.../RabiRouteSdk.kt` |
| Relay 下行拉取 | Android SDK 增加 `getRabiLinkMessages`，手机长轮询全局下行队列 | 同上 |
| 眼镜 HUD | `Rabi Glass` 显示状态和最近回复，右滑菜单可开始/暂停 | `examples/android-rabi-link-probe/glass-asr/.../GlassAsrProbeActivity.java` |
| 手机到眼镜命令 | 统一 `RABI_GLASS_*` 协议，用 CXR CustomCmd 下发 | `RokidCxrController` / `RokidNativeVoiceBridge` / 眼镜 APK |
| 可执行验收 | 每阶段有构建、脚本或真机检查项 | 本文 |

### 暂不做

| 项 | 原因 | 后续进入条件 |
| --- | --- | --- |
| 重做灵珠路径 | 已有兼容路径，当前目标转为原生主动智能 | 单独需求再做 |
| 眼镜端原生 ASR/TTS 作为主链路 | 当前真机资料显示不可假设 ready | 真机有 `RABI_ASR:<text>` / `RABI_TTS_OK:<text>` 或官方凭证闭环 |
| 自动持续拍照/录像 | 隐私和电量风险高 | 先做显式拍照事件 |
| PC 接收原始音频再转写 | 手机更适合权限、蓝牙、前台服务和网络重试 | 手机 ASR 不可用或质量不足 |
| 大而全眼镜聊天 UI | 眼镜输入和阅读不方便 | 手机端消息体验稳定后再扩展 |

## 主链路架构

```text
RabiLinkVoiceService
  -> AudioRecord
  -> VAD / segmenter
  -> ASR client
  -> submitRabiLinkTask
  -> Relay /rokid/rabilink/tasks
  -> PC Rabi worker /worker/tasks
  -> RabiRoute rabilink adapter
  -> Agent / Codex
  -> RabiRoute outbox
  -> Relay /rokid/rabilink/messages
  -> RabiLinkOutboxPoller
  -> phone activity / notification / Rabi Glass HUD
```

现有能力复用：

| 能力 | 状态 | 入口 |
| --- | --- | --- |
| Relay 应用 token 和 PC worker 绑定 | 已有 | `/api/rabilink/mobile/state` |
| 手机读取 PC Route / Codex 绑定 | 已有 | `/api/rabilink/mobile/routes`、`agent-options`、`agent-binding` |
| PC worker 领取 task | 已有 | `/worker/tasks` |
| PC worker 回写分句回复 | 已有 | `/worker/tasks/<taskId>/messages`、`finish` |
| 眼镜/插件提交 task | 已有 | `POST /rokid/rabilink/tasks` |
| 全局下行消息 | 已有 | `GET /rokid/rabilink/messages?after=<cursor>` |
| Android SDK 读 mobile state/routes | 已有 | `RabiRouteSdk.getMobileState/getMobileRoutes/...` |
| CXR CustomApp 与眼镜 APK 双向命令 | 已验证 | `examples/android-rabi-link-probe/modules/rokid`、`glass-asr` |

需要补的 Android SDK 方法：

```kotlin
data class RabiLinkSubmittedTask(
    val taskId: String,
    val cursor: String,
    val nextCursor: String,
    val status: String,
    val rawJson: JSONObject
)

data class RabiLinkDownstreamMessage(
    val id: String,
    val taskId: String,
    val text: String,
    val final: Boolean,
    val rawJson: JSONObject
)

data class RabiLinkMessageBatch(
    val nextCursor: String,
    val shouldContinue: Boolean,
    val messages: List<RabiLinkDownstreamMessage>,
    val rawJson: JSONObject
)

fun submitRabiLinkTask(
    relayBaseUrl: String,
    token: String,
    text: String,
    sourceDeviceId: String,
    sourceDeviceName: String,
    sessionId: String = ""
): RabiLinkSubmittedTask

fun getRabiLinkMessages(
    relayBaseUrl: String,
    token: String,
    after: String,
    waitMs: Int = 60000
): RabiLinkMessageBatch
```

对应 HTTP：

```http
POST /rokid/rabilink/tasks
GET /rokid/rabilink/messages?after=<cursor>&waitMs=<0..60000>
```

## 主动智能状态机

```text
stopped
  -> starting
  -> listening
  -> segmenting
  -> transcribing
  -> dispatching
  -> waiting_reply
  -> listening

任意状态 -> muted
任意状态 -> offline
任意状态 -> error
muted -> listening
error -> listening / stopped
```

状态副作用：

| 状态 | 手机 | 眼镜 |
| --- | --- | --- |
| `stopped` | 录音和轮询停止 | 清空 HUD |
| `listening` | 前台服务通知“正在听” | `SHOW_STATUS listening` |
| `segmenting` | buffer 中检测到语音 | 小状态点变亮 |
| `transcribing` | 调 ASR | `SHOW_STATUS transcribing` |
| `dispatching` | 提交 Relay task | `SHOW_STATUS sending` |
| `waiting_reply` | 继续拉取下行 | `SHOW_STATUS thinking` |
| `replying` | 展示通知和活动记录 | `SHOW_REPLY` |
| `muted` | 停止录音，保留下行连接 | `SHOW_STATUS muted` |
| `offline` | 暂停提交，保留本地队列 | `SHOW_STATUS offline` |
| `error` | 记录错误和恢复建议 | `SHOW_STATUS error` |

开启和暂停入口：

| 操作 | 手机 | 眼镜 |
| --- | --- | --- |
| 开启主动智能 | 首页主开关、通知按钮 | 右滑菜单 `开始听` |
| 暂停听取 | 首页、通知按钮 | 右滑菜单 `暂停` |
| 静音回复 | 首页快捷动作 | 右滑菜单 |
| 完全停止 | 首页、通知按钮 | 菜单确认 |
| 清空 HUD | 首页快捷动作 | 菜单 |

## 录音和转写策略

第一版沿用 FenneNote 思路：

```text
麦克风音频
-> 预录 buffer
-> 达到录音阈值开始片段
-> 低于转写阈值一段时间后切句
-> ASR 得到文本
-> 文本过滤
-> 提交 Relay task
```

默认参数：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `sampleRate` | `16000` | ASR 兼容优先 |
| `preRollMs` | `500` | 减少句首丢字 |
| `minSegmentMs` | `700` | 过短丢弃 |
| `maxSegmentMs` | `30000` | 防止无限长句 |
| `silenceMs` | `700` | 安静多久切句 |
| `recordThreshold` | 自动 | 可手动微调 |
| `transcribeThreshold` | 自动 | 低于则丢弃 |
| `adaptiveNoise` | 开启 | 根据底噪抬高录音线 |

文本过滤：

- 空文本、明显幻听、重复短语不提交。
- 连续多段太短时合并再提交。
- “暂停”“先别听”“停止 Rabi”等本地控制词优先本地执行。
- 普通有效片段统一包装成 `voice_transcript` task。

第一版先只做“听我说”。“听我所听”和“看我所看”作为后续阶段，但接口要预留 `source`、`modality`、`attachments`。

## Relay 接口契约

### 提交转写

```http
POST /rokid/rabilink/tasks
Content-Type: application/json
X-RabiLink-Token: <app-token>

{
  "type": "voice_transcript",
  "source": "rabilink-mobile",
  "sourceDeviceId": "phone-<install-id>",
  "sourceDeviceName": "RabiLink Android",
  "sessionId": "voice-20260709",
  "clientMessageId": "seg-20260709-000001",
  "text": "帮我总结一下刚才的会议重点",
  "meta": {
    "inputMode": "continuous_voice",
    "modality": "microphone",
    "asrProvider": "dashscope",
    "language": "zh-CN"
  }
}
```

返回：

```json
{
  "ok": true,
  "taskId": "rabilink-relay-...",
  "cursor": "out-000000123",
  "nextCursor": "out-000000123",
  "status": "pending"
}
```

实现要求：

- 本地保存 `clientMessageId` / `segmentId`，避免重试重复提交。
- 409/404/503 要显示为“未选择 PC / PC 离线 / token 无效”等用户能理解的状态。
- text 为空、过短或只有噪声词时不提交。

### 拉取下行

```http
GET /rokid/rabilink/messages?after=<lastCursor>&waitMs=60000
X-RabiLink-Token: <app-token>
```

处理规则：

1. 有 `messages` 时按顺序展示并转发给眼镜 HUD。
2. 每次用响应 `nextCursor` 覆盖本地 cursor。
3. `shouldContinue=true` 时继续长轮询。
4. App 后台时通过前台服务保留轮询，并在通知里说明正在连接 Rabi。
5. App 完全退出时停止轮询；下次启动从本地 cursor 继续。

## 手机本地状态模型

第一版用 `SharedPreferences` + JSONL 文件，暂不引入数据库。

| 数据 | 存储 | 说明 |
| --- | --- | --- |
| `relayBaseUrl` | encrypted/shared prefs | Relay URL |
| `appToken` | encrypted/shared prefs | 应用 token，只显示预览 |
| `installId` | shared prefs | 手机稳定设备 ID |
| `selectedPcId` | shared prefs | 当前目标 PC |
| `selectedRouteId` | shared prefs | 当前 route |
| `lastOutboxCursor` | shared prefs | 下行消息游标 |
| `activeMode` | shared prefs | stopped/listening/muted |
| `asrConfig` | encrypted/shared prefs | ASR Provider 和 key |
| `voice-segments.jsonl` | app files | 本地切句、转写、提交状态 |
| `relay-messages.jsonl` | app files | 下行消息缓存 |

`voice-segments.jsonl`：

```json
{
  "segmentId": "seg-20260709-000001",
  "status": "submitted",
  "startedAt": "2026-07-09T12:00:00.000Z",
  "endedAt": "2026-07-09T12:00:04.200Z",
  "text": "帮我记录一下这个方案",
  "taskId": "rabilink-relay-...",
  "error": ""
}
```

`relay-messages.jsonl`：

```json
{
  "messageId": "out-000000124",
  "taskId": "rabilink-relay-...",
  "text": "第一条回复。",
  "final": false,
  "receivedAt": "2026-07-09T12:00:05.000Z"
}
```

## Android 实现拆分

### 手机端

新增包：

```text
com.rabi.link.modules.rabilink
  RabiLinkSettingsStore
  RabiLinkRelayClient
  RabiLinkOutboxPoller
  RabiLinkVoiceService
  RabiLinkAudioRecorder
  RabiLinkVadSegmenter
  RabiLinkAsrClient
  RabiLinkSessionController
  RabiLinkGlassHudBridge
  RabiLinkNotificationPresenter
```

职责：

| 类 | 职责 |
| --- | --- |
| `RabiLinkSettingsStore` | 保存 Relay、token、PC、Route、cursor、ASR 和录音设置 |
| `RabiLinkRelayClient` | 包装 Android SDK 的 task 提交和下行拉取 |
| `RabiLinkVoiceService` | 前台服务生命周期、录音开关、通知 |
| `RabiLinkAudioRecorder` | AudioRecord 采样、权限检查、音频 buffer |
| `RabiLinkVadSegmenter` | FenneNote 式阈值、预录 buffer、安静切句 |
| `RabiLinkAsrClient` | 调用 ASR Provider |
| `RabiLinkSessionController` | 主动智能状态机和本地控制词 |
| `RabiLinkOutboxPoller` | 长轮询 Relay 下行消息 |
| `RabiLinkGlassHudBridge` | 把状态和回复转成 `RABI_GLASS_*` 命令 |
| `RabiLinkNotificationPresenter` | 前台服务通知、错误通知、最近回复 |

### 眼镜端

眼镜 APK 继续使用 `com.rabi.link.glass`，显示名改为 `Rabi Glass`。

先在 `GlassAsrProbeActivity.java` 内收束正式 HUD，后续再拆：

```text
GlassHudState
GlassHudRenderer
GlassHudMenuController
GlassHudCommandHandler
```

HUD 状态：

| 状态 | 展示 |
| --- | --- |
| `idle` | 透明主页，小状态点 |
| `listening` | 底部一行“正在听” |
| `transcribing` | 底部一行“正在转写” |
| `sending` | 底部一行“已发送给 Rabi” |
| `thinking` | 底部一行“Rabi 正在处理” |
| `reply` | 显示一条短回复，几秒后收起 |
| `muted` | 显示“已暂停” |
| `offline` | 显示“Rabi 离线” |
| `error` | 显示短错误，可右滑查看详情 |
| `menu` | 横向菜单 |
| `debug` | 原测试日志页 |

## 手机到眼镜协议

统一 `RABI_GLASS_*` 命令，正式 HUD 不再复用 `RABI_ASR_*` 测试命令。

| 命令 | 方向 | 含义 |
| --- | --- | --- |
| `RABI_GLASS_SHOW_STATUS:<json>` | 手机 -> 眼镜 | 更新状态层 |
| `RABI_GLASS_SHOW_REPLY:<json>` | 手机 -> 眼镜 | 显示一条回复 |
| `RABI_GLASS_CLEAR` | 手机 -> 眼镜 | 清空 HUD，回 Home |
| `RABI_GLASS_OPEN_MENU` | 手机 -> 眼镜 | 打开菜单 |
| `RABI_GLASS_START_LISTENING` | 眼镜 -> 手机 | 用户从眼镜菜单请求开始录音 |
| `RABI_GLASS_STOP_LISTENING` | 眼镜 -> 手机 | 用户从眼镜菜单请求停止录音 |
| `RABI_GLASS_MUTE_REPLY` | 眼镜 -> 手机 | 静音回复 |
| `RABI_GLASS_PING` / `RABI_GLASS_PONG` | 双向 | 连接探活 |

`SHOW_STATUS`：

```json
{
  "state": "listening",
  "text": "正在听",
  "routeName": "RabiLink",
  "pcName": "Workstation",
  "timestamp": "2026-07-09T12:00:00.000Z"
}
```

`SHOW_REPLY`：

```json
{
  "messageId": "out-000000124",
  "taskId": "rabilink-relay-...",
  "text": "第一条回复。",
  "final": false,
  "timestamp": "2026-07-09T12:00:02.000Z"
}
```

眼镜端只渲染，不保存 token，不直接访问 Relay。

## 手机 UI

手机是 RabiLink 的控制台，但不需要把所有配置都原生重写。第一版分两层：

```text
手机原生层：主动智能开关、常驻录音、权限、通知、眼镜 HUD 桥、最近活动、RabiLink Lab
WebGUI 层：Rabi/Route/Codex/Relay 等复杂配置，复用现有 RibiWebGUI 和远程 WebGUI
```

眼镜只保留轻量 HUD、开始/暂停、最近回复和少量快捷控制。复杂配置回到手机；手机里复杂配置优先打开 WebGUI。

一级页面：

| 页面 | 作用 |
| --- | --- |
| 首页 | 主动智能总开关；显示眼镜、录音、Relay、PC Rabi、Route、Codex 状态 |
| 录音 | 配常驻录音、阈值、VAD、ASR Provider，查看切句和转写队列 |
| Rabi | 显示当前 Relay / PC / Route 摘要，并提供 `打开 WebGUI` |
| 眼镜 | 连接/授权 Rokid，安装或启动 `Rabi Glass`，管理 HUD 模式 |
| 活动 | 转写历史、Agent 回复、失败重试、下行消息 |
| 设置 | 隐私、保存音频、通知、电量、网络、调试入口 |

首页区块：

| 区块 | 控件 | 行为 |
| --- | --- | --- |
| 主动智能 | 大开关 `开启 / 暂停` | 启停 `RabiLinkVoiceService` |
| 当前状态 | `正在听 / 已暂停 / 正在转写 / Rabi 正在处理 / 离线` | 来自服务状态机 |
| 设备链路 | 眼镜、Relay、PC Rabi、Route 四个状态点 | 点任一项进入对应配置 |
| 最近一句 | 最新转写和最新回复 | 点开活动页 |
| 快捷动作 | 静音回复、暂停投递、清空 HUD | 本地状态变更 |

录音配置：

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| 主动智能开机自启 | 关闭 | 第一版先不默认开机自启 |
| 前台服务通知 | 开启且不可关闭 | Android 常驻录音必须透明 |
| 麦克风设备 | 系统默认 | 后续可选蓝牙/手机麦克风 |
| 录音阈值 | 自动 | 可手动微调 |
| 转写阈值 | 自动 | 低于则丢弃 |
| 静音切句时间 | `700ms` | 对齐 FenneNote |
| 保存原始音频 | 关闭 | 打开后显示保留时间 |
| ASR Provider | DashScope 或 OpenAI-compatible | 第一版只实现一个也可以 |
| ASR API Key | 本机私有 | 不进日志 |

Rabi 配置：

| 配置 | 来源 | 说明 |
| --- | --- | --- |
| Relay URL / 应用 token | 手机原生最小配置，或 WebGUI 绑定流程 | 手机需要保存 token 才能常驻录音和拉下行 |
| PC Rabi | `/api/rabilink/mobile/state` 或 WebGUI | 首页只显示摘要，复杂选择打开 WebGUI |
| Route | WebGUI 优先 | 避免手机原生重复实现 route 配置 |
| Codex 工作区 / 会话 | WebGUI 优先，`agent-options` 可作快捷读写 | 首版可以保留现有原生快捷绑定，也可以直接跳 WebGUI |
| Relay 管理控制台 | `/manage` | 创建 token、选择 PC、查看日志 |
| PC RibiWebGUI | `/manage/<账号>/<RabiGUID>/#/routes` 或本机 WebGUI | 配 route、人格、Agent、日志 |
| 下行 cursor | 本地保存 | 断线恢复 |

手机 Rabi 页建议只做三件事：

1. 显示当前绑定摘要：Relay、PC、Route、Codex 会话、在线状态。
2. 提供快捷按钮：`打开服务器控制台`、`打开 PC WebGUI`、`刷新状态`。
3. 必要时保留少量原生快捷绑定，但不把完整 WebGUI 重写一遍。

RabiLink Lab：

```text
设置 -> 高级 -> RabiLink Lab
```

Lab 保留现有测试接口：

| 模块 | 保留原因 |
| --- | --- |
| RabiRoute / RabiLink 测试台 | 验证 Relay、Route、Codex 绑定和双向投递 |
| Rokid 眼镜接口测试 | 验证 CXR、CustomApp、音频流、拍照、设备信息 |
| Rabi Glass debug | 验证 HUD 命令、ping、状态和错误 |
| 原生 ASR/TTS 探针 | 后续拿到官方凭证时继续验证 |
| 小米接口测试 | 现有项目能力保留，但不在主动智能主流程 |

Lab UI 文案：

```text
RabiLink Lab
开发和排障入口。普通使用不需要进入这里。
```

## 眼镜 UI

眼镜 UI 原则：少显示、少输入、可快速回到透明主页。复杂配置去手机。

导航：

```text
Home
  右滑 -> Menu 1
  继续右滑 -> Menu 2 / Debug

Menu 最左页
  继续左滑 -> Home

任意页面长按/返回键
  -> Home
```

Home：

- 默认透明黑底或近似透明，不占用视野。
- 只显示小状态点或 1 行状态。
- 不显示滚动日志。

Menu：

- 第一页：开始听、暂停、静音回复、最近回复。
- 第二页：清空 HUD、Rabi 状态、打开 debug。
- 需要复杂配置时显示“请在手机 RabiLink 中配置”。

最小功能：

- 显示连接状态。
- 接收 `SHOW_STATUS / SHOW_REPLY / CLEAR`。
- 右滑打开菜单。
- 菜单能开始/停止手机常驻录音。
- 能显示最近一条 Rabi 回复。
- 能进入 debug 页查看桥接状态。

## 命名和工程调整

当前：

- 手机 APK：`com.rabi.link`，显示名 `RabiLink`。
- 眼镜测试 APK：`com.rabi.link.glass`，显示名 `Rabi Glass Test`。
- 手机端首页有 `接口测试中心`。

调整：

| 对象 | 正式命名 | 说明 |
| --- | --- | --- |
| 手机 App | `RabiLink` | 主应用 |
| 眼镜 App | `Rabi Glass` | 去掉 `Test` |
| 测试中心 | `RabiLink Lab` | 高级/隐藏/debug 入口 |

代码改动：

- `glass-asr/src/main/AndroidManifest.xml` 的 `android:label` 改为 `Rabi Glass`。
- `copyGlassAsrDebugApk` 输出名从 `rabi-glass-test-debug.apk` 改为 `rabi-glass-debug.apk`。
- 手机 UI 文案里的 `Rabi Glass Test` 改为 `Rabi Glass`。
- 首页不再显示 `打开接口测试中心`；改到 `设置 -> 高级 -> RabiLink Lab`。

## RabiRoute 边界

RabiLink 手机和眼镜都是消息端，不是 Agent runtime。

RabiRoute 继续负责：

- 接收 `rabilink` 入站事件。
- 写 `rabilink-voice-transcripts.jsonl`。
- 做 RouteDecision。
- 构造 AgentPacket。
- 投递本地 Agent。
- 通过 Outbox / RabiLink replies 回传。

RabiLink 不绕过 RabiRoute 直接写眼镜。正式下行走 Relay / Outbox / 全局下行队列，保证可审计、可重试、可隔离 token。

## 隐私和安全

常驻感知比普通助手更敏感，必须产品化处理：

- 默认不保存原始音频。
- 保存音频时明确显示目录、保留时间和清理按钮。
- ASR API Key、Relay token 只存在 Android 私有存储。
- token 只显示预览，不进日志、不进截图、不进证据包。
- 录音、转写、投递、下行、HUD、播报分开开关。
- 锁屏、低电量、断网、PC 离线时有清楚状态。
- PC Rabi 离线时不创建无目标任务，沿用当前 Relay 约束。
- “看我所看”阶段必须先显式触发拍照，自动视觉采样另写方案和授权。

## 实施里程碑

### M0 文档和命名

改动：

- 本文进入 `docs/README.md`。
- `Rabi Glass Test` 命名收敛为 `Rabi Glass`。
- `接口测试中心` 命名收敛为 `RabiLink Lab`。

验收：

- 文档索引能打开本文。
- `rg "Rabi Glass Test|接口测试中心"` 只剩 Lab/debug 语境。

### M1 手机配置主控台

改动：

- 首页改为状态面板和主动智能总开关。
- Relay token、PC、Route、Codex 绑定仍复用现有 API。
- Lab 移入设置高级入口。

验收：

- 不进入 Lab 也能完成 Relay、PC、Route、Codex 配置。
- 断开 token / PC 离线能显示错误。

### M2 Android SDK 用户侧 task API

改动：

- 增加 `submitRabiLinkTask`。
- 增加 `getRabiLinkMessages`。
- 增加对应数据类。

验收：

- 用手机 SDK 提交一条文本能在 Relay 创建 task。
- 用手机 SDK 拉取到模拟 worker 回写的全局下行消息。

### M3 常驻录音和 ASR

改动：

- 新增 `RabiLinkVoiceService`。
- 新增 AudioRecord + VAD + ASR。
- 生成 `voice-segments.jsonl`。

验收：

- 开启主动智能后，不喊唤醒词，说一句自然语言能生成转写。
- 空文本和过短噪声不提交。
- 前台服务通知持续显示当前正在听。

### M4 投递本地 Agent

改动：

- ASR 文本调用 `submitRabiLinkTask`。
- 下行 poller 长轮询 global messages。
- 手机活动页显示上下行。

验收：

- 语音片段进入 PC Rabi 的 `rabilink` route。
- PC Rabi/Codex 回复回到手机。

### M5 Rabi Glass HUD

改动：

- 眼镜 App 改名 `Rabi Glass`。
- 增加 `RABI_GLASS_*` 命令处理。
- 默认 HUD 不显示测试按钮。
- debug 页保留原测试能力。

验收：

- 手机发送 `SHOW_STATUS listening`，眼镜显示正在听。
- PC 回复下行后，眼镜显示最近一条回复。
- 眼镜菜单 `暂停` 能让手机停止录音。

### M6 看我所看预留

改动：

- task payload 预留 `attachments` 和 `modality`。
- 眼镜拍照作为手动事件进入活动页。

验收：

- 手机能发送带图片附件元数据的本地事件草稿。
- 不做自动拍照，不默认上传图片。

## 完成判定

第一版完成必须满足：

1. 主入口是原生 RabiLink 主动智能，不是灵珠/官方唤醒词。
2. 手机开启后无需唤醒词，持续听、切句、转写、投递。
3. 手机可配置 Relay、PC、Route、Codex、ASR、录音阈值和眼镜 HUD。
4. 测试接口完整保留在 `RabiLink Lab`。
5. 眼镜端显示状态和回复，但复杂配置都回到手机。
6. PC Rabi / 本地 Agent 能通过 Relay 双向通信。
7. 所有常驻感知都有可见状态、暂停入口和隐私说明。
