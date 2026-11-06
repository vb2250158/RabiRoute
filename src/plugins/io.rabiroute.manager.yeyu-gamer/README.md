<a href="./README_en.md">English</a> | 简体中文

# YeYu Gamer Manager 插件

该插件提供默认关闭的本机 YeYu Gamer 门面。目标固定为 `http://127.0.0.1:8877/api/v1`；只读 health、meta、snapshot、capabilities，并且只能创建 `mode: "plan"` 的 Agent work item。

插件配置归 Profile，不写入 `data/manager.json`。Bearer Token 只在读取受保护的 snapshot/capabilities 或创建 work item 时从本机 YeYu Gamer 运行目录读取，不进入 Profile、响应或日志。

五个公开接口通过同一份可执行合同安装并发布到 Agent 目录，原手工路由与 HTTP handler 已移除：

| 操作 | HTTP 接口 | 结果 |
| --- | --- | --- |
| `manager.yeyu-gamer.health.read` | `GET /api/agent/yeyu-gamer/health` | `200` 原生健康信息 |
| `manager.yeyu-gamer.meta.read` | `GET /api/agent/yeyu-gamer/meta` | `200` 原生实例信息 |
| `manager.yeyu-gamer.snapshot.read` | `GET /api/agent/yeyu-gamer/snapshot` | `200` 原生快照及 `stateVersion` |
| `manager.yeyu-gamer.capabilities.read` | `GET /api/agent/yeyu-gamer/capabilities` | `200` 原生能力目录 |
| `manager.yeyu-gamer.work-items.create` | `POST /api/agent/yeyu-gamer/work-items` | `202` 原生计划命令回执 |

成功正文为 `{code:0,data}`。响应 Schema 与原生客户端共用定义，保留上游扩展字段和原有可缺省字段。请求忽略未知查询字段；创建正文为 `workItem`、`idempotencyKey`、`expectedStateVersion` 和可选 `requestId`。原生拥有者固定 `mode: "plan"` 与 `requestedBy: "rabiroute"`，不把调用方提供的执行模式当成执行许可。

已鉴权且启用的远端连接可以使用这些公开接口，无额外功能许可。每个请求在读取正文前捕获原客户端和配置；读取凭据、实际提交和返回结果时复核原连接。配置变化不会把已接收请求转到新目标。HTTP 断开或插件退出会取消原请求，退出等待已接收任务结束；上游超时仍由原生配置控制。

新建计划前读取最新快照并使用其 `stateVersion`。保留原幂等键、完整正文、预期版本与原生回执的 `commandId` / `statusUrl`；本门面没有另一个回执查询接口。撤权时剥离业务数据，只返回执行阶段：`not_started` 表示尚未进入原生提交，`unknown` 表示已进入原生传输且结果需核对。`202` 不证明游戏已执行或通过验收；不确定时先向原生拥有者核对，不自动创建替代计划。

源码测试只使用隔离目录、生成的测试凭据和受控本机 HTTP 服务。真实游戏端口、用户游戏数据、安装版更新及双机执行没有在这些测试中验证。
