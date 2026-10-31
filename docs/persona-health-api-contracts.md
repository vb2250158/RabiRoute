[English](persona-health-api-contracts_en.md) | 简体中文

# 角色健康 API 的可执行合同

本组将原可穿戴健康配置、状态、历史、摘要和观测接口接入统一可执行分发。原 `wearableHealth` 存储继续拥有样本、策略、去重、状态与告警计算；告警投递仍交给原 Manager 路由。

| 操作 ID 后缀 | 方法 | 角色下路径 |
| --- | --- | --- |
| `summary.compat` | GET | `/:roleId/health` |
| `state` | GET | `/:roleId/health/state` |
| `history` | GET | `/:roleId/health/history` |
| `summary` | GET | `/:roleId/health/summary` |
| `config.read` | GET | `/:roleId/health/config` |
| `config.patch` | PATCH | `/:roleId/health/config` |
| `observations` | POST | `/:roleId/health/observations` |

每项保留 `/api/roles` 和 `/roles`，共 14 个具体路由。完整 ID 使用 `manager.personas.health.` 前缀；`/roles` ID 增加 `.alias`。原 `knowledge`、`knowledge-alias` 发现 ID 保留为别名。已鉴权空节点可以成功调用公开接口，权限不依赖角色、Route 或逐功能许可。

## 观测写入与代际

POST 保留原 Host 生命周期校验。调用者按当前动态地址读取 `/meta`，在观测请求携带 `x-rabiroute-expected-application-generation-id` 与 `x-rabiroute-expected-manager-instance-id`。缺少或格式不完整时返回 400，旧代际返回 409，没有 Host-owned generation 时返回 503；这些检查在消费正文前完成。读取接口不要求这两个观测写入头。

每次请求捕获当前角色目录、原鉴权连接与 Manager 身份，写入前及等待告警投递后复核。Host、目录或代际改变后不能继续写入或披露旧结果。生命周期校验绑定写入目标和代际，连接权限仍按统一规则执行。

## 原存储与告警

观测保留原顶层与 `health` 嵌套对象合并方式：嵌套字段覆盖顶层，policy/samples 保留原空值回退规则。样本与元数据规范化、近期 ID 窗口、重复样本、告警冷却和状态时效均由原 owner 处理。重试应保留原 event/sample ID，并按当前状态与历史回读核对。

历史查询保留重复或逗号分隔的 metric、设备、时间、limit 与顺序语义；未知 metric 按原行为忽略。`health` 兼容入口与 `health/summary` 使用同一原摘要实现。配置与观测正文保留生产入口原 `maxBytes=0`、空 `{}` 和原字段规范化，不额外收紧为功能许可。

仅当调用者显式设置 `deliverAlerts=1/true/yes` 且本次产生原生告警时，才调用既有投递 owner。样本先持久化，再等待投递；投递失败不删除已提交样本，并保留不确定标记。取消调用者也等待已接收的原投递结束，不重新 ingest 样本。202 表示观测处理结果，不能替代真实消息送达证据。

## 验证与范围

隔离验证覆盖 14 个路由的真实空节点鉴权、原配置/状态/历史/摘要及重放、写前 400/409/503、嵌套优先级、受控告警投递与失败回读、取消等待、动态目录与 Host 切换，以及原存储和告警投影回归。只写临时健康数据，告警使用受控 driver，不发送真实消息。

该组不改变角色生命周期、业务权限或健康存储格式。源代码验证不代表安装版或真实设备验收；其余 owner 的旧 prefix 入口按各自迁移结果处理。
