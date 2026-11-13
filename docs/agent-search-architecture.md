[English](agent-search-architecture_en.md) | 简体中文

# Agent 统一搜索

`GET /api/search` 汇总计划与记忆、聊天记录、已注册操作以及可用设备实体的候选。来源由活动操作目录声明，实际数据仍由各自的知识、消息、操作目录和设备拥有者读取；搜索不会替代它们的详情或执行合同。

## 使用

本机先运行 `node scripts/resolve-manager.mjs` 并核对 `/meta` 身份；远端使用已有的鉴权连接。向当前 Manager 发起 `GET /api/search?q=<编码后的关键词>`。也可通过 MCP `rabi_search` 发现 `manager.search`、`rabi_describe` 查看合同，再用 `rabi_call` 调用，或使用 CLI `--operation manager.search`。调用方身份头是可选元数据，不是鉴权凭据；原连接权限和用户配置仍然生效。

| 参数 | 用途 |
| --- | --- |
| `q` | 关键词；省略时浏览 |
| `scope`、`kind` | 按响应的 `capabilities` 和 `legend` 选择来源与类型 |
| `agent`、`adapter` | 可选角色或消息端；角色不存在时返回 `AGENT_NOT_FOUND` |
| `from`、`to` | 观测时间的 Unix 秒范围 |
| `match`、`mode`、`strict` | 关键词匹配、搜索模式和严格范围 |
| `limit`、`cursor` | 每页 1–200 项，默认 20；续页使用原样返回的 `nextCursor` |
| `sort`、`includeArchives`、`budgetMs` | 排序、消息归档范围及本次剩余预算 |

续页时保持过滤条件和页大小；Manager 身份、角色范围或来源版本变化会使游标失效，按 409 从首页重查。`expand` 尚未实现。`scripts/lib/query-rabi-search.mjs` 将一次发现、身份核对、请求和正文读取纳入同一调用预算。

## 理解结果

`capabilities` 表示当前声明的来源，`coverage`、`degraded` 和 `notQueried` 表示实际覆盖与缺口；`facets` 只统计当前页。来源失败时保留其他来源的可用结果。没有命中只说明已覆盖范围内没有匹配，不能证明未覆盖的数据不存在。

各条结果提供 `origin`、`detailUrl`、`handle` 和证据字段。`state`、`confidence`、`userConfirmed` 由来源依据决定；未知值不因搜索命中而变成确认事实。`observedAt` 是原观测时间，`retrievedAt` 是本次读取时间，`updatedAt` 是记录更新时间。使用 `handle` 读取原文或活动合同后再决定行动。

统一搜索复用原索引和设备服务，不建立新的权威数据副本。调用时各来源受同一截止和取消信号约束；大数据量、逐条小页和多来源会增加工作量，按任务需要选择适当页大小，并以实际环境测量性能。

旧版没有统一入口时，按已知角色使用 [计划与记忆摘要搜索](knowledge-search.md) 和 [消息检索索引](message-history-search.md)；仍不可用时记录实际错误并继续普通搜索。使用流程见 [搜索技能](../skills/rabi-knowledge-search/SKILL.md)。
