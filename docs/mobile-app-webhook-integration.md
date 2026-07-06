# 手机 App 远程接入 RabiRoute 技术方案

这份方案面向 App 开发者和 RabiRoute 后端实现者，目标是在手机不和 RabiRoute 位于同一局域网时，通过公网 HTTPS 与 WebSocket 接入 RabiRoute，让手机 App 可以发送消息给 Rabi，并可靠接收 Rabi / Agent 的回复。

当前 RabiRoute 已经支持通用 `webhook` 入站，也支持面向手机/Rokid 桥接的 `rabilink` 专用入站：外部系统可以 `POST /rabilink` 把文本事件送入路由。完整的手机 App 双向接入还需要新增 mobile 专用会话、WebSocket 长连接和 per-device 消息状态队列。本文把“现在能用的最小链路”和“正式双向接入需要实现的接口”分开描述。

## 目标链路

推荐公网部署拓扑：

```text
Mobile App
  -> https://rabi.example.com
  -> Caddy / Nginx HTTPS reverse proxy
  -> RabiRoute manager / gateway on 127.0.0.1
  -> Agent adapter
  -> Mobile outbox queue
  -> WebSocket to Mobile App
```

入站方向：

```text
手机 App 输入文本 / 语音转写 / 图片 OCR
  -> POST /api/mobile/messages
  -> RabiRoute mobile message adapter
  -> route kind: voice_transcript 或 mobile_message
  -> Codex / Copilot / 其他 Agent
```

短期兼容链路可以先用现有 webhook：

```text
手机 App
  -> POST /webhook
  -> RabiRoute webhook adapter
  -> route kind: voice_transcript
```

出站方向：

```text
Agent 回复
  -> POST /api/agent/replies
  -> RabiRoute outbox
  -> mobile message queue
  -> WebSocket push
  -> App ACK
```

## 当前可用能力

现有 `webhook` message adapter 可以接收 HTTP POST。默认监听路径和端口来自 route 配置：

```json
{
  "messageAdapters": ["webhook"],
  "webhookPort": 8791,
  "webhookPath": "/webhook"
}
```

手机 App 或调试脚本可以发送：

```http
POST https://rabi.example.com/webhook
Content-Type: application/json
Authorization: Bearer <mobile-token>
```

```json
{
  "type": "webhook.text",
  "source": "mobile-app",
  "sourceDeviceId": "phone-demo-001",
  "sourceDeviceName": "Demo Phone",
  "sessionId": "chat-demo-001",
  "text": "帮我记录一下，今晚整理手机端接入方案"
}
```

RabiRoute 会从 `text` / `message` / `content` 里提取正文，并记录为语音转写类事件。当前代码默认只监听 `127.0.0.1`，公网部署时建议由 Caddy / Nginx 反代到本机端口，而不是直接暴露 RabiRoute gateway 端口。

这个最小链路只能解决“手机发消息给 Rabi”。如果 App 要实时收到 Rabi 回复，需要下面的 mobile outbox 能力。

## RabiLink 当前最小链路

RabiLink 是当前给 Rokid/灵珠和手机 App 预留的专用消息端。它不要求手机直接运行 Codex，只负责把手机侧拿到的文本请求转成 RabiRoute 入站事件。

路由配置示例：

```json
{
  "messageAdapters": ["rolePanel", "rabilink"],
  "rabiLinkWebhookPort": 8794,
  "rabiLinkWebhookHost": "0.0.0.0",
  "rabiLinkWebhookPath": "/rabilink",
  "agentAdapters": ["codex"]
}
```

本机调试地址：

```text
http://127.0.0.1:8794/rabilink
```

同一局域网手机测试时，监听地址可以设成 `0.0.0.0` 或电脑网卡 IP；手机里填写电脑 IP，例如：

```text
http://192.168.1.23:8794/rabilink
```

`0.0.0.0` 只表示“服务监听所有网卡”，不是给手机或云平台填写的目标地址。

局域网手机调试时，把 `127.0.0.1` 换成电脑的局域网 IP。Rokid/灵珠云端回调不能访问本机地址，需要使用公网 HTTPS 反代到这个本地端口。

WebGUI 里会同时显示“监听地址”和“复制回调”。监听地址可以是 `0.0.0.0`；复制给手机或外部平台时应使用“复制回调”，它会把 `0.0.0.0` 换成电脑局域网 IP。

请求示例：

```http
POST http://127.0.0.1:8794/rabilink
Content-Type: application/json
```

```json
{
  "type": "rabilink.message",
  "source": "rabilink",
  "sourceDeviceId": "rokid-glass-dev",
  "sourceDeviceName": "Rokid Glass",
  "sessionId": "rabilink-test",
  "message": "帮我把这句话转交给 Codex"
}
```

RabiRoute 会从 `text`、`message`、`content`、`query`、`prompt`、`input`、`question`、`data.text` 或 `messages[].content` 中提取正文，写入 `rabilink-voice-transcripts.jsonl`，并按 `voice_transcript` 投递给 Codex。成功接收时返回 `200`：

```json
{
  "ok": true,
  "status": "accepted",
  "messageId": "rabilink-...",
  "text": "已转交 Codex 处理。",
  "answer": "已转交 Codex 处理。",
  "reply": "已转交 Codex 处理。"
}
```

Rokid 官方“自定义智能体 URL”如果接 RabiRoute 云端，应填写公网 HTTPS 地址，例如：

```text
https://rabi.example.com/rabilink
```


## 正式接口设计

正式手机端建议新增独立 mobile message adapter，不复用通用 webhook 作为产品边界。通用 webhook 保持给临时外部系统使用；mobile adapter 负责设备身份、会话、回包队列和 ACK。

### 发送消息

```http
POST /api/mobile/messages
Authorization: Bearer <mobile-token>
Content-Type: application/json
```

```json
{
  "deviceId": "phone-demo-001",
  "sessionId": "chat-demo-001",
  "clientMessageId": "client-1730000000000-1",
  "text": "今天有哪些需要我处理的 RabiRoute 事项？",
  "attachments": []
}
```

字段约定：

- `deviceId`：App 安装或登录后生成的稳定设备 ID。
- `sessionId`：一次对话或页面会话 ID；同一个设备可以有多个 session。
- `clientMessageId`：App 生成的幂等 ID，断线重试时保持不变。
- `text`：本次消息正文。
- `attachments`：预留图片、语音、文件、OCR 结果等结构化附件。

服务端返回：

```json
{
  "ok": true,
  "messageId": "mobile-in-1730000000000-1",
  "status": "accepted"
}
```

第一版可以把 mobile 入站事件归一成现有 `voice_transcript`，继续复用已有路由模板变量；后续再新增更准确的 `mobile_message` route kind。

### 建立 WebSocket

```http
GET /api/mobile/ws?deviceId=phone-demo-001
Authorization: Bearer <mobile-token>
```

也可以命名为：

```text
WebSocket /api/mobile/sessions
```

连接建立后，服务端先推送这个设备所有未 ACK 的出站消息，再推送实时新消息。

服务端推送格式：

```json
{
  "type": "mobile.reply",
  "messageId": "mobile-out-1730000000000-1",
  "deviceId": "phone-demo-001",
  "sessionId": "chat-demo-001",
  "text": "我看到了。今晚可以先整理接入文档，再决定是否实现 mobile outbox。",
  "createdAt": "2026-07-03T12:00:00.000Z",
  "replyContext": {
    "routeProfileId": "mobile",
    "sourceMessageId": "mobile-in-1730000000000-1"
  },
  "attachments": []
}
```

### 确认收到

App 展示或持久化消息后，调用 ACK：

```http
POST /api/mobile/acks
Authorization: Bearer <mobile-token>
Content-Type: application/json
```

```json
{
  "deviceId": "phone-demo-001",
  "messageIds": ["mobile-out-1730000000000-1"]
}
```

服务端返回：

```json
{
  "ok": true,
  "acked": ["mobile-out-1730000000000-1"]
}
```

只有收到 ACK 后，服务端才把消息视为最终送达。

## 消息状态队列

服务端需要为每个 `deviceId` / `sessionId` 保存出站消息。第一版可以落在运行期 `data/` 目录下的 JSONL 文件，后续如果需要多实例部署或更强查询能力，再换成 SQLite / Postgres。

建议状态机：

```text
queued -> delivering -> delivered -> acked
           |              |
           v              v
         queued         queued
```

含义：

- `queued`：消息已经生成，但设备离线或尚未尝试推送。
- `delivering`：WebSocket 在线，服务端正在发送。
- `delivered`：服务端已经写入 WebSocket，但还没有收到 App ACK。
- `acked`：App 已确认收到，可以从未读队列中移除或标记归档。

失败处理：

- WebSocket 发送失败或连接断开：`delivering` 回到 `queued`。
- `delivered` 超过确认超时仍未 ACK：回到 `queued`，重连时再次推送。
- App 收到重复 `messageId`：按幂等处理，不重复展示，只补发 ACK。

建议每条出站消息至少保存：

```json
{
  "messageId": "mobile-out-1730000000000-1",
  "deviceId": "phone-demo-001",
  "sessionId": "chat-demo-001",
  "status": "queued",
  "text": "回复正文",
  "createdAt": "2026-07-03T12:00:00.000Z",
  "updatedAt": "2026-07-03T12:00:00.000Z",
  "attempts": 0,
  "replyContext": {}
}
```

## App 端最小流程

App 启动后：

1. 读取本地保存的 `deviceId` 和 token。
2. 建立 WebSocket。
3. 收到服务端 reply 后先按 `messageId` 幂等落本地库，再渲染 UI。
4. 本地落库成功后发送 ACK。
5. WebSocket 断开后使用指数退避重连。
6. 用户发送消息时生成 `clientMessageId`，HTTP 失败可用同一个 ID 重试。

TypeScript 风格伪代码：

```ts
const apiBase = "https://rabi.example.com";
const token = "<mobile-token>";
const deviceId = "phone-demo-001";

async function sendMessage(text: string, sessionId: string) {
  const clientMessageId = `client-${Date.now()}`;
  const response = await fetch(`${apiBase}/api/mobile/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${token}`
    },
    body: JSON.stringify({
      deviceId,
      sessionId,
      clientMessageId,
      text,
      attachments: []
    })
  });
  if (!response.ok) {
    throw new Error(`send failed: ${response.status}`);
  }
  return response.json();
}

function connectMobileSession() {
  const ws = new WebSocket(`${apiBase.replace(/^http/, "ws")}/api/mobile/ws?deviceId=${encodeURIComponent(deviceId)}`, [], {
    headers: {
      authorization: `Bearer ${token}`
    }
  });

  ws.onmessage = async (event) => {
    const message = JSON.parse(event.data);
    if (message.type !== "mobile.reply") return;
    await saveReplyIfMissing(message.messageId, message);
    await ackMessages([message.messageId]);
  };

  ws.onclose = () => {
    setTimeout(connectMobileSession, 2000);
  };
}

async function ackMessages(messageIds: string[]) {
  await fetch(`${apiBase}/api/mobile/acks`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${token}`
    },
    body: JSON.stringify({ deviceId, messageIds })
  });
}
```

React Native 的标准 `WebSocket` 不支持直接传自定义 header；这种情况下可以把 token 放在一次性签名 URL、`Sec-WebSocket-Protocol` 子协议，或先通过 HTTPS 换取短期 `wsTicket`：

```text
POST /api/mobile/ws-ticket
GET /api/mobile/ws?deviceId=phone-demo-001&ticket=<short-lived-ticket>
```

## 公网部署建议

RabiRoute gateway 和 manager 都建议继续只监听本机地址，由反代暴露 HTTPS：

```text
公网 443
  -> Caddy / Nginx
  -> http://127.0.0.1:8790  manager API
  -> http://127.0.0.1:8791  webhook gateway
  -> http://127.0.0.1:8794  RabiLink gateway
```

Caddy 示例：

```caddyfile
www.rabiroute.com {
  reverse_proxy /webhook 127.0.0.1:8791
  reverse_proxy /rabilink 127.0.0.1:8794
  reverse_proxy /api/mobile/* 127.0.0.1:8790
}
```

如果使用 Nginx，WebSocket 路径必须保留 upgrade 头：

```nginx
location /api/mobile/ws {
  proxy_pass http://127.0.0.1:8790;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
}
```

安全要求：

- 公网只暴露 HTTPS，不直接暴露 RabiRoute 内部端口。
- HTTP 和 WebSocket 都必须鉴权。
- token 不写进公开仓库；示例只使用占位值。
- 服务端应限制 body 大小、连接数和发送频率。
- 后续可以增加设备注册、token 轮换、请求签名和 IP / 用户级限流。

## 与 RabiRoute 现有模型的关系

手机 App 是一个消息端，不是 Agent runtime。它负责把用户输入送入 RabiRoute，并接收 RabiRoute outbox 的结果；真正处理问题的仍是 Codex、Copilot、Marvis 或其他 Agent adapter。

实现时应复用这些现有边界：

- 入站 adapter 负责规范化事件和写入消息日志。
- 路由规则决定是否投递给 Agent。
- Agent 收到 `replyContextJson` 后通过 `/api/agent/replies` 回传结果。
- RabiRoute outbox 决定是否发送、写草稿、阻止或记录失败。
- mobile outbox 只负责把允许发送给手机的结果排队和投递。

第一版 mobile outbox 可以只支持文本回复。图片、语音、文件统一放入 `attachments` 扩展字段，等 App UI 和服务端存储都稳定后再启用。

## 自检场景

实现完成后至少验证这些路径：

- App 通过 HTTPS 发一条文本，RabiRoute 记录为 RabiLink / mobile / webhook 入站事件。
- Agent 生成回复后，服务端把回复写入对应设备队列。
- WebSocket 在线时 App 立即收到回复并 ACK。
- WebSocket 断开时回复保留在队列；App 重连后收到未 ACK 消息。
- 服务端重复推送同一 `messageId` 时，App 不重复展示，并补发 ACK。
- token 缺失、错误或过期时，HTTP 和 WebSocket 都被拒绝。
- 反代 HTTPS、WebSocket upgrade 和本机 RabiRoute 端口都能分别排查。
