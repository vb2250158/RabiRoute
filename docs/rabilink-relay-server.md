# RabiLink Relay 公网中继

这个服务用于把 Rokid 云侧插件和手机 RabiLink App 接起来。

链路：

```text
Rokid 眼镜 / 灵珠智能体
-> Rokid 云侧插件
-> RabiLink Relay 公网 HTTPS
-> 手机 RabiLink App 轮询取任务
-> 手机 POST 到电脑 RabiRoute /rabilink
-> Codex
-> 手机把回复 POST 回 Relay
-> Relay 返回给 Rokid 插件
```

## 启动

```powershell
cd C:\Path\To\RabiRoute
$env:RABILINK_RELAY_TOKEN="换成一段长随机字符串"
$env:RABILINK_RELAY_PORT="8788"
node scripts/rabilink-relay-server.mjs
```

公网部署时建议放到 HTTPS 反代后面，例如：

```text
https://你的域名/rokid/rabilink
```

Rokid 插件 URL 填：

```text
https://你的域名/rokid/rabilink?token=换成一段长随机字符串
```

如果 Rokid 插件支持请求头，更推荐：

```text
Authorization: Bearer 换成一段长随机字符串
```

或：

```text
X-RabiLink-Token: 换成一段长随机字符串
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

默认会等待手机回填结果，最多等 `RABILINK_RELAY_REPLY_TIMEOUT_MS`，默认 25 秒。

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
  "text": "已收到，正在转交手机 RabiLink 和 Codex 处理。请稍后查询结果。"
}
```

随后 Rokid 智能体可以调用旧的最终状态接口：

```http
GET /rokid/rabilink/tasks/<taskId>
Authorization: Bearer <token>
```

当 `status=done` 时，把 `text`/`answer` 读给用户并停止调用插件；当 `status=failed` 时说明失败并停止调用插件；当 `status=pending` 时可以稍后再查。

如果需要 Codex 分多次回复、眼镜立刻逐条转述，优先使用当前任务的消息列表。每次用户新输入都会由 `submitRabiLinkTask` 创建一个新的 `taskId`；后续只用这个 `taskId` 拉取本轮消息，避免复述历史会话：

```http
GET /rokid/rabilink/tasks/<taskId>/messages?after=<lastMessageId>
Authorization: Bearer <token>
```

第一次查询不带 `after`。如果本次返回了 `nextCursor`，下一次把它作为 `after`。服务器会短暂等待本任务的新消息；手机桥调用 `/phone/tasks/<taskId>/finish` 后，任务才算进入结束态。为了不漏最后一批消息，眼镜端应持续拉取到 `messages=[]` 且 `shouldContinue=false`。

返回示例：

```json
{
  "code": 0,
  "ok": true,
  "status": "messages",
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

眼镜智能体策略：

```text
1. 调用 submitRabiLinkTask 提交用户原话，保存返回的 taskId。
2. 调用 getRabiLinkTaskMessages(taskId)，第一次 after 留空。
3. messages 里有几条就按顺序复述几条，拉出来的都要显示。
4. 保存 nextCursor，下次拉同一个 taskId 时作为 after。
5. 如果 shouldContinue=true，继续调用 getRabiLinkTaskMessages(taskId, after=nextCursor)。
6. 只有当 messages 为空且 shouldContinue=false 时，才结束本轮。
7. 不要把 getRabiLinkTaskResult 的 text/reply/answer/content 当成用户回复复述，避免重复。
```

兼容旧工具仍然保留全局下行消息列表 `/rokid/rabilink/messages`，但它不应暴露给眼镜插件作为主路径；公开 OpenAPI 只暴露按 `taskId` 拉取的消息列表。

按 `taskId` 查询单个任务的消息流：

```http
GET /rokid/rabilink/tasks/<taskId>/messages?after=<lastMessageId>
Authorization: Bearer <token>
```

第一次查询不带 `after`。当没有新消息且任务未结束时，服务器默认最多等待 12 秒；有新消息、任务结束或等待超时后返回。这样眼镜智能体不需要在短时间内频繁调用插件。

可选参数：

- `after`：已经读过的最后一条消息 ID。
- `waitMs`：本次长轮询最长等待时间，范围 0-30000 毫秒。缺省使用服务端 `RABILINK_RELAY_MESSAGE_WAIT_MS`，当前默认 12000。

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

眼镜智能体策略：

```text
1. 如果 messages 不为空，按顺序立刻转述给用户。
2. 保存 nextCursor。
3. 如果 shouldContinue=true，稍后继续调用本接口，并把 nextCursor 作为 after。由于接口本身会短暂等待，智能体不要做高频空轮询。
4. 如果 shouldContinue=false，停止调用插件。
```

## 手机取任务

```http
GET /phone/tasks?limit=1&deviceId=phone-main
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

手机拿到任务后，调用电脑 RabiRoute：

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

## 手机回填结果

### 兼容：一次性回填最终结果

```http
POST /phone/tasks/<taskId>/result
Content-Type: application/json
Authorization: Bearer <token>

{
  "ok": true,
  "replyText": "Codex 的回复文本"
}
```

这个接口会追加一条最终消息，并把任务标记为结束。

### 消息流：追加一条或多条回复

手机或本地同步器每拿到 Codex 一句回复，就调用：

```http
POST /phone/tasks/<taskId>/messages
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
POST /phone/tasks/<taskId>/finish
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
  "error": "手机转发到 RabiRoute 失败"
}
```

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `RABILINK_RELAY_TOKEN` | 空 | 公网部署必填 |
| `RABILINK_RELAY_PORT` / `PORT` | `8788` | 监听端口 |
| `RABILINK_RELAY_HOST` / `HOST` | `0.0.0.0` | 监听地址 |
| `RABILINK_RELAY_REPLY_TIMEOUT_MS` | `25000` | Rokid 请求最多等待手机回填多久 |
| `RABILINK_RELAY_MESSAGE_WAIT_MS` | `12000` | 眼镜按 taskId 拉取消息列表的长轮询等待时间 |
| `RABILINK_RELAY_OUTBOX_WAIT_MS` | `1500` | 兼容全局下行消息列表短等待时间 |
| `RABILINK_RELAY_TASK_TTL_MS` | `600000` | 任务保留时间 |
| `RABILINK_RELAY_LEASE_MS` | `45000` | 手机取到任务后的租约时间 |
| `RABILINK_RELAY_DATA_DIR` | `data/rabilink-relay` | 事件日志目录 |
| `RABILINK_RELAY_ALLOW_INSECURE` | `0` | 本地测试可设为 `1` 跳过 token |

## Rizon 导入文件

真实运行导入文件放在：

```text
data/rabilink-relay/rokid-rabilink-plugin.CURRENT.openapi.json
data/rabilink-relay/rokid-rabilink-plugin.MANUAL_AUTH.openapi.json
```

公开示例文件放在：

```text
examples/rabilink-relay/rokid-rabilink-plugin.CURRENT.example.json
examples/rabilink-relay/rokid-rabilink-plugin.MANUAL_AUTH.example.json
```

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
Service token / API key：填当前 Relay token
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
- 插件主路径应使用 `getRabiLinkTaskMessages(taskId, after)`；全局 `getRabiLinkMessages` 只作兼容/调试，不应暴露给眼镜端主流程。
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
- 带 token 做公网双向队列烟测通过：提交 task 成功，模拟手机侧 finish 成功，`GET /rokid/rabilink/tasks/<taskId>/messages?waitMs=0` 能拉到本轮下行消息。
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

如果有 Relay token，可以跑完整双向队列烟测：

```powershell
$env:RABILINK_RELAY_TOKEN = "填入当前 Relay token"
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

$task = Invoke-RestMethod -Uri "http://127.0.0.1:8788/phone/tasks?limit=1"
$id = $task.tasks[0].id

Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8788/phone/tasks/$id/result" `
  -ContentType "application/json" `
  -Body '{"ok":true,"replyText":"Relay 回包成功"}'

Receive-Job $rokid -Wait
```
