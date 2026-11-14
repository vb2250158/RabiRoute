<!-- docs-language-switch -->
<div align="center">
<a href="./README_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# RabiLink 主动智能 Route 模板

> 状态：实验集成。模板和本地代码入口已经存在，但仍需要真实 Relay、AIUI 设备和 Desktop 任务做环境验收。

这份 Route 与 `examples/data/roles/RabiActive` 配套，提供 record-first 眼镜观察、空闲/周期 Codex 审阅、触摸板引导和任务外主动下行的最小可迁移配置。

使用时把两个模板分别复制到运行数据目录：

```text
examples/data/route/RabiLink   -> data/route/RabiLink
examples/data/roles/RabiActive -> data/roles/RabiActive
```

模板默认禁用，避免首次复制整包示例时直接启动未配置的眼镜链路。先在 RibiWebGUI 的全局“Rabi 实例”中配置 Relay 地址、应用 token、PC 标识和“连接服务器”开关，再启用 `RabiLink`。Relay 凭据属于全局配置，不写入这份 Route 模板，也不要提交到仓库。

这条 Route 的 `rabilink` 输入策略允许 worker 接收 AIUI observation。observation 先写入 `RabiActive/rabilink-conversation.jsonl`，不会逐句直接投递 Codex；审阅器等待已绑定 Desktop 任务空闲，或在触摸板单击后启动/steer 审阅。

Codex 主动下行通过 `/api/agent/send` 使用精确 `routeId`、`channel=rabilink`，并在 `params` 中明确 `proactive=true`、目标设备和呈现方式；它与上行 observation 使用独立队列。真实 prompt 只有 Desktop IPC 一个 owner；目标任务未加载时失败关闭。


模板中的自有监听端口为 `0`，启动时由系统分配；调用方使用当前 Route 状态或 API 发现公布的实际地址，不把配置中的 `0` 拼进请求 URL。显式配置的外部服务地址仍由其原服务管理。
