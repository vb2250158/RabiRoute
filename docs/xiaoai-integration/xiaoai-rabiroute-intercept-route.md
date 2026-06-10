# 小爱音箱接入 RabiRoute 的拦截式技术路线

调研/设计日期：2026-06-06
目标：把小米音箱/小爱同学作为 RabiRoute 的语音入口之一。用户平时仍然对小爱说话；RabiRoute 按规则拦截部分意图，把它转给 Agent；Agent 可以通过 RabiRoute 暴露的工具接口控制米家、红外、Home Assistant、本地脚本等能力。

本文里的 `LobbyRoute` 按当前项目名理解为 `RabiRoute`。

## 核心结论

这条路线可行，但不要把它设计成“RabiRoute 直接改造小爱音箱”。更稳的边界是：

```text
小爱音箱入口层
  -> XiaoAI Bridge / Webhook Adapter
    -> RabiRoute 规则拦截
      -> Agent
        -> RabiRoute Tool Gateway
          -> Home Assistant / 米家 / BroadLink / ESPHome / 本地脚本
```

小爱相关开源项目可以作为“入口桥”，但 RabiRoute 不应该强依赖某个已停止维护的项目。`open-xiaoai`、`mi-gpt`、`migpt-next` 这条线已归档，适合作为参考，不适合作为主干。更现实的是支持多种入口桥：

1. `xiaogpt` 类：不刷机，通过小米账号/服务链路拿到小爱文本并回复。
2. `open-xiaoai` 类：刷机/补丁，能更深地控制音箱，但机型窄、风险高。
3. 米家/Home Assistant 类：不是拦截小爱对话，而是让 RabiRoute 调用米家/HA 设备能力。

参考来源：

- open-xiaoai 已归档、README 标注停止维护，并且限制机型：[idootop/open-xiaoai](https://github.com/idootop/open-xiaoai)
- MiGPT Next 已归档、README 指向停止维护：[idootop/migpt-next](https://github.com/idootop/migpt-next)
- xiaogpt 仍是较常用的小爱接大模型路线：[yihong0618/xiaogpt](https://github.com/yihong0618/xiaogpt)
- 小米官方 Home Assistant 集成：[XiaoMi/ha_xiaomi_home](https://github.com/XiaoMi/ha_xiaomi_home)
- 社区 Xiaomi MIoT HA 集成：[al-one/hass-xiaomi-miot](https://github.com/al-one/hass-xiaomi-miot)

## 你想要的产品形态

用户体验应该是：

```text
用户：小爱同学，帮我问一下 Rabi，今天电脑上那个任务跑完了吗？
小爱音箱：收到，我帮你问。
RabiRoute：规则命中 -> 转给指定 Agent -> Agent 查询工具/状态
小爱音箱：Rabi 说，任务还在跑，最后一条日志是……
```

也可以是：

```text
用户：小爱同学，把客厅空调调到 26 度，然后告诉 Rabi 我回来了。
RabiRoute：拆成两个动作
  1. device.control: living_room_ac.cool_26
  2. agent.message: 我回来了
Agent/RabiRoute：通过 Home Assistant 或 BroadLink 执行空调动作，再按规则回复。
```

关键点：RabiRoute 拦截的是“被规则命中的一部分请求”，不是接管小爱所有能力。没有命中的请求继续让小爱/米家自己处理。

## 小爱音箱能力清单

下面不是小米官方稳定 API 列表，而是从开源项目和 Home Assistant 生态可以利用的能力分类。具体可用性取决于音箱型号、固件、账号地区、米家绑定状态和所选桥接项目。

### 1. 语音输入 / ASR 文本

可做：

1. 获取用户对小爱说的话的文本结果。
2. 根据文本触发 RabiRoute 规则。
3. 记录原始文本、设备 ID、时间、会话 ID。

常见路线：

```text
小爱音箱 -> xiaogpt/MiService 类桥 -> RabiRoute webhook
```

限制：

1. 不刷机路线通常拿到的是“小爱已经识别后的文本”，不是原始音频。
2. 能不能“只拦截部分请求，其余放行给小爱”取决于桥接方式；很多项目更像“特定唤醒词进入 ChatGPT 模式”。
3. 小爱云侧行为变化会影响可用性。

### 2. 语音输出 / TTS 播报

可做：

1. 让小爱音箱播报 RabiRoute/Agent 的回答。
2. 播放短文本、任务状态、提醒结果。
3. 作为 RabiRoute 的一个 `replyTarget`。

常见路线：

```text
RabiRoute -> XiaoAI Bridge -> 小爱音箱播报
RabiRoute -> Home Assistant Xiaomi media_player -> 小爱音箱播报
RabiRoute -> 米家/MIoT service -> 小爱音箱播报
```

限制：

1. TTS 能力往往依赖云或非官方接口。
2. 播报会打断音箱当前播放。
3. 长文本体验差，适合短答复。

### 3. 媒体播放控制

可做：

1. 播放/暂停/继续。
2. 音量调节。
3. 播放指定 URL 或音乐资源，取决于桥接和设备支持。

RabiRoute 可以把这些封装成工具：

```json
{
  "tool": "speaker.media",
  "action": "set_volume",
  "device": "bedroom_xiaoai",
  "volume": 35
}
```

限制：

1. 播放网络 URL 的能力不一定所有型号都支持。
2. 音乐服务受版权、账号、地区影响。

### 4. 米家设备 / 场景控制

可做：

1. 触发米家场景。
2. 控制已接入米家的灯、插座、空调伴侣、部分红外设备。
3. 通过 Home Assistant 的 Xiaomi Home / Xiaomi MIoT 集成间接控制。

推荐路线：

```text
RabiRoute -> Home Assistant -> Xiaomi Home / MIoT -> 米家设备/场景
```

不推荐路线：

```text
RabiRoute -> 小爱音箱自然语言命令 -> 小米云 -> 米家设备
```

原因是后者不可观测、不可稳定重试，也难以做状态管理。

### 5. 红外控制

可做：

1. 如果音箱本身带红外，可能能通过米家 App/小爱控制空调电视。
2. RabiRoute 可以先触发米家场景，让小爱/米家红外执行。
3. 更稳定的红外执行建议交给 BroadLink RM4 或 ESPHome IR。

推荐路线：

```text
RabiRoute -> HA script/scene -> BroadLink/ESPHome -> 空调/电视
```

临时路线：

```text
RabiRoute -> HA -> 米家场景 -> 小爱/米家红外 -> 空调/电视
```

### 6. 对话模式 / Agent 接入

可做：

1. 特定前缀触发 Agent，例如“问 Rabi……”“让 Rabi……”“进入 Rabi 模式”。
2. 多轮对话：桥接层保留 session，或 RabiRoute 保留 session。
3. 规则转发：不同关键词进入不同 Agent 或 workflow。

建议把对话状态放在 RabiRoute，而不是放在小爱桥接项目里。桥接项目只负责“收文本、播回复”。

### 7. 设备信息与状态

可做：

1. 记录音箱设备 ID、房间、名称。
2. 判断来自哪个音箱，从而推断 area，例如卧室/客厅。
3. 获取部分媒体状态，取决于 HA/MIoT/桥接项目。

限制：

1. 不要假设能拿到完整麦克风、唤醒、ASR、播放、米家控制状态。
2. 小爱作为入口可靠，作为全状态设备控制器不可靠。

## 拦截策略设计

RabiRoute 应该支持三种拦截模式。

### 模式 A：显式前缀拦截

最稳，第一版推荐。

触发例子：

```text
问 Rabi 今天安排
让 Rabi 打开电脑任务
Rabi 帮我查一下
进入 Rabi 模式
```

规则：

```json
{
  "name": "xiaoai_explicit_rabi",
  "input": "xiaoai",
  "match": {
    "prefixes": ["问 Rabi", "让 Rabi", "Rabi", "找 Rabi"]
  },
  "strip_prefix": true,
  "agent": "default_rabi",
  "reply": {
    "target": "xiaoai",
    "mode": "short_voice"
  }
}
```

优点：误触发低。
缺点：用户要说固定入口词。

### 模式 B：场景/设备命令拦截

适合智能家居命令。

触发例子：

```text
把客厅空调调到 26 度
打开电视
进入电影模式
我回来了
```

规则：

```json
{
  "name": "xiaoai_home_control",
  "input": "xiaoai",
  "match": {
    "intents": ["home_control"],
    "areas": ["客厅", "卧室"],
    "devices": ["空调", "电视", "灯"]
  },
  "handler": "tool",
  "tool": "device.control",
  "fallback": "pass_to_xiaoai"
}
```

优点：自然。
缺点：需要 RabiRoute 自己做意图识别和设备映射。

### 模式 C：上下文会话拦截

适合连续对话。

触发例子：

```text
用户：进入 Rabi 模式
小爱：好的
用户：刚刚那个项目继续跑
用户：把结果发到 QQ
用户：退出 Rabi 模式
```

规则：

```json
{
  "name": "xiaoai_rabi_session",
  "input": "xiaoai",
  "session": {
    "enter": ["进入 Rabi 模式"],
    "exit": ["退出 Rabi 模式", "不用了"],
    "ttl_seconds": 300
  },
  "agent": "default_rabi"
}
```

优点：体验最好。
缺点：需要会话状态和超时，第一版可以晚点做。

## RabiRoute 需要新增的模块

当前 RabiRoute 已有 `MessageAdapter`、`webhookAdapter`、`pipelines`、`agentAdapters`。小爱路线可以沿用这个模型。

### 1. XiaoAI Bridge

这是外部桥接层，不一定要写进 RabiRoute 主进程。它负责把小爱事件转成 RabiRoute webhook。

输入：

```text
小爱音箱 / xiaogpt / open-xiaoai 类项目 / 自定义桥
```

输出给 RabiRoute：

```http
POST http://127.0.0.1:8792/webhook
Content-Type: application/json

{
  "type": "xiaoai.transcript",
  "source": "xiaoai",
  "deviceId": "bedroom_xiaoai",
  "deviceName": "卧室小爱",
  "area": "bedroom",
  "text": "问 Rabi 今天有什么安排",
  "messageId": "xiaoai-20260606-0001",
  "time": 1780710000
}
```

第一版可以不新增专门 adapter，直接扩展现有 `webhookAdapter` 支持 `xiaoai.transcript`。

### 2. XiaoAI Reply Adapter

RabiRoute/Agent 的回复需要能回到音箱。

候选实现：

1. 调 XiaoAI Bridge 的 `/speak` HTTP 接口。
2. 调 Home Assistant 的小米音箱 `media_player` 或 TTS service。
3. 调 MIoT service 播报。
4. 兜底走本地 TTS 播放，不回小爱音箱。

建议接口：

```http
POST http://127.0.0.1:8798/v1/xiaoai/speak
Content-Type: application/json

{
  "deviceId": "bedroom_xiaoai",
  "text": "Rabi 说，今天有两个任务还没完成。",
  "interrupt": true
}
```

### 3. Route Rule Engine 扩展

RabiRoute 要支持按 `source=xiaoai`、`area`、`deviceId`、`prefix`、`intent` 选择路由。

建议把规范化事件变成：

```json
{
  "platform": "xiaoai",
  "source": "xiaoai",
  "adapter": "webhook",
  "routeKind": "voice_command",
  "sender": {
    "type": "speaker",
    "id": "bedroom_xiaoai",
    "name": "卧室小爱"
  },
  "area": "bedroom",
  "text": "今天电脑任务跑完了吗",
  "rawText": "问 Rabi 今天电脑任务跑完了吗"
}
```

### 4. Tool Gateway

RabiRoute 要向 Agent 暴露工具，但不要让 Agent 直接拿到小米账号、HA token、BroadLink 码。RabiRoute 应该做工具网关。

第一批工具：

```text
device.control
device.query_state
speaker.speak
speaker.set_volume
homeassistant.call_service
scene.activate
script.run
qq.send_draft
task.query
```

工具调用示例：

```json
{
  "tool": "device.control",
  "args": {
    "area": "living_room",
    "device": "air_conditioner",
    "action": "set_preset",
    "preset": "cool_26_auto"
  }
}
```

RabiRoute 内部再映射到：

```json
{
  "provider": "home_assistant",
  "service": "script.turn_on",
  "target": {
    "entity_id": "script.living_room_ac_cool_26"
  }
}
```

## 推荐第一版 MVP

第一版不要做“全部小爱 API”，先做一条闭环：

```text
小爱说话
  -> XiaoAI Bridge 拿到文本
    -> RabiRoute webhook
      -> prefix 规则命中“问 Rabi”
        -> Codex/Agent
          -> 生成短回复
            -> XiaoAI Reply Adapter 播报
```

### MVP 任务拆分

1. 选一个入口桥：
   - 优先试 `xiaogpt` 类不刷机路线。
   - 如果指定音箱正好是 open-xiaoai 支持型号，再把 open-xiaoai 作为实验路线。
2. RabiRoute 扩展 webhook：
   - 支持 `xiaoai.transcript`。
   - 保存到 `voice-transcripts.jsonl` 或统一 raw events。
   - 标记 `platform=xiaoai`、`deviceId`、`area`。
3. RabiRoute 增加显式前缀规则：
   - `问 Rabi`
   - `让 Rabi`
   - `Rabi`
4. Agent 输出限制：
   - 默认短回复。
   - 避免长 Markdown。
   - 需要长内容时提示“我已经整理到文件/QQ/任务窗口”。
5. 增加音箱回复通道：
   - 第一版可以桥接层 `/speak`。
   - 如果不可用，先用本地 TTS 播放作为兜底。
6. 加日志：
   - 原始文本。
   - 是否命中规则。
   - 投递到哪个 Agent。
   - 回复是否成功播报。

## 第二版：把小爱命令转成工具调用

第二版开始让 Agent 或规则触发工具。

```text
用户：小爱同学，问 Rabi 把客厅空调调到 26 度
RabiRoute：
  1. 命中 Rabi 前缀
  2. Agent 解析 home control intent
  3. Agent 调 tool: device.control
  4. RabiRoute Tool Gateway 调 HA script
  5. 小爱播报：已发送客厅空调制冷 26 度
```

需要新增：

1. `device-actions.json`：设备动作映射。
2. `HomeAssistantProvider`：调用 HA REST API。
3. `ToolGateway`：限制 Agent 可调用的工具和参数。
4. `ActionAuditLog`：记录所有外部动作。
5. 高风险动作审批：发 QQ、发邮件、写文档、开门锁等默认需要确认。

## 第三版：自然语言设备命令可选择拦截或放行

第三版再做“像小爱一样自然”的命令。

决策逻辑：

```text
收到小爱文本
  -> 是否处于 Rabi 模式？
      是：全部送 RabiRoute
      否：
        -> 是否显式前缀？
            是：送 RabiRoute
            否：
              -> 是否命中 RabiRoute home control 规则？
                  是：RabiRoute 执行
                  否：放行/不处理，让小爱自己处理
```

注意：多数非刷机桥接方式未必能真正“放行原始请求”。因此第一版设计上应采用“只处理命中的桥接事件”，不要承诺所有未命中请求还能原样回到小爱云。

## Agent 可见接口设计

Agent 不应该直接知道小爱、米家、BroadLink 的细节。RabiRoute 暴露给 Agent 的工具应该稳定。

### speaker.speak

```json
{
  "name": "speaker.speak",
  "description": "让指定房间或指定小爱音箱播报短文本。",
  "args": {
    "area": "bedroom",
    "text": "任务已经完成。",
    "interrupt": true
  }
}
```

### device.control

```json
{
  "name": "device.control",
  "description": "控制家里的设备或场景。",
  "args": {
    "area": "living_room",
    "device": "air_conditioner",
    "action": "set_preset",
    "preset": "cool_26_auto"
  }
}
```

### homeassistant.call_service

只给可信 Agent 或开发者模式开放。

```json
{
  "name": "homeassistant.call_service",
  "args": {
    "domain": "script",
    "service": "turn_on",
    "entity_id": "script.living_room_ac_cool_26"
  }
}
```

### xiaoai.raw

仅调试使用，不给普通 Agent 默认开放。

```json
{
  "name": "xiaoai.raw",
  "description": "调用小爱桥接层的原始能力，用于实验。",
  "args": {
    "deviceId": "bedroom_xiaoai",
    "method": "speak",
    "payload": {
      "text": "测试"
    }
  }
}
```

## 安全边界

1. 小米账号 token、HA token、BroadLink key 都留在 provider 层，不给 Agent。
2. Agent 只能调用白名单工具。
3. 外部动作必须进入审计日志。
4. 高风险动作需要确认，例如门锁、支付、群发消息、删除文件。
5. 音箱入口默认短时会话，避免家里其他人随口说话长期进入 Agent 模式。
6. 对红外设备只声明“已发送指令”，不要声明真实状态。

## 技术选型建议

### 第一推荐

```text
xiaogpt/自定义 XiaoAI Bridge
  -> RabiRoute webhook
    -> RabiRoute prefix/session rules
      -> Agent
        -> RabiRoute Tool Gateway
          -> Home Assistant
```

原因：不刷机，风险低，能验证语音入口闭环。

### 第二推荐

```text
Home Assistant Xiaomi Home / Xiaomi MIoT
  -> RabiRoute Tool Gateway
```

原因：适合设备控制和场景触发，不适合做完整小爱对话拦截。

### 实验路线

```text
open-xiaoai 类补丁音箱
  -> RabiRoute
```

只适合你明确有支持型号、愿意刷机、能接受项目停止维护风险时做实验。

## 最小实现清单

RabiRoute 仓库里建议新增/改动：

1. `src/adapters/webhookAdapter.ts`
   - 支持 `xiaoai.transcript`。
   - 允许 payload 带 `deviceId`、`deviceName`、`area`。
2. `src/adapters/xiaoaiReplyAdapter.ts`
   - 调桥接层 `/speak`。
3. `src/routing/xiaoaiRules.ts`
   - prefix/session/home-control 规则。
4. `src/tools/toolGateway.ts`
   - Agent 工具白名单和参数校验。
5. `src/tools/providers/homeAssistantProvider.ts`
   - 调 Home Assistant service。
6. `data/route/xiaoai/adapterConfig.json`
   - 小爱入口规则配置。
7. `data/device-actions.json`
   - 家居设备动作映射。
8. `docs/xiaoai-rabiroute-intercept-route.md`
   - 这份技术路线文档。

第一条可运行链路只需要做到：

```text
xiaoai.transcript webhook
  -> prefix 命中
    -> Agent
      -> speak reply
```

然后再逐步补工具调用和设备控制。

## 按 RabiRoute 现有设计具体接入

RabiRoute 当前设计理念是“多入口消息网关 + 消息分诊台 + 策略调度层”。这意味着小爱接入不应该做成一个独立的小爱机器人系统，也不应该把 `xiaogpt/open-xiaoai` 的逻辑搬进 RabiRoute 核心。正确接法是：小爱只作为一个新的输入来源，进入 RabiRoute 已有的事件、路由、模板、Agent adapter 和后续 Action Queue。

现有代码里已经有可以复用的骨架：

1. `src/adapters/webhookAdapter.ts`：已经能接收 HTTP webhook。
2. `src/history.ts`：已有 `VoiceTranscriptEventRecord` 和 `voice-transcripts.jsonl`。
3. `src/forwarding.ts`：已有 `voice_transcript` route kind。
4. `src/pipelines.ts`：已有 `voice_chat` pipeline preset。
5. `examples/data/route/voice-chat/adapterConfig.json`：已有 webhook + TTS 语音管道示例。
6. `personaConfig.json`：已有 `voice-chat` 配置，能把语音转写投给 Agent。

所以第一版小爱接入不需要新增 `xiaoai` message adapter。先复用 `webhook` adapter，把小爱桥接层输出规范化为 `voice_transcript`。

### 第一版最小接入

小爱桥接层向 RabiRoute 发送：

```http
POST http://127.0.0.1:8791/webhook
Content-Type: application/json

{
  "type": "voice_transcript",
  "source": "xiaoai",
  "id": "xiaoai-20260606-0001",
  "text": "问 Rabi 今天电脑上的任务跑完了吗",
  "time": 1780710000
}
```

这条 payload 当前已经能被 `webhookAdapter` 接住，因为它支持：

```text
type = voice_transcript
text/message/content
source
id/messageId
time
```

第一版需要做的不是改协议，而是新增一套小爱专用 route config：

```text
data/route/xiaoai/adapterConfig.json
data/roles/Rabi/personaConfig.json 里新增 configName = "xiaoai"
```

`adapterConfig.json` 建议：

```json
{
  "enabled": true,
  "pipelinePreset": "voice_chat",
  "pipeline": {
    "id": "xiaoai_voice",
    "inputAdapter": "webhook",
    "outputAdapter": "webhook",
    "outputPipeline": "xiaoai",
    "promptOutputMode": "voice_short",
    "ttsProvider": "",
    "ttsVoice": "",
    "ttsWorkerUrl": "",
    "ttsPlay": false,
    "preventFeedbackLoop": true,
    "replyToSource": true
  },
  "messageAdapters": ["webhook"],
  "gatewayPort": 8791,
  "webhookPort": 8791,
  "webhookPath": "/webhook",
  "codexThreadName": "RabiRoute XiaoAI",
  "agentAdapters": ["codex"],
  "dataDir": "./data/route/xiaoai",
  "configName": "xiaoai",
  "agentRoleId": "Rabi",
  "rolesDir": "./data/roles"
}
```

`personaConfig.json` 里新增规则：

```json
{
  "id": "rabi-xiaoai-explicit",
  "name": "XiaoAI explicit Rabi route",
  "enabled": true,
  "targetGroupId": "",
  "regex": "^(问\\s*Rabi|让\\s*Rabi|Rabi|找\\s*Rabi)",
  "template": "[RabiRoute XiaoAI]\n路由类型：{routeKind}\n来源：{voiceSource}\n时间：{time}\n输入：{message}\n\n这是来自小爱音箱桥接层的语音文本。请把它当作家中语音入口请求处理。默认生成短回复；如果需要调用家居、脚本或外部系统，只生成明确的工具调用建议或待审动作，不要假设已经执行。\n\n语音日志：{voiceTranscriptLogPath}\n角色文件：{agentRolePath}",
  "routeKinds": ["voice_transcript"]
}
```

这个版本的拦截边界是“显式前缀拦截”：只有用户说“问 Rabi / 让 Rabi / Rabi / 找 Rabi”才进 Agent。普通“小爱打开空调”仍交给小爱自己。

### 为什么第一版不新增 route kind

可以新增 `xiaoai_transcript`，但不建议第一版这么做。原因：

1. RabiRoute 已经有 `voice_transcript`，小爱本质也是语音转写入口。
2. `forwarding.ts`、`config.ts`、`history.ts`、文档和 WebUI 都已经知道 `voice_transcript`。
3. 少改类型枚举，风险更低。
4. 可以用 `source = "xiaoai"` 区分 FenneNote、麦克风、小爱音箱。

等后续需要小爱专属字段时，再把 `VoiceTranscriptEventRecord` 扩展为：

```ts
type VoiceTranscriptEventRecord = {
  time: number;
  rawMessage: string;
  messageId?: number | string;
  senderName?: string;
  source?: string;
  sourceDeviceId?: string;
  sourceDeviceName?: string;
  sourceArea?: string;
  sessionId?: string;
  startedAt?: string;
  endedAt?: string;
  durationSeconds?: number;
  peak?: number;
};
```

### 第二版：增强 webhook payload

当前 `webhookAdapter` 会丢掉 `deviceId`、`deviceName`、`area`、`sessionId` 这类字段。第二版要扩展 `WebhookPayload` 和 `VoiceTranscriptEventRecord`，让小爱入口更像一个正式 platform adapter。

建议 payload：

```json
{
  "type": "voice_transcript",
  "source": "xiaoai",
  "sourceDeviceId": "bedroom_xiaoai",
  "sourceDeviceName": "卧室小爱",
  "sourceArea": "bedroom",
  "sessionId": "xiaoai-session-001",
  "text": "问 Rabi 电脑任务跑完了吗",
  "messageId": "xiaoai-20260606-0001",
  "time": 1780710000
}
```

需要改动：

```text
src/adapters/webhookAdapter.ts
  WebhookPayload 增加 sourceDeviceId/sourceDeviceName/sourceArea/sessionId
  recordFromPayload 写入 VoiceTranscriptEventRecord

src/history.ts
  VoiceTranscriptEventRecord 增加这些可选字段

src/forwarding.ts
  commonTemplateValues 增加模板变量：
    {voiceSourceDeviceId}
    {voiceSourceDeviceName}
    {voiceSourceArea}
    {voiceSessionId}
```

这样规则就能写：

```json
{
  "regex": "^(问\\s*Rabi|让\\s*Rabi|Rabi)",
  "routeKinds": ["voice_transcript"]
}
```

模板里能知道：

```text
来源设备：{voiceSourceDeviceName}
来源区域：{voiceSourceArea}
会话：{voiceSessionId}
```

### 第三版：小爱回复通道

当前 RabiRoute 的 `voice_chat` pipeline 主要面向本地 TTS。小爱接入需要新增一个“输出到小爱桥”的能力，但按 RabiRoute 设计理念，它应该是 output/reply adapter，不应混进 input adapter。

推荐接口：

```text
Agent 输出
  -> RabiRoute output adapter
    -> XiaoAI Bridge /speak
      -> 小爱音箱播报
```

桥接层接口：

```http
POST http://127.0.0.1:8798/v1/xiaoai/speak
Content-Type: application/json

{
  "deviceId": "bedroom_xiaoai",
  "text": "Rabi 说，任务还在跑，最后一条日志是构建完成 80%。",
  "interrupt": true,
  "requestId": "xiaoai-20260606-0001"
}
```

RabiRoute 里先不需要完整实现 output adapter，也可以先让 Agent 输出结构化 JSON，由人工或后续脚本消费：

```json
{
  "visibleText": "任务还在跑。",
  "ttsText": "任务还在跑，最后一条日志是构建完成百分之八十。",
  "replyTarget": {
    "type": "xiaoai",
    "deviceId": "bedroom_xiaoai"
  }
}
```

等输出管线成熟后，再新增：

```text
src/outputAdapters/xiaoaiOutputAdapter.ts
```

但这应该排在“输入闭环验证”之后。

### 第四版：Tool Gateway

按 RabiRoute 理念，工具调用不应该让 Agent 直接拿外部系统 token。Agent 只向 RabiRoute 提出结构化动作，RabiRoute 决定是自动执行、生成 draft，还是要求审批。

新增边界：

```text
Agent
  -> tool request
    -> RabiRoute Tool Gateway
      -> Provider
        -> Home Assistant / 米家 / BroadLink / ESPHome / QQ / 文件
```

第一批 provider：

```text
HomeAssistantProvider
XiaoAIReplyProvider
LocalScriptProvider
DraftActionProvider
```

第一批工具：

```text
speaker.speak
device.control
scene.activate
homeassistant.call_service
script.run
qq.create_draft
```

这里要特别遵守 RabiRoute 的 Action Queue / Approval 红线：

1. 播报短回复可以自动。
2. 查询状态可以自动。
3. 红外控制可以先允许白名单动作自动，例如空调/电视。
4. 发 QQ、写文档、修改文件、门锁/支付/群发必须先进 draft。

### 与 RabiRoute 分层的对应关系

```text
小爱音箱 / xiaogpt
  = Platform Adapter 外部桥

RabiRoute webhookAdapter
  = Platform Adapter 接收端

voice-transcripts.jsonl
  = Event Store

personaConfig notificationRules
  = Router / Policy Engine

template
  = Prompt / Context Template

codex
  = Agent Adapter / Handler Registry

XiaoAI speak / HA service / device control
  = Action Queue / Reply Route / External System
```

这个映射很重要：小爱接入不能绕过 `personaConfig` 直接调 Agent，也不能让 Agent 直接调小米账号或 HA token。

### 推荐落地顺序

1. 不改代码，先用现有 `/webhook` 测通小爱文本进入 `voice_transcript`。
2. 新增 `data/route/xiaoai/adapterConfig.json` 和 `personaConfig` 的 `xiaoai` config。
3. 用 `curl` 模拟小爱 payload，确认命中 `voice_transcript` 规则并投递到 Codex 固定线程。
4. 接一个最小 XiaoAI Bridge，让它把小爱识别文本 POST 到 RabiRoute。
5. 扩展 payload 字段，保存 `deviceId/area/sessionId`。
6. 增加小爱回复通道 `/speak`，先手动/脚本消费 Agent 的 `ttsText`。
7. 再做 Tool Gateway 和 Home Assistant provider。
8. 最后做自然语言家居命令拦截和 Rabi 会话模式。

### 测试用 curl

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri "http://127.0.0.1:8791/webhook" `
  -ContentType "application/json" `
  -Body '{
    "type": "voice_transcript",
    "source": "xiaoai",
    "id": "xiaoai-smoke-001",
    "text": "问 Rabi 今天电脑任务跑完了吗",
    "time": 1780710000
  }'
```

预期结果：

1. HTTP 204。
2. `data/route/xiaoai/voice-transcripts.jsonl` 追加记录。
3. `data/route/xiaoai/codex-notifications.jsonl` 追加投递记录。
4. Codex 固定线程 `RabiRoute XiaoAI` 收到一条语音入口提醒。

如果这四个点都成立，说明小爱入口已经按 RabiRoute 的设计理念接入成功。
