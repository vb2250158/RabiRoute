<!-- docs-language-switch -->
<div align="center">
<a href="./rabilink-relay-cloudflare-worker_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# RabiLink Relay Cloudflare Worker 代理

> 状态：环境相关运维方案。仅在 Relay IP 可用但目标客户端必须填写域名、且未备案域名被云厂商拦截时使用；不是 RabiLink 核心协议依赖。

日期：2026-07-14

## 用途

当前腾讯云大陆服务器 `<relay-server-ip>` 的 IP 入口可用，但未备案域名 Host 会被 DNSPod / 腾讯云拦截。表现是：

```text
http://old-relay.example.com/health
-> https://dnspod.qcloud.com/static/webblock.html?d=old-relay.example.com
```

`sslip.io` / `nip.io` 这类公共解析域名也会被同样拦截。因此如果 Rizon 插件 URL 必须是域名格式，可以用 Cloudflare Worker 提供一个 `workers.dev` 域名，再由 Worker 转发到 IP 入口。

## 文件

Worker 源码：

```text
<repo>\scripts\rabilink-relay-cloudflare-worker.mjs
```

Wrangler 配置：

```text
<repo>\wrangler.rabilink-relay.toml
```

部署后验证脚本：

```text
<repo>\scripts\Test-RabiLinkRelayWorker.ps1
```

默认上游：

```text
https://rabi.example.com
```

Worker 不是路径白名单。除根路径说明页和 OpenAPI 文档改写外，它会保留方法、查询参数、请求体和鉴权头，透明代理到上游。当前主要路径包括：

```text
/health
/api/rabilink/speech/*
/rokid/rabilink/openapi.json
/rokid/rabilink/openapi.manual-auth.json
/rokid/rabilink/openapi.agent-token.json
/openapi/rokid-rabilink-plugin.json
/openapi/rokid-rabilink-plugin.manual-auth.json
/openapi/rokid-rabilink-plugin.agent-token.json
/rokid/rabilink/input
/rokid/rabilink/messages
/rokid/rabilink/tasks
/rokid/rabilink/tasks/<taskId>
/rokid/rabilink/tasks/<taskId>/messages
/worker/tasks
/worker/tasks/<taskId>/*
/worker/messages
/api/rabilink/mobile/state
/api/rabilink/mobile/device-status
/api/rabilink/mobile/proof
/api/rabilink/mobile/proofs
/api/rabilink/mobile/target
/api/rabilink/mobile/webgui
/api/rabilink/mobile/routes/*
```

Worker 的 CORS 预检允许 `GET`、`POST`、`PATCH`，并允许 `Authorization` 与 `X-RabiLink-Token`。因此 AIUI 的 Bearer token 上行和手机端目标切换都可以经 Worker 使用；不要在反向代理层再次删除这些鉴权头。

当前 AIUI 连接对话使用两条独立队列：

1. 最终 ASR 文本通过 `POST /rokid/rabilink/input` 发布为 record-first observation。电脑端写入统一会话账本并完成上行，不在这个请求里等待 Codex。
2. Agent、定时器或规划器通过电脑端输出安全门发布下行；眼镜持续请求 `GET /rokid/rabilink/messages?stream=1&after=<cursor>`，拉到一句播一句。

AIUI 第一次进入连接对话时可以让 `after` 为空，以消费 Relay 保留期内尚未处理的主动消息；随后始终保存并复用返回的 `nextCursor`。这个接口不需要 `taskId`，无前置输入任务的主动消息也可以出现。旧版 Rizon 插件仍可先调用 `submitRabiLinkTask`，再用其返回的 `cursor` / `nextCursor` 开始消费同一全局下行流；这是兼容流程，不是当前 AIUI 的页面状态机。

导入 OpenAPI 时，Worker 会自动把 OpenAPI 的 `servers[0].url` 改成 Worker 自己的域名，避免 Rizon 导入后又回到 IP 地址。

## 部署

在一台已安装 Wrangler 的机器上：

```powershell
cd <repo>
npx wrangler deploy --config .\wrangler.rabilink-relay.toml
```

等价 npm 命令：

```powershell
npm run relay:rabilink:worker:deploy
```

部署前可先做本地语法与代理契约检查（包括 Bearer token、`PATCH` 和 CORS 预检）：

```powershell
npm run relay:rabilink:worker:check
```

如果要显式指定上游：

```powershell
npx wrangler secret put RABILINK_UPSTREAM
```

填：

```text
https://rabi.example.com
```

不要把 RabiLink 应用 token 写进 Worker。Worker 只负责改写 OpenAPI 的 `servers[0].url` 并透明转发请求；Rizon/灵珠插件或智能体工具参数必须自己传对应应用 token。这样同一个 Worker 才能服务多个账号、多个应用和多台 PC Rabi，不会退回“公共转发 token”。

## Rizon 导入

部署后，假设 Worker 地址是：

```text
https://rabilink-relay.<你的 workers 子域>.workers.dev
```

优先导入：

```text
https://rabilink-relay.<你的 workers 子域>.workers.dev/rokid/rabilink/openapi.json
```

如果 Rizon 对 OpenAPI 内置鉴权不兼容，导入手动鉴权版：

```text
https://rabilink-relay.<你的 workers 子域>.workers.dev/rokid/rabilink/openapi.manual-auth.json
```

手动鉴权版导入后，在 Rizon 插件配置里填：

```text
授权方式：Service token / API key
位置：Header
Parameter name：X-RabiLink-Token
Service token / API key：填当前 RabiLink 应用 token
```

如果要做公开/模板插件，不要把发布者 token 写到插件级鉴权里。导入 agent-token 版：

```text
https://rabilink-relay.<你的 workers 子域>.workers.dev/rokid/rabilink/openapi.agent-token.json
```

然后在智能体引用工具的参数配置里，把 `token` 绑定为该智能体自己的 RabiLink 应用 token。这个版本的 POST 接口使用 body `token`，GET 接口使用 query `token`。

## 验证

部署后先测：

```powershell
Invoke-RestMethod https://rabilink-relay.<你的 workers 子域>.workers.dev/health
Invoke-RestMethod https://rabilink-relay.<你的 workers 子域>.workers.dev/rokid/rabilink/openapi.json
```

也可以用脚本做完整检查：

```powershell
cd <repo>
.\scripts\Test-RabiLinkRelayWorker.ps1 -WorkerBaseUrl https://rabilink-relay.<你的 workers 子域>.workers.dev -SkipQueueSmoke
```

如果有 RabiLink 应用 token，可以跑 Worker 端到端队列烟测：

```powershell
$env:RABILINK_RELAY_APP_TOKEN = "填入当前 RabiLink 应用 token"
.\scripts\Test-RabiLinkRelayWorker.ps1 -WorkerBaseUrl https://rabilink-relay.<你的 workers 子域>.workers.dev
```

预期：

- `/health` 返回 `ok: true`
- OpenAPI 返回 `info.title = RabiLinkMessage`
- OpenAPI 的 `servers[0].url` 是 Worker 自己的 `https://...workers.dev`
- 未带 token 访问 `/rokid/rabilink/tasks/<taskId>/messages` 返回 401
- 带应用 token 的队列烟测能提交兼容任务、模拟 PC worker 完成任务、从全局 `/rokid/rabilink/messages` 拉到带 `taskId` 的回复；还能通过 `/worker/messages` 幂等提交无 `taskId` 的主动消息，并从 `stream=1` 拉到且只拉到一条

上面的脚本同时覆盖旧插件任务兼容协议和无 task 主动下行。AIUI 发布前还要按 [RabiLink Relay 公网中继](rabilink-relay-server.md) 验证 `/rokid/rabilink/input` 的 record-first 上行与空 cursor 恢复下行积压；不要用“任务烟测通过”替代这两项验收。

如果 Worker 通而 Rizon 不通，再查插件鉴权和工具配置；不要回头把 `old-relay.example.com` 当成可用域名测试。
