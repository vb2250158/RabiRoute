# RabiLink Relay 公网中继

这个服务用于把 Rokid 云侧插件和电脑端 RabiRoute/RabiLink 消息端接起来。主链路不经过手机桥，由电脑端 RabiLink worker 直接领取任务并回写回复。

链路：

```text
Rokid 眼镜 / 灵珠智能体
-> Rokid 云侧插件
-> RabiLink Relay 公网 HTTPS
-> 电脑端 RabiLink worker 轮询取任务
-> RabiRoute 本地 rabilink 消息端
-> Codex
-> 电脑端 worker 把回复 POST 回 Relay
-> Relay 返回给 Rokid 插件
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

首次进入时注册一个服务器账号，然后创建 RabiLink 应用。每个应用会生成独立 `rbl_...` token；完整 token 只在创建或重新生成时显示一次。Rokid/灵珠插件和电脑端 RabiLink worker 都使用同一个应用 token，Relay 会按应用隔离 task 和下行消息队列。

`RABILINK_RELAY_TOKEN` 仍然兼容旧部署；设置后它是全局 token，可以访问所有应用的任务。新部署优先使用 `/manage` 创建的应用 token。

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

### 异步轮询接口

如果 Rokid 智能体愿意反复调用插件查询结果，更推荐使用两个工具：

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

当 `status=done` 时，把 `text`/`answer` 读给用户并停止调用插件；当 `status=failed` 时说明失败并停止调用插件；当 `status=pending` 时可以稍后再查。

如果需要 Codex 分多次回复、眼镜立刻逐条转述，优先使用全局下行消息列表。每次用户新输入都会由 `submitRabiLinkTask` 创建一个新的 `taskId`，同时返回当前全局下行游标 `cursor` / `nextCursor`；眼镜端后续用这个游标调用 `getRabiLinkMessages`，不需要传 `taskId`：

```http
GET /rokid/rabilink/messages?after=<lastOutboxMessageId>
Authorization: Bearer <token>
```

第一次查询使用 `submitRabiLinkTask` 返回的 `cursor` / `nextCursor` 作为 `after`。如果本次返回了 `nextCursor`，下一次继续把它作为 `after`。服务器会长轮询等待新消息；电脑端 RabiLink worker 调用 `/worker/tasks/<taskId>/finish` 后，任务才算进入结束态。眼镜端不要限制轮询次数：拉到一句说一句，拉到一句说一句；直到 Rabi/Codex 侧通过电脑端 worker 返回结束，本轮才结束。

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

眼镜智能体策略：

```text
1. 调用 submitRabiLinkTask 提交用户原话，保存返回的 cursor / nextCursor。
2. 调用 getRabiLinkMessages(after=cursor) 拉取全局下行消息；这个接口不需要 taskId。
3. messages 里有几条就按顺序复述几条，拉出来的都要显示；拉到一句说一句，不要攒到最后。
4. 每次处理完 messages 后保存 nextCursor，下次作为 after。
5. 不要设置 3 次之类的调用次数限制。只要还在对话，就继续用 nextCursor 拉取。
6. 如果 messages 为空但 shouldContinue=true，说明电脑端仍在处理，继续等待下一轮长轮询。
7. 只有当 Rabi/Codex 侧已经返回结束、电脑端 worker 完成 finish，并且 messages 为空且 shouldContinue=false 时，才结束本轮。
8. 不要把 getRabiLinkTaskResult 的 text/reply/answer/content 当成用户回复复述，避免重复。
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

## 电脑端 worker 回填结果

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

这个接口会追加一条最终消息，并把任务标记为结束。

### 消息流：追加一条或多条回复

电脑端 RabiLink worker 每拿到 Codex 一句回复，就调用：

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

任务结束时调用：

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
| `RABILINK_RELAY_TOKEN` | 空 | 兼容旧部署的全局 token；新部署优先用 `/manage` 创建应用 token |
| `RABILINK_RELAY_PORT` / `PORT` | `8788` | 监听端口 |
| `RABILINK_RELAY_HOST` / `HOST` | `0.0.0.0` | 监听地址 |
| `RABILINK_RELAY_REPLY_TIMEOUT_MS` | `60000` | Rokid 请求最多等待 worker 回填多久 |
| `RABILINK_RELAY_MESSAGE_WAIT_MS` | `60000` | 眼镜按 taskId 拉取消息列表的长轮询等待时间 |
| `RABILINK_RELAY_OUTBOX_WAIT_MS` | `60000` | 兼容全局下行消息列表长轮询等待时间 |
| `RABILINK_RELAY_WORKER_TASK_WAIT_MS` | `60000` | 电脑端 worker 领取任务的长轮询等待时间 |
| `RABILINK_RELAY_WEBGUI_REQUEST_WAIT_MS` | `30000` | 服务器等待电脑端 worker 回填 WebGUI 响应的时间 |
| `RABILINK_RELAY_WEBGUI_BODY_MAX_BYTES` | `10485760` | 单次远程 WebGUI 请求体大小上限 |
| `RABILINK_RELAY_TASK_TTL_MS` | `600000` | 任务保留时间 |
| `RABILINK_RELAY_LEASE_MS` | `45000` | worker 取到任务后的租约时间 |
| `RABILINK_RELAY_DATA_DIR` | `data/rabilink-relay` | 事件日志和服务器 WebGUI 账号/应用数据目录 |
| `RABILINK_RELAY_APP_STORE_FILE` | `<dataDir>/apps.json` | 账号、密码哈希、应用和 token 存储文件 |
| `RABILINK_RELAY_ALLOW_INSECURE` | `0` | 本地测试可设为 `1` 跳过 token |

## Rizon 导入文件

先区分两个入口：

- 在资源库创建新插件时点“导入”，使用完整插件导入文件。
- 在已经创建好的插件详情页里点“导入工具”，使用工具导入文件，不要再选完整插件导入文件。

真实运行导入文件放在：

```text
data/rabilink-relay/rokid-rabilink-plugin.CURRENT.openapi.json
data/rabilink-relay/rokid-rabilink-plugin.MANUAL_AUTH.openapi.json
data/rabilink-relay/rokid-rabilink-tools-import.CURRENT.postman.json
data/rabilink-relay/rokid-rabilink-tools-import.CURRENT.openapi.json
```

公开示例文件放在：

```text
examples/rabilink-relay/rokid-rabilink-plugin.CURRENT.example.json
examples/rabilink-relay/rokid-rabilink-plugin.MANUAL_AUTH.example.json
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

本地文件导入时使用：

```text
<repo>\data\rabilink-relay\rokid-rabilink-plugin.CURRENT.openapi.json
```

它是当前运行用的易识别副本。旧的 `rizon` / `rizon-ip` / `submit-only` 文件已经删除，避免误导导入。

手动鉴权版本地文件：

```text
<repo>\data\rabilink-relay\rokid-rabilink-plugin.MANUAL_AUTH.openapi.json
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
- 带应用 token 做公网双向队列烟测通过：提交 task 成功，模拟 worker 侧 finish 成功，`GET /rokid/rabilink/tasks/<taskId>/messages?waitMs=0` 能拉到本轮下行消息。
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

如果有应用 token 或旧版全局 Relay token，可以跑完整双向队列烟测：

```powershell
$env:RABILINK_RELAY_TOKEN = "填入当前应用 token"
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

## 本地烟测

开一个终端启动：

```powershell
$env:RABILINK_RELAY_ALLOW_INSECURE="1"
node scripts/rabilink-relay-server.mjs
```

另一个终端：

```powershell
$rokid = Start-Job -ScriptBlock {
  Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8788/rokid/rabilink" `
    -ContentType "application/json" `
    -Body '{"text":"RabiLink Relay 本地烟测"}'
}

$task = Invoke-RestMethod -Uri "http://127.0.0.1:8788/worker/tasks?limit=1"
$id = $task.tasks[0].id

Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8788/worker/tasks/$id/result" `
  -ContentType "application/json" `
  -Body '{"ok":true,"replyText":"Relay 回包成功"}'

Receive-Job $rokid -Wait
```
