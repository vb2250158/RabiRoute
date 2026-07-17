<!-- docs-language-switch -->
<div align="center">
<a href="./RUNBOOK.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# XiaoAI RabiRoute 运维 Runbook

> 状态：实验 Runbook。本文覆盖仓库负责的 PC 桥接层；Open-XiaoAI checkout、音箱固件、SSH 权限和播放 hook 仍是环境依赖。

## 支持边界

```text
音箱侧 client 或兼容 server
  -> 可选 WebSocket / SSH 隧道
    -> PC 侧 Open-XiaoAI 兼容进程
      -> http://127.0.0.1:8798/v1/xiaoai/decision
        -> http://127.0.0.1:8791/webhook
          -> RabiRoute XiaoAI Route
```

仓库没有 vendoring Open-XiaoAI。请从[上游项目](https://github.com/idootop/open-xiaoai)单独获取并重新审查。

## 启动顺序

1. 在仓库根目录构建并启动 Manager。
2. 检查 `8791` 端口后启用默认禁用的 `xiaoai` Route。
3. 在 `127.0.0.1:8798` 启动本桥接层。
4. 启动外部 Open-XiaoAI 兼容 server 或 client 集成。
5. 只有直连不可用时才增加 SSH 反向隧道。

```powershell
npm run build
npm run start:manager
```

```powershell
cd plugin-adapters\xiaoai-rabiroute
$env:RABIROUTE_WEBHOOK_URL = "http://127.0.0.1:8791/webhook"
npm.cmd start
```

如果使用外部 Open-XiaoAI checkout，需要按该版本 API 调整 `open-xiaoai-migpt-rabiroute.config.ts`。当前文件还没有执行音箱打断和回复播放。

## 可选反向隧道

把 `xiaoai-local.config.example.json` 复制为被忽略的 `xiaoai-local.config.json`，只填写本机值。不要提交音箱地址或 SSH 密码。

```powershell
py -3 reverse-tunnel.py
```

常见布局会让音箱 client 连接 `ws://127.0.0.1:4399`，再转到 PC 的兼容 server。使用前必须核对 `reverse-tunnel.py` 和本地 JSON 的实际方向。

## 检查

```powershell
Get-NetTCPConnection -LocalPort 8790,8791,8798,4399 -ErrorAction SilentlyContinue
Invoke-RestMethod http://127.0.0.1:8798/health
```

```powershell
cd plugin-adapters\xiaoai-rabiroute
npm.cmd run smoke
```

随后检查 Route 转录日志和 Manager 状态。桥接 smoke 成功不代表 Desktop 任务已收到或完成 prompt。

## 打断规则

每个 decision 请求都会转给 RabiRoute。本地正则只决定原生 XiaoAI 是否继续：不匹配返回 `ignore`，匹配返回 `intercept`。

详细分诊应留在 Persona 和 Route policy。音箱端必须显式把 `intercept` 映射到自己的 abort API。

## 故障隔离

- `/health` 不可用：检查桥接进程和端口。
- decision 返回 `500`：检查 Webhook 与 Route 状态。
- 有转录但没有 Agent 工作：检查 Route 规则、Desktop 和目标任务是否已加载。
- 已返回 `intercept` 但原生 XiaoAI 继续：音箱配置尚未调用 abort API。
- `/speak` 返回 `202` 但没有声音：符合当前实现，播放仍是占位。
