# RabiLink Relay Cloudflare Worker 代理

日期：2026-07-06

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

Worker 会代理这些路径：

```text
/health
/rokid/rabilink/openapi.json
/rokid/rabilink/openapi.manual-auth.json
/openapi/rokid-rabilink-plugin.json
/openapi/rokid-rabilink-plugin.manual-auth.json
/rokid/rabilink/tasks
/rokid/rabilink/tasks/<taskId>/messages
/rokid/rabilink/messages（兼容/调试）
/phone/tasks/*
```

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

部署前可先做本地语法检查：

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

通常不建议把 Relay token 写进 Worker。让 Rizon 插件用 `X-RabiLink-Token` 请求头传 token 更清楚。如果必须由 Worker 注入 token，再设置：

```powershell
npx wrangler secret put RABILINK_FORWARD_TOKEN
```

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
Service token / API key：填当前 Relay token
```

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

如果有 Relay token，可以跑 Worker 端到端队列烟测：

```powershell
$env:RABILINK_RELAY_TOKEN = "填入当前 Relay token"
.\scripts\Test-RabiLinkRelayWorker.ps1 -WorkerBaseUrl https://rabilink-relay.<你的 workers 子域>.workers.dev
```

预期：

- `/health` 返回 `ok: true`
- OpenAPI 返回 `info.title = RabiLinkMessage`
- OpenAPI 的 `servers[0].url` 是 Worker 自己的 `https://...workers.dev`
- 未带 token 访问 `/rokid/rabilink/tasks/<taskId>/messages` 返回 401
- 带 token 的队列烟测能提交任务、模拟手机完成任务、按 `taskId` 从 Worker 拉到本轮消息，拉空后 `shouldContinue=false`

如果 Worker 通而 Rizon 不通，再查插件鉴权和工具配置；不要回头把 `old-relay.example.com` 当成可用域名测试。
