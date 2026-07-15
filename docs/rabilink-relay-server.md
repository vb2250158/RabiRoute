# RabiLink Relay 公网中继

这个服务用于把 Rokid 云侧插件、便携设备和电脑端 RabiRoute/RabiLink 消息端接起来。输入与输出是两条独立队列。当前 AIUI 在应用层直接调用 Relay；按 Rokid 官方机制，眼镜网络包会通过蓝牙透明代理到手机 App，所以传输层使用了手机网络，但手机不拥有 Agent、账本或配置。AIUI 的连接对话采用 record-first：电脑端 worker 领取观察后先写入统一会话账本并完成上行，不把单句转写直接交给 Codex。Codex 在线程空闲、触摸板引导或周期反思时读取账本，再按需要独立下行。

链路：

```text
上行：Rokid 眼镜 / 灵珠智能体
  -> RabiLink Relay 公网 HTTPS 输入队列
  -> 电脑端 RabiLink worker
  -> rabilink-conversation.jsonl 统一会话账本
  -> 上行项立即完成
  -> 空闲审阅 / 触摸板 turn steer / 周期反思

下行：Codex / 定时器 / 规划器
  -> RabiRoute 输出安全门
  -> Relay /worker/messages 下行队列
  -> 同一统一会话账本记录 agent_to_user
  -> 眼镜按 cursor 持续消费
  -> AIUI 原生 TTS
```

## 启动

```powershell
cd C:\Path\To\RabiRoute
$env:RABILINK_RELAY_PORT="8788"
node scripts/rabilink-relay-server.mjs
```

启动后先打开服务器 WebGUI：

```text
https://你的域名/manage
```

首次进入时注册一个服务器账号，然后创建 RabiLink 应用。每个应用会生成独立 `rbl_...` token；控制台卡片默认显示 token 预览，但登录后可以随时复制完整 token。Rokid/灵珠插件和电脑端 RabiLink worker 都使用同一个应用 token，Relay 会按应用隔离 task 和下行消息队列。

电脑端在 RibiWebGUI“Rabi 实例”中填写 Relay 地址、应用 token 和唯一的本机 PC 标识，然后打开全局“连接服务器”开关。该开关由 `data/Config.json` 的 `rabiLinkRelay.enabled` 持久化；开启后 Manager 会立即登记 PC 并常驻代理远程 WebGUI，不需要先启动某条 RabiLink 路由。路由中的 `rabilink` 消息端决定 AIUI observation 写入哪个角色账本、由哪个固定 Agent 线程审阅；旧兼容消息仍按该路由直接转发。关闭全局开关会让整台 PC 停止连接 Relay，但不会删除 token 或路由配置。

同一个应用 token 可以连接多台 PC。每台 PC 必须拥有独立的 `rabiGuid` 和 `deviceId`；不要把一台电脑的 `data/Config.json` 原样复制到另一台。服务器管理页的 PC 列表目前通过“刷新”按钮重新读取，不会因新 PC 上线自动重载整页。

旧公共 token 不再参与 RabiLink 鉴权。Rokid/灵珠插件、AIUI、手机端和电脑端 worker 都必须使用对应应用 token；服务器会按应用隔离输入项、兼容 task、worker 领取、WebGUI 请求和下行消息队列，避免输入绕过应用绑定并被多台 PC 广播领取。

同一个应用 token 也用于 AIUI 眼镜状态辅助链路。手机端 RabiLink 可以提交真实 CXR 设备状态：

```http
POST /api/rabilink/mobile/device-status
X-RabiLink-Token: <应用 token>
Content-Type: application/json

{
  "batteryLevel": 89,
  "charging": false,
  "observedAt": "2026-07-12T09:05:14.804Z"
}
```

Relay 按应用把状态存入独立文件，并在 `GET /api/rabilink/mobile/state` 的 `deviceStatus` 字段返回 `batteryLevel`、`charging`、`receivedAt`、`stale` 和 `staleAfterMs`。默认 3 分钟未收到新状态即标记 `stale=true`；可用 `RABILINK_RELAY_MOBILE_DEVICE_STATUS_STALE_MS` 在 1-15 分钟内调整。该接口只接收 0-100 的电量和布尔充电状态，不保存 CXR 授权或 Relay token。

每个应用必须在控制台选择一台要通讯的 Rabi PC。眼镜提交任务时，如果这个应用没有选择 PC、选中的 PC 不存在或已经离线，服务器会直接返回错误，不会创建无目标任务。

绑定电脑端 RabiLink worker 后，服务器也可以通过同一条 Relay 通道访问这台 PC 的 RibiWebGUI。服务器路径中的 RabiGUID 根路径等同于 PC 本机 manager 根路径：

```text
https://你的域名/manage/<账号>/<RabiGUID>/#/routes
= http://127.0.0.1:8790/#/routes
```

这里的 `<RabiGUID>` 来自 PC 端 `data/Config.json` 的 `rabiGuid`，不是显示名。浏览器必须先登录 `/manage` 中对应账号；每个浏览器只保留一个当前登录账号。这个入口会把 WebGUI 的 `GET` / `POST` / `PATCH` 等请求排队给对应 PC worker，由 PC worker 在本机访问 `http://127.0.0.1:8790`，因此可以在服务器页面里修改这台 PC 的 Rabi 配置。服务器不会直接连入用户电脑。

旧路径 `/manage/<账号>/<RabiGUID>/webgui/...` 保留兼容，但推荐使用上面的根路径。

公网部署时建议放到 HTTPS 反代后面，例如：

```text
https://你的域名/rokid/rabilink
```

Rokid 插件 URL 填：

```text
https://你的域名/rokid/rabilink?token=应用 token
```

如果 Rokid 插件支持请求头，更推荐：

```text
Authorization: Bearer 应用 token
```

或：

```text
X-RabiLink-Token: 应用 token
```

## Rokid 入站接口

### 同步接口

```http
POST /rokid/rabilink
Content-Type: application/json
Authorization: Bearer <token>

{
  "text": "帮我转发给 Codex：测试 RabiLink skill 转发链路。"
}
```

兼容字段：

- `text`
- `message`
- `query`
- `prompt`
- `input`
- `question`
- `content`
- `data.text`
- `messages` 最后一条的 `content`

默认会等待电脑端 RabiLink worker 回填结果，最多等 `RABILINK_RELAY_REPLY_TIMEOUT_MS`，默认 60 秒。

### AIUI 连接对话：输入事件 + 持续下行流

当前 RabiLink AIUI 不使用任务查询作为产品协议。连接对话的最终 ASR 文本发布为只记录的 observation：

```http
POST /rokid/rabilink/input
Content-Type: application/json
Authorization: Bearer <token>

{
  "text": "帮我看看今天的安排。",
  "type": "rabilink.observation",
  "deliveryMode": "observe",
  "source": "rabilink-aiui",
  "clientMessageId": "asr-1752384000000-1",
  "sessionId": "conversation-1",
  "sequence": 1,
  "capturedAt": 1752384000000
}
```

worker 收到后执行三件事：

1. 以稳定 `clientMessageId` 去重，将文本追加到 `rabilink-conversation.jsonl`，标记 `direction=user_to_agent`、`requiresReview=true`。
2. 不调用普通消息转发，不把这句话直接投递 Codex。
3. 幂等完成 Relay 上行项，并唤醒审阅调度器。

连接对话单击触摸板使用同一输入队列发送控制事件：

```json
{
  "text": "用户在眼镜连接会话模式单击触摸板，要求现在审阅会话记录。",
  "type": "rabilink.review_request",
  "deliveryMode": "observe",
  "reviewRequested": true,
  "clientMessageId": "review-1752384000500",
  "sessionId": "conversation-1",
  "capturedAt": 1752384000500
}
```

它会写入同一账本的 `direction=control`。固定 Codex 线程空闲时开启新 turn；已有 turn 正在执行时使用 `turn/steer` 引导当前轮次。没有手动事件时，新增 observation 在稳定窗口后等待线程空闲审阅；没有新 observation 时，可按 `rabilinkReflectionIntervalMinutes` 做低频连续反思。待审阅范围由 `rabilink-conversations/index.json`、归档分卷和当前 `rabilink-conversation.jsonl` 共同组成，因此 Codex 离线期间发生机械分卷也不会跳过尚未审阅的 observation。

Relay 返回 `202 Accepted`。`eventId` 只用于日志追踪；响应不包含供眼镜维护的 `taskId` 或完成态：

```json
{
  "code": 0,
  "ok": true,
  "status": "accepted",
  "eventId": "rabilink-relay-...",
  "nextCursor": "out-000000010"
}
```

首次连接从空 cursor 开始，消费 Relay 保留期内尚在 outbox 的消息：

```http
GET /rokid/rabilink/messages?stream=1&after=&waitMs=25000
Authorization: Bearer <token>
```

随后一直按保存的 cursor 消费同一个应用级下行流：

```http
GET /rokid/rabilink/messages?stream=1&after=<lastOutboxMessageId>&waitMs=25000
Authorization: Bearer <token>
```

`stream=1` 表示这是常驻消息端。空闲超时返回 `ok=true`、`status=idle`、`shouldContinue=true`，页面继续下一轮；普通 Agent 回复和主动消息都按 `seq` 进入同一队列。这个流不因某个内部 worker task 完成而关闭。Relay 的下行 outbox 默认保留 48 小时，独立于十分钟 task 生命周期，因此 Codex 可以在眼镜页面尚未打开时先投递。AIUI 收到一批消息后会先把待播报项按 token 写入本地持久队列，再推进 cursor；页面隐藏、切到配置助手或 TTS 中断后，回到连接对话仍按原顺序继续，只有成功播报的消息才会移除。

主动生产者可以直接追加一条没有前置任务的消息：

```http
POST /worker/messages
Content-Type: application/json
X-RabiLink-Token: <app-token>

{
  "text": "该休息一下了。",
  "source": "RabiRoute scheduler",
  "deliveryId": "由生产者生成并在重试时保持不变",
  "proactive": true,
  "final": true
}
```

record-first 审阅结果和其他主动消息不带 `taskId`，使用 `proactive=true`。旧的直接消息兼容路径仍可带原输入 `taskId` 和 `proactive=false`；`taskId` 只提供关联，不会让下行等待上行任务。`deliveryId` 是幂等键：如果服务器已经创建队列项但响应丢失，生产者可用同一个值重试，Relay 会返回原消息而不会再次排队。

RabiRoute 内部更推荐复用动作安全门：向 `/api/agent/replies` 发送 `routeProfileId`、`targetType=rabilink`、`proactive=true`、`source` 和 `text`。通过路由输出策略后，RabiRoute 才会调用 `/worker/messages`。这样定时器、计划器和其他 Agent 不需要绕过现有审计边界。

### 手机、手表和其他便携端

通用便携端使用与 AIUI 相同的 record-first 和下行 outbox，只增加设备身份与展示提示：

```http
POST /api/rabilink/devices/input
X-RabiLink-Token: <app-token>
Content-Type: application/json

{
  "text": "回家后提醒我拿快递",
  "sourceDeviceId": "watch-user-1",
  "sourceDeviceKind": "watch",
  "transport": "wear-data-layer",
  "clientMessageId": "watch-msg-001",
  "capturedAt": 1784000000000
}
```

该接口默认补成 `rabilink.observation` + `deliveryMode=observe`。PC worker 领取到的 task 会保留 `sourceDeviceId`、`sourceDeviceName`、`sourceDeviceKind` 和 `transport`，并写入统一会话账本。

设备读取自己的下行视图：

```http
GET /api/rabilink/devices/messages?deviceId=watch-user-1&deviceKind=watch&after=<cursor>&stream=1
X-RabiLink-Token: <app-token>
```

通用接口必须带 `deviceId` 或 `deviceKind`。`/rokid/rabilink/messages` 保持兼容，并隐式使用 `deviceKind=glasses`。生产者可以在 `/worker/messages` 或 `/api/agent/replies` 增加：

```json
{
  "targetDeviceIds": ["watch-user-1"],
  "targetDeviceKinds": ["watch"],
  "presentation": ["notification", "haptic"],
  "priority": "urgent"
}
```

- 目标 ID 与类别按“或”匹配；两者都为空表示应用内广播。
- `presentation` 支持 `text`、`tts`、`notification`、`haptic`；终端根据权限和前后台状态决定实际表现。
- `priority` 支持 `quiet`、`normal`、`urgent`。
- 每个终端独立保存 cursor。即使新消息只发给其他设备，本终端返回的 `nextCursor` 也会越过它，避免重复扫描。
- 同一个 `deliveryId` 不能用不同正文、主动状态、目标或展示提示重试；否则返回 `409`。
- AIUI 直连和手机代收是同一眼镜身份的两种消费模式，不能同时开启，否则可能重复展示或播报。

完整职责、Android 生命周期和 Wear OS 选型见 [RabiLink 手机边缘通讯枢纽](rabilink-phone-edge-hub.md)。

眼镜端规则：

1. 连接对话处于前台且 token 有效时，持续消费全局消息流，不等待某个“当前任务”。配置助手或页面隐藏期间不推进 cursor，已排队消息会在连接对话恢复后继续消费。
2. 每条新消息立即显示，并按顺序加入原生 TTS 队列。
3. TTS 前释放 ASR；当前 TTS 结束后再恢复 ASR。
4. 每批处理后保存 `nextCursor`；断线重连从保存的 cursor 继续。
5. `proactive=true` 只表示主动来源，不改变显示、排序或播报规则。
6. 眼镜单击触摸板只发审阅控制事件，不暂停 ASR；滑动才负责切换连接对话与配置助手。

固定 Codex 线程的审阅与反思由 Route Variables 控制，和 Codex/Rabi 的主动下行能力相互独立：

| Route Variable | 默认值 | 说明 |
| --- | --- | --- |
| `rabilinkAutoReview` | `true` | 有新 observation 时，在线程空闲后自动发起审阅。关闭后仍可用触摸板手动审阅，也不禁止主动下行。 |
| `rabilinkContinuousReflection` | 跟随 `rabilinkAutoReview` | 没有新 observation 时是否做低频用户意图反思；可单独打开或关闭。 |
| `rabilinkReviewIntervalMs` | `5000` | PC 审阅调度器检查间隔。 |
| `rabilinkReviewSettleMs` | `4000` | 最后一段 observation 后的稳定等待时间。 |
| `rabilinkReflectionIntervalMinutes` | `30` | 连续反思最小间隔，范围 1 分钟到 24 小时。反思可以静默完成，不强制下行。 |
| `rabilinkConversationSplitAfterHours` | `6` | 无活动达到该时长后，下一次写入前机械切分当前 JSONL。跨本地日期也会切分。 |

`rabilinkAutoReview=false` 只关闭“新 observation 自动唤醒 Codex”；它不会关闭 `/api/agent/replies`。只要 Route 的 RabiLink 输出策略允许文本，Codex、定时器或规划器仍可随时提交 `targetType=rabilink, proactive=true`。发送动作不要求眼镜当时正在录音或停留在连接对话；Relay 先持久排队，眼镜恢复连接对话后按 cursor 顺序消费。

### 旧任务接口（仅兼容和调试）

旧版 Rokid 插件仍可用任务接口反复查询结果，但 RabiLink AIUI 的`连接对话`不得使用它作为页面状态机：

```http
POST /rokid/rabilink/tasks
Content-Type: application/json
Authorization: Bearer <token>

{
  "text": "帮我转发给 Codex：测试 RabiLink 异步轮询链路。"
}
```

返回 `taskId`：

```json
{
  "code": 0,
  "ok": true,
  "status": "pending",
  "taskId": "rabilink-relay-...",
  "text": "已收到，正在转交电脑端 RabiLink 和 Codex 处理。请稍后查询结果。"
}
```

随后 Rokid 智能体可以调用旧的最终状态接口：

```http
GET /rokid/rabilink/tasks/<taskId>
Authorization: Bearer <token>
```

当前 worker 在 RabiRoute 接受输入后就把任务标记为 `done`。因此这个状态只表示“输入已转交”，不表示 Codex 已回答；不得把任务状态中的 `text`/`answer` 当成用户回复。真正的普通回复和主动消息都从全局下行队列读取。

旧插件如果需要 Codex 分多次回复，可以使用全局下行消息列表。该说明只用于兼容已有工具；新 AIUI 使用上一节的 `/input` 和 `stream=1`：

```http
GET /rokid/rabilink/messages?after=<lastOutboxMessageId>
Authorization: Bearer <token>
```

第一次查询使用 `submitRabiLinkTask` 返回的 `cursor` / `nextCursor` 作为 `after`。如果本次返回了 `nextCursor`，下一次继续把它作为 `after`。服务器会长轮询等待新消息；内部输入任务通常在 RabiRoute 接收后很快结束，但全局下行流继续存在。眼镜端应持续拉取并逐条播报，不用某个 task 的结束态关闭常驻消息端。

返回示例：

```json
{
  "code": 0,
  "ok": true,
  "status": "messages",
  "done": false,
  "shouldContinue": true,
  "nextCursor": "out-000000002",
  "messages": [
    {
      "id": "out-000000001",
      "seq": 1,
      "taskId": "rabilink-relay-...",
      "taskMessageId": "msg-000001",
      "text": "第一句回复。",
      "final": false
    },
    {
      "id": "out-000000002",
      "seq": 2,
      "taskId": "rabilink-relay-...",
      "taskMessageId": "msg-000002",
      "text": "第二句回复。",
      "final": false
    }
  ]
}
```

旧插件兼容策略（不要用于 AIUI 连接对话）：

```text
1. 调用 submitRabiLinkTask 提交用户原话，保存返回的 cursor / nextCursor。
2. 调用 getRabiLinkMessages(after=cursor) 拉取全局下行消息；这个接口不需要 taskId。
3. messages 里有几条就按顺序复述几条，拉出来的都要显示；拉到一句说一句，不要攒到最后。
4. 每次处理完 messages 后保存 nextCursor，下次作为 after。
5. 不要设置 3 次之类的调用次数限制。只要还在对话，就继续用 nextCursor 拉取。
6. 如果 messages 为空但 shouldContinue=true，说明电脑端仍在处理，继续等待下一轮长轮询。
7. 如果长轮询超时仍没有拿到消息，接口会返回 `status=timeout` / `ok=false`；这不是正常对话分支，应按 Rabi/Codex 回复未回传的异常处理。
8. 只有当 Rabi/Codex 侧已经返回结束、电脑端 worker 完成 finish，并且 messages 为空且 shouldContinue=false 时，才结束本轮。
9. 不要把 getRabiLinkTaskResult 的 text/reply/answer/content 当成用户回复复述，避免重复。
```

按 `taskId` 查询单个任务的消息流仍然保留，主要用于调试或只关心单个任务的场景。眼镜端常驻播报应优先使用全局 `getRabiLinkMessages(after)`。

按 `taskId` 查询单个任务的消息流：

```http
GET /rokid/rabilink/tasks/<taskId>/messages?after=<lastMessageId>
Authorization: Bearer <token>
```

第一次查询不带 `after`。当没有新消息且任务未结束时，服务器默认最多等待 60 秒；有新消息、任务结束或等待超时后返回。这个接口主要用于排查单个 task，眼镜正式播报不要依赖它作为主循环。

可选参数：

- `after`：已经读过的最后一条消息 ID。
- `waitMs`：本次长轮询最长等待时间，范围 0-60000 毫秒。缺省使用服务端 `RABILINK_RELAY_MESSAGE_WAIT_MS`，当前默认 60000。

返回示例：

```json
{
  "code": 0,
  "ok": true,
  "status": "streaming",
  "taskId": "rabilink-relay-...",
  "done": false,
  "shouldContinue": true,
  "nextCursor": "msg-000002",
  "messages": [
    {
      "id": "msg-000001",
      "seq": 1,
      "text": "第一句回复。",
      "final": false
    },
    {
      "id": "msg-000002",
      "seq": 2,
      "text": "第二句回复。",
      "final": false
    }
  ]
}
```

按任务调试策略：

```text
1. 如果 messages 不为空，按顺序立刻转述给用户。
2. 保存 nextCursor。
3. 如果 shouldContinue=true，稍后继续调用本接口，并把 nextCursor 作为 after。由于接口本身会等待，智能体不要做高频空轮询。
4. 如果 shouldContinue=false，说明这个 task 的调试视角已经结束；正式播报仍以全局 `getRabiLinkMessages(after)` 为准。
```

## 电脑端 RabiLink worker 取任务

```http
GET /worker/tasks?limit=1&deviceId=rabilink-pc
Authorization: Bearer <token>
```

返回：

```json
{
  "code": 0,
  "ok": true,
  "tasks": [
    {
      "id": "rabilink-relay-...",
      "text": "用户原话",
      "normalizedText": "用户原话"
    }
  ]
}
```

电脑端 RabiLink worker 拿到任务后，会在本机内部调用 RabiRoute `rabilink` 消息端。局域网脚本或手工调试仍可直接 POST 到本地 `/rabilink`：

```http
POST http://电脑IP:8794/rabilink
Content-Type: application/json

{
  "type": "voice_transcript",
  "source": "rokid-relay",
  "sender": "Rokid RabiLink",
  "text": "用户原话",
  "routeId": "RabiLink"
}
```

## 电脑端 worker 转发本机 WebGUI

服务器上的远程 WebGUI 入口会创建 WebGUI 请求，电脑端 worker 通过长轮询领取：

```http
GET /worker/webgui-requests?limit=1&deviceId=<RabiPC>&deviceGuid=<RabiGUID>
Authorization: Bearer <token>
```

worker 会在本机访问 `RABILINK_RELAY_WEBGUI_URL`，默认是 `GATEWAY_MANAGER_URL`，通常即：

```text
http://127.0.0.1:8790
```

随后把本机 WebGUI 响应回填：

```http
POST /worker/webgui-requests/<requestId>/response
Content-Type: application/json
Authorization: Bearer <token>

{
  "ok": true,
  "statusCode": 200,
  "headers": {
    "content-type": "text/html; charset=utf-8"
  },
  "bodyBase64": "..."
}
```

`bodyBase64` 用于保留 HTML、JS、图片和 JSON 等响应体。服务器会对 HTML/JS/CSS 中常见的 `/api`、`/manager-config` 和 `/assets` 路径做前缀改写，让远程 WebGUI 的保存配置、读取状态和静态资源请求仍然回到同一台 PC Rabi。

## 电脑端 worker 完成输入与投递下行

当前 RabiRoute worker 遇到 `rabilink.observation` 时，先把文本写入统一会话账本，再调用 `/worker/tasks/<taskId>/finish` 确认“观察已本地记录”。它不直接投递 Codex、不在这个请求里等待 Codex，也不把回复塞回上行任务。未带 record-only 标记的旧输入仍按兼容消息路径转发。

统一会话文件位于当前 RabiLink 人格数据目录：

```text
rabilink-conversation.jsonl
rabilink-conversation-review-state.json
rabilink-conversations/
  index.json
  YYYY-MM-DD.jsonl
  YYYY-MM-DD-02.jsonl
```

用户观察、Agent 成功排队的下行和触摸板控制事件都按时间写入当前 JSONL。跨本地日期或空档达到 `rabilinkConversationSplitAfterHours`（默认 6 小时）时，旧文件机械归档；`index.json` 只保存文件名、起止时间和条数，不生成摘要。索引使用临时文件原子替换；读取完整时间线时也会扫描日期 JSONL，因此进程即使在移动分卷后、登记索引前退出，未登记分卷仍会被恢复并参与去重与待审阅计算。

普通回复与主动消息统一写入应用级下行队列：

```http
POST /worker/messages
Content-Type: application/json
X-RabiLink-Token: <app-token>

{
  "text": "Codex 的主动帮助文本",
  "taskId": "record-first 主动消息省略；仅旧直接回复可填写",
  "deliveryId": "每次逻辑投递的稳定 UUID",
  "proactive": true,
  "final": true
}
```

生产者遇到超时、断连或响应丢失时，必须保持同一个 `deliveryId` 重试。Relay 会返回第一次创建的消息，不会让眼镜重复显示或重复 TTS。主动投递省略 `taskId` 并设为 `proactive=true`；它不需要先存在一条眼镜输入任务。RabiRoute 通过输出门成功排队后，以同一 `deliveryId` 把消息写回统一账本的 `direction=agent_to_user`。

### 兼容接口（仅旧插件与调试）

### 兼容：一次性回填最终结果

```http
POST /worker/tasks/<taskId>/result
Content-Type: application/json
Authorization: Bearer <token>

{
  "ok": true,
  "replyText": "Codex 的回复文本"
}
```

这个接口会追加一条最终消息，并把任务标记为结束。当前 RabiRoute worker 不使用它；新客户端应读取全局 `/rokid/rabilink/messages?stream=1` 下行流。

### 消息流：追加一条或多条回复

旧 worker 每拿到 Codex 一句回复时可以调用：

```http
POST /worker/tasks/<taskId>/messages
Content-Type: application/json
Authorization: Bearer <token>

{
  "text": "第一句 Codex 回复。"
}
```

也可以批量追加：

```json
{
  "messages": [
    {
      "text": "第一句 Codex 回复。"
    },
    {
      "text": "第二句 Codex 回复。"
    }
  ]
}
```

旧任务结束时调用：

```http
POST /worker/tasks/<taskId>/finish
Content-Type: application/json
Authorization: Bearer <token>

{
  "ok": true,
  "text": "这轮处理完了。"
}
```

如果不需要额外结束语，也可以传空对象：

```json
{
  "ok": true
}
```

失败时：

```json
{
  "ok": false,
  "error": "RabiLink worker 转发到 RabiRoute 失败"
}
```

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `RABILINK_RELAY_APP_TOKEN` | 空 | 电脑端 RabiLink worker 使用的应用 token；从 `/manage/<账号>` 对应应用卡片复制。Relay server 自身不读取这个变量。 |
| `RABILINK_RELAY_TOKEN` | 空 | 已废弃；不要再用于 Relay server 或 PC worker。 |
| `RABILINK_RELAY_PORT` / `PORT` | `8788` | 监听端口 |
| `RABILINK_RELAY_HOST` / `HOST` | `0.0.0.0` | 监听地址 |
| `RABILINK_RELAY_REPLY_TIMEOUT_MS` | `60000` | Rokid 请求最多等待 worker 回填多久 |
| `RABILINK_RELAY_MESSAGE_WAIT_MS` | `60000` | 眼镜按 taskId 拉取消息列表的长轮询等待时间 |
| `RABILINK_RELAY_OUTBOX_WAIT_MS` | `60000` | 全局下行消息列表长轮询等待时间；空闲超时返回 `status=idle, shouldContinue=true`，眼镜继续下一轮，不作为异常。 |
| `RABILINK_RELAY_OUTBOX_TTL_MS` | `172800000` | 全局下行 outbox 保留时间，默认 48 小时，可在 1 小时到 30 天之间调整；不跟随 task TTL 清理。 |
| `RABILINK_RELAY_WORKER_TASK_WAIT_MS` | `60000` | 电脑端 worker 领取任务的长轮询等待时间 |
| `RABILINK_RELAY_WEBGUI_REQUEST_WAIT_MS` | `30000` | 服务器等待电脑端 worker 回填 WebGUI 响应的时间 |
| `RABILINK_RELAY_WEBGUI_BODY_MAX_BYTES` | `10485760` | 单次远程 WebGUI 请求体大小上限 |
| `RABILINK_RELAY_TASK_TTL_MS` | `600000` | 任务保留时间 |
| `RABILINK_RELAY_LEASE_MS` | `180000` | worker 取到输入后的租约时间；给“本机已接收但远端完成响应丢失”的重试留出余量 |
| `RABILINK_RELAY_DATA_DIR` | `data/rabilink-relay` | 事件日志和服务器 WebGUI 账号/应用数据目录 |
| `RABILINK_RELAY_ACCOUNT_LOG_MAX_ROWS` | `300` | 每个管理账号保留的控制台脱敏日志行数 |
| `RABILINK_RELAY_APP_STORE_FILE` | `<dataDir>/apps.json` | 账号、密码哈希、应用和 token 存储文件 |

Relay 运行期 task 和全局下行 outbox 会写入 `<dataDir>/runtime-state.json`。这个文件用于多 relay 进程或反代分流时共享任务队列，避免 worker 完成输入时命中另一个进程后出现 `Task not found`，也保证 `getRabiLinkMessages` 能从共享 outbox 取到其他 relay 进程写入的回复。outbox 同时保存 `deliveryId`，让跨请求重试仍能幂等，并按 `RABILINK_RELAY_OUTBOX_TTL_MS` 独立清理；该文件属于运行期数据，不应提交。

电脑端统一会话账本可能同时由 Manager 记录 Agent 下行、由 Gateway worker 记录 observation。写入、去重、分卷和索引更新由数据目录中的 `.rabilink-conversation.lock` 跨进程串行化；不要手工删除一个仍在活跃写入的锁文件。锁超过 30 秒会按陈旧锁自行恢复，普通获取最多等待 5 秒。归档索引采用原子替换并能从孤立 JSONL 重建，避免异常退出把仍存在磁盘上的 observation 隐藏在损坏索引之后。

## 控制台日志

`/manage/<账号>` 会显示“最近日志”卡片，用于确认灵珠/Rokid 插件、PC Rabi worker 和远程 PC WebGUI 是否连通。日志按账号分离，落在：

```text
data/rabilink-relay/account-logs/<accountId>.jsonl
```

控制台只读取当前登录账号自己的日志，不混看其他账号。每个账号的数据边界是：账号拥有应用，应用拥有应用 token，PC Rabi worker、任务队列、远程 WebGUI 请求和控制台日志都只能通过所属应用归到这个账号；worker 回传消息和 WebGUI 响应时也必须带上自己的 `deviceId` / `deviceGuid`，并且只能完成服务器选中的那台 PC Rabi 对应的任务。日志内容只保存脱敏摘要：事件标题、应用名、PC Rabi 标识、任务 ID、状态、短文本预览和错误摘要；不会保存完整 token 或原始请求体。

## Rizon 导入文件

先区分两个入口：

- 在资源库创建新插件时点“导入”，使用完整插件导入文件。
- 在已经创建好的插件详情页里点“导入工具”，使用工具导入文件，不要再选完整插件导入文件。

真实运行导入文件放在：

```text
data/rabilink-relay/rokid-rabilink-plugin.CURRENT.openapi.json
data/rabilink-relay/rokid-rabilink-plugin.MANUAL_AUTH.openapi.json
data/rabilink-relay/rokid-rabilink-plugin.AGENT_TOKEN.openapi.json
data/rabilink-relay/rokid-rabilink-tools-import.CURRENT.postman.json
data/rabilink-relay/rokid-rabilink-tools-import.CURRENT.openapi.json
```

公开示例文件放在：

```text
examples/rabilink-relay/rokid-rabilink-plugin.CURRENT.example.json
examples/rabilink-relay/rokid-rabilink-plugin.MANUAL_AUTH.example.json
examples/rabilink-relay/rokid-rabilink-plugin.AGENT_TOKEN.example.json
examples/rabilink-relay/rokid-rabilink-tools-import.example.postman.json
examples/rabilink-relay/rokid-rabilink-tools-import.example.json
```

如果已经有 `RabiLinkMessage` 插件，只想在插件详情页重新“导入工具”，选：

```text
<repo>\data\rabilink-relay\rokid-rabilink-tools-import.CURRENT.postman.json
```

这个工具导入文件只包含正式交互用的两个工具：

- `submitRabiLinkTask`：提交用户语音或图片整理后的请求。
- `getRabiLinkMessages`：拉取全局下行消息队列，不需要 `taskId`。

工具导入首选 Postman Collection 版，因为 Rizon 的插件详情页“导入工具”入口对 OpenAPI 的多 API 前缀转换比较挑剔，可能报 `convert protocol failed: inconsistent API URL prefix`。Postman 版要把两个工具都写成同一个完整 HTTPS 域名前缀，例如 `https://rabi.example.com/rokid/rabilink/...`；不要使用 `{{base_url}}`，Rizon 当前不会展开 Postman 变量，会把它当成非法 URL。

如果需要 OpenAPI 备用文件，再选：

```text
<repo>\data\rabilink-relay\rokid-rabilink-tools-import.CURRENT.openapi.json
```

OpenAPI 工具导入版会把 `servers.url` 写到 `https://<domain>`，路径写完整 `/rokid/rabilink/tasks` 和 `/rokid/rabilink/messages`。这是给 Rizon “导入工具”入口准备的保守格式，避免它把 server 前缀和 path 前缀拆错。

如果用 Rizon 的“URL 和原始数据”页签导入工具，可以填：

```text
https://rabi.example.com/rokid/rabilink/tools.postman.json
```

备用同内容路径：

```text
https://rabi.example.com/openapi/rokid-rabilink-tools.postman.json
```

它刻意不包含旧的 `getRabiLinkTaskMessages`，避免 Rokid 智能体继续按 taskId 拉取导致眼镜端一直显示“思考中”。

URL 导入时，使用当前运行配置里的真实域名，把下面的占位域名替换成实际入口：

```text
https://rabi.example.com/rokid/rabilink/openapi.json
```

备用同内容路径：

```text
https://rabi.example.com/openapi/rokid-rabilink-plugin.json
```

如果 Rizon 导入后不喜欢 OpenAPI 自带的 `securitySchemes`，使用手动鉴权版：

```text
https://rabi.example.com/rokid/rabilink/openapi.manual-auth.json
```

手动鉴权版不在 OpenAPI 内声明 token，但服务器仍然要求请求头鉴权。导入后在 Rizon 插件配置里手动设置：

```text
授权方式：Service token / API key
位置：Header
Parameter name：X-RabiLink-Token
Service token / API key：填 `/manage` 里对应 RabiLink 应用的 token
```

公开插件不要在插件级 `Service token / API key` 里写入发布者自己的 token。公开/模板分发时使用 agent-token 版：

```text
https://rabi.example.com/rokid/rabilink/openapi.agent-token.json
```

备用同内容路径：

```text
https://rabi.example.com/openapi/rokid-rabilink-plugin.agent-token.json
```

这个版本不声明 OpenAPI security scheme。它把 `token` 暴露成工具参数：`submitRabiLinkTask` 通过 JSON body 的 `token` 传入，`getRabiLinkMessages` 和调试查询接口通过 query `token` 传入。导入后应在智能体引用工具的参数配置里，把 `token` 绑定为该智能体自己的 RabiLink 应用 token（固定值或变量），不要让模型临时生成、朗读或询问用户的 token。

插件描述里应保留项目地址，方便用户找到安装和 token 绑定说明：

```text
https://github.com/vb2250158/RabiRoute
```

插件图标使用仓库的 `assets/rabiroute-icon.png`。OpenAPI 里已经写入 `info.x-logo.url` 指向 GitHub raw 图标；如果 Rizon/灵珠不读取 `x-logo`，就在插件编辑页手动上传这个图标。

本地文件导入时使用：

```text
<repo>\data\rabilink-relay\rokid-rabilink-plugin.CURRENT.openapi.json
```

它是当前运行用的易识别副本。旧的 `rizon` / `rizon-ip` / `submit-only` 文件已经删除，避免误导导入。

手动鉴权版本地文件：

```text
<repo>\data\rabilink-relay\rokid-rabilink-plugin.MANUAL_AUTH.openapi.json
```

公开/模板版本地文件：

```text
<repo>\data\rabilink-relay\rokid-rabilink-plugin.AGENT_TOKEN.openapi.json
```

这个文件使用：

```text
https://rabi.example.com
```

导入后插件授权配置应使用：

```text
Service token / API key
位置：Header
Parameter name：X-RabiLink-Token
Service token / API key：填对应 RabiLink 应用的 token
```

导入前先校验本地 OpenAPI 文件：

```powershell
npm run relay:rabilink:openapi:check
```

这个检查会拦住这些历史遗留问题：

- `GET /rokid/rabilink/messages` 误带 `requestBody`
- `/rokid/rabilink/messages` 误要求 `taskId`
- OpenAPI 响应不是纯 `200`
- `servers[0].url` 指到旧域名或旧端口
- 手动鉴权版仍残留 `RabiLinkToken` security scheme

注意：

- 如果 Rizon 后台已经导入过旧插件，建议删除旧插件后重新导入，或至少重新导入覆盖。
- 插件主路径应使用 `getRabiLinkMessages(after)` 持续消费全局下行队列；`getRabiLinkTaskMessages(taskId, after)` 只作调试或单任务查看。
- GET 工具不应带 requestBody；旧文件可能会让 Rizon 试运行显示空对象或异常。
- 当前域名 `old-relay.example.com` 已确认被 DNSPod / 腾讯云域名拦截：带 Host 访问会返回 `https://dnspod.qcloud.com/static/webblock.html?d=old-relay.example.com`。不要再用它排查 Relay。
- 同样测试过 `<relay-server-ip>.sslip.io`、`<relay-server-ip-with-dashes>.sslip.io`、`<relay-server-ip>.nip.io` 后仍可能被跳到 DNSPod webblock。说明问题不在 Caddy vhost，而是腾讯云大陆机房对未备案域名 Host 的拦截。
- 示例域名 `rabi.example.com` 代表你的真实 Relay 域名；部署时应解析到自己的服务器地址，并用 HTTP / HTTPS 访问 Relay 验证。
- 非大陆代理方案已补文档和 Worker 源码：`docs/rabilink-relay-cloudflare-worker.md`、`scripts/rabilink-relay-cloudflare-worker.mjs`。Cloudflare Worker 会把 Rizon 访问的 `workers.dev` 域名转发到配置的上游 Relay，并自动把 OpenAPI 里的 `servers[0].url` 改成 Worker 域名。

部署后建议验证：

- `GET https://rabi.example.com/health` 返回 HTTP 200。
- `GET https://rabi.example.com/rokid/rabilink/openapi.json` 返回 HTTP 200、`application/json`，可解析为 `RabiLinkMessage` OpenAPI。
- `GET https://rabi.example.com/rokid/rabilink/openapi.manual-auth.json` 返回 HTTP 200、`application/json`，可作为 Rizon 手动鉴权导入备用。
- 如需直接排查服务器入口，用你的服务器 IP 或备用域名请求 `/health`。
- 未带 token 访问任务接口返回 HTTP 401，说明公网请求已经进入 Caddy 和 Relay。
- 带应用 token 做公网双向队列烟测通过：输入被 worker 接收后即可完成；普通回复和无前置 task 的主动消息都能从 `GET /rokid/rabilink/messages?stream=1` 取到；使用同一个 `deliveryId` 重试不会生成重复消息。
- 多 relay 进程共享状态烟测：`npm run relay:rabilink:test:shared-state`。这个脚本会启动两个本地 relay，验证 task 在 A 提交、B 领取和 finish 后，A 的 `GET /rokid/rabilink/messages` 能拿到下行回复。
- 服务器 Caddy 正常监听 `80`、`443`；当前推荐入口是你的 HTTPS Relay 域名。

可以用脚本复查当前公网状态：

```powershell
cd <repo>
.\scripts\Test-RabiLinkRelayPublic.ps1 -BaseUrl https://rabi.example.com -SkipQueueSmoke
```

等价 npm 命令：

```powershell
npm run relay:rabilink:test:public
```

如果要测试自定义地址，用不内置参数的 custom 命令，避免 `BaseUrl` 传重复：

```powershell
npm run relay:rabilink:test:public:custom -- -BaseUrl https://rabi.example.com -ExpectedOpenApiServerUrl https://rabi.example.com -SkipQueueSmoke
```

默认脚本检查 `https://rabi.example.com` 示例地址。真实部署时用上面的 custom 命令指定你的 Relay 地址，并保留 OpenAPI 对外声明的域名。

如果有 RabiLink 应用 token，可以跑完整双向队列烟测：

```powershell
$env:RABILINK_RELAY_APP_TOKEN = "填入当前 RabiLink 应用 token"
.\scripts\Test-RabiLinkRelayPublic.ps1 -BaseUrl https://rabi.example.com
```

脚本不会打印 token。预期至少看到：

```text
[ok] health
[ok] openapi
[ok] manual-auth openapi
[ok] auth gate
[ok] queue smoke
```

## 真实 Agent 与配置回滚验收

AIUI 示例还提供两条真实链路测试。它们使用环境中的 Relay 地址和应用 token，不会把凭证写入报告：

```powershell
cd examples\rabilink-aiui
npm run active-intelligence:e2e
npm run config-rollback:e2e
```

`active-intelligence:e2e` 会验证以下行为：

1. 没有任何眼镜输入任务时，Codex/RabiRoute 可以主动写入下行队列。
2. 一条 `rabilink.observation` 先写入统一 JSONL 并释放上行，不直接投递 Codex。
3. `rabilink.review_request` 模拟触摸板单击，唤醒空闲 turn 或 steer 当前 turn，让真实 Codex 从账本读取观察。
4. 审阅结果通过无 `taskId`、`proactive=true` 的独立下行抵达，用户 observation 和 Agent 下行位于同一个当前账本文件。
5. 超时重试保持 `deliveryId`，眼镜队列中不出现重复消息。
6. 临时配置通过同一 Relay 链路读取、写入并精确回滚。

测试仅把时延、布尔结果和配置摘要写入 `examples/rabilink-aiui/dist/`，不记录 Relay URL、token、原始对话或配置正文。

## 本地烟测

开一个终端启动：

```powershell
$tmp = Join-Path $env:TEMP "rabilink-relay-smoke"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$now = (Get-Date).ToUniversalTime().ToString("o")
@{
  accounts = @(@{ id="account-smoke"; username="smoke"; passwordHash=""; passwordSalt=""; createdAt=$now; updatedAt=$now })
  apps = @(@{ id="app-smoke"; name="Rokid Glass"; ownerAccountId="account-smoke"; enabled=$true; token="app-token-smoke"; targetDeviceId="pc-a"; createdAt=$now; updatedAt=$now })
  workers = @(@{ id="pc-a"; guid="guid-pc-a"; name="pc-a"; appId="app-smoke"; firstSeenAt=$now; lastSeenAt=$now })
} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $tmp "apps.json") -Encoding UTF8
$env:RABILINK_RELAY_DATA_DIR=$tmp
node scripts/rabilink-relay-server.mjs
```

另一个终端：

```powershell
$rokid = Start-Job -ScriptBlock {
  Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8788/rokid/rabilink" `
    -Headers @{ "X-RabiLink-Token" = "app-token-smoke" } `
    -ContentType "application/json" `
    -Body '{"text":"RabiLink Relay 本地烟测"}'
}

$task = Invoke-RestMethod -Uri "http://127.0.0.1:8788/worker/tasks?limit=1&deviceId=pc-a" `
  -Headers @{ "X-RabiLink-Token" = "app-token-smoke" }
$id = $task.tasks[0].id

Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8788/worker/tasks/$id/result" `
  -Headers @{ "X-RabiLink-Token" = "app-token-smoke" } `
  -ContentType "application/json" `
  -Body '{"ok":true,"replyText":"Relay 回包成功"}'

Receive-Job $rokid -Wait
```
