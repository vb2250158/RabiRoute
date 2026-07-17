<!-- docs-language-switch -->
<div align="center">
<a href="./README.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# XiaoAI RabiRoute 适配器

> 状态：实验集成。PC 侧转录与决策桥可运行；音箱端打断、播报、固件支持和真机验收尚未形成完整产品链路。

本目录提供低延迟 XiaoAI 桥接服务。它不会刷写音箱，也不是完整的 Open-XiaoAI server。

修改过的客户端或兼容 server 可以把识别文本提交给桥接层。桥接层会把每段转录转给 RabiRoute Webhook，再返回收窄后的本地 `ignore` 或 `intercept` 决策。

```text
修改过的 XiaoAI client 或兼容 server
  -> POST /v1/xiaoai/decision
    -> RabiRoute /webhook
      -> XiaoAI Route policy
        -> 命中后经 Desktop IPC 投递 Agent
```

`open-xiaoai-migpt-rabiroute.config.ts` 只是接入起点，不是可直接完成闭环的配置。它当前会提交转录，但没有调用音箱 Runtime 的打断或播放 API。

## 启动桥接层

先构建并启动 RabiRoute Manager，再检查端口并启用默认禁用的 `xiaoai` 示例 Route：

```powershell
npm run build
npm run start:manager
```

另开终端：

```powershell
cd plugin-adapters\xiaoai-rabiroute
$env:RABIROUTE_WEBHOOK_URL = "http://127.0.0.1:8791/webhook"
$env:XIAOAI_INTERCEPT_REGEX = "^(问\s*Rabi|让\s*Rabi|Rabi|找\s*Rabi|兔兔|问\s*兔兔)"
npm.cmd start
```

桥接层默认监听 `127.0.0.1:8798`。只有在确认网络边界后，才通过 `XIAOAI_BRIDGE_HOST` 和 `XIAOAI_BRIDGE_PORT` 修改监听地址。

## Smoke test

```powershell
cd plugin-adapters\xiaoai-rabiroute
npm.cmd run smoke
```

该测试只证明桥接层能返回决策并转发转录，不证明音箱打断、TTS 播放或 Codex 完成回复。

## API

- `GET /health`：返回配置、计数器和最近的占位 speak 请求。
- `POST /v1/xiaoai/transcript`：把转录作为带 XiaoAI 来源信息的 `voice_transcript` 转给 RabiRoute。
- `POST /v1/xiaoai/decision`：转发转录并按 `XIAOAI_INTERCEPT_REGEX` 返回 `ignore` 或 `intercept`。
- `POST /v1/xiaoai/speak`：当前只写入内存日志并返回 `202`，没有连接真实播放，重启后记录丢失。

音箱侧需要自行把 `intercept` 映射到 `abortXiaoAI()` 或等价能力。RabiRoute 不会直接调用音箱 Runtime。

## 相关文档

- [运维 Runbook](./RUNBOOK_zh.md)
- [LX06 刷机调查清单](./LX06-FLASH-CHECKLIST_zh.md)
- [XiaoAI 集成设计](../../docs/xiaoai-integration/xiaoai-rabiroute-intercept-route.md)
- [RabiRoute GitHub 仓库](https://github.com/vb2250158/RabiRoute)
