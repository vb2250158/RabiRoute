<!-- docs-language-switch -->
<div align="center">
<a href="./yeyu-gamer-manager-integration_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# YeYu Gamer Manager 本机接入

状态：**实验集成**。RabiRoute 的类型化客户端、Manager 本机门面和单元测试已经落地；YeYu Gamer Manager 的正式安装与本机联调仍需单独验收。该模块默认关闭，不会在安装 RabiRoute 后自行启动游戏或旧自动化脚本。

## 边界

RabiRoute 只连接固定地址 `http://127.0.0.1:8877/api/v1`，并只使用五个 YeYu Gamer Manager 接口：

| 方法 | YeYu Gamer Manager 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/health` | 读取健康状态。 |
| `GET` | `/meta` | 读取版本与宿主策略。 |
| `GET` | `/snapshot` | 读取状态快照和 `stateVersion`。 |
| `GET` | `/capabilities` | 读取能力目录；不调用能力。 |
| `POST` | `/agent/work-items` | 创建 `mode: "plan"` 的 Agent work item。 |

这个接入不是通用 HTTP、Shell、路径或点击执行器，也不是完整 `AgentAdapterType`。它没有 claim、decision 或 capability invocation 方法；不能读取旧 `daily-gui-config.json`、`game-automation-policy.json`，也不能调用旧桌面程序或脚本。`POST /agent/work-items` 只记录可复核的计划项，不能代表游戏已经启动或完成。

## 配置

YeYu Gamer 接入是独立的 `io.rabiroute.manager.yeyu-gamer` 插件。启用状态与配置都归当前插件 Profile；默认发行 Profile 已包含该实例，但实例 `enabled` 为 `false`：

```json
{
  "id": "manager:yeyu-gamer",
  "package": "io.rabiroute.manager.yeyu-gamer",
  "version": "1.0.0",
  "enabled": false,
  "config": {
    "baseUrl": "http://127.0.0.1:8877/api/v1",
    "requestTimeoutMs": 3000
  },
  "grants": []
}
```

源码构建修改 `plugins/profiles/desktop.json`；已安装环境应复制发行 Profile 到本机配置目录，通过 `RABIROUTE_PLUGIN_PROFILE` 选择该副本，不直接改构建产物。完整字段约束见 [`examples/schemas/yeyu-gamer-manager-config.schema.json`](../examples/schemas/yeyu-gamer-manager-config.schema.json)。`baseUrl` 不能改成其他地址；Windows 默认运行目录是 `%PROGRAMDATA%\YeYuGamer\runtime`。只有 YeYu Gamer 安装在另一个本机目录时才配置绝对的本机 `runtimeDir`，UNC/SMB 路径会被拒绝。

YeYu Gamer Manager 首次启动后生成 `secrets\actors\rabiroute.token`。RabiRoute 在读取受保护的 snapshot/capabilities 以及派发 work item 时才读取这个文件，并把它作为 Bearer credential 发给 8877；health/meta 保持无凭据探测。不要把 Token 内容复制到 Profile、日志、文档或请求正文。文件缺失或格式不合法时，受保护调用会失败关闭。

启用时只把这个实例的 `enabled` 改为 `true`，不要另加第二个业务开关。修改 Profile 后可调用插件 reconciliation 热替换该实例；正式运行仍应从本机安装目录启动，不能从 NAS 源码目录直接运行。

## RabiRoute 本机门面

RabiRoute Manager 仅向 loopback 调用方登记这些路径：

```http
GET /api/agent/yeyu-gamer/health
GET /api/agent/yeyu-gamer/meta
GET /api/agent/yeyu-gamer/snapshot
GET /api/agent/yeyu-gamer/capabilities
POST /api/agent/yeyu-gamer/work-items
```

GET 返回 RabiRoute 标准包络：

```json
{
  "code": 0,
  "data": {
    "stateVersion": 42
  }
}
```

派发前先读最新 snapshot，再把 `data.stateVersion` 放进 `expectedStateVersion`。同一个逻辑请求重试时必须复用稳定的 `idempotencyKey`：

```json
{
  "workItem": {
    "kind": "run_game",
    "gameId": "ZZZ",
    "cadence": "daily",
    "note": "创建一条等待 Agent 复核的每日计划项。"
  },
  "idempotencyKey": "route-event-opaque-id",
  "expectedStateVersion": 42,
  "requestId": "optional-correlation-id"
}
```

客户端会固定补入 `mode: "plan"` 和 `requestedBy: "rabiroute"`。成功响应是 `202`，`data` 为 YeYu Gamer 的 command receipt；回执证明 Manager 已受理记录，不是执行完成证据。

## 无游戏启动的验收

启用前可以只做只读检查：

1. 确认 YeYu Gamer Manager 已在本机 8877 运行，并已生成 `rabiroute.token`。
2. 启用配置并重启 RabiRoute Manager。
3. 依次读取 RabiRoute 门面的 `health`、`meta`、`snapshot` 和 `capabilities`。
4. 如果需要验证写入合同，只派发 `kind: "observation"` 的计划项，并检查 `202` 回执；不要 claim，不要调用 capability invocation，也不要把回执当作游戏结果。

禁用时，格式有效的门面调用会以 `yeyu_gamer_disabled` 失败关闭，不会向 8877 发请求。
