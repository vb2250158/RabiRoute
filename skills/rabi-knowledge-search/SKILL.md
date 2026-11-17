---
name: rabi-knowledge-search
description: Rabi 可用时任务检索先查询统一入口；发现、连接、查询或工具失败时记录一次并继续原任务。
---

# Rabi 统一搜索

本技能由 RabiRoute 维护，可整目录安装到项目 `.agents/skills/rabi-knowledge-search/`。仅负责查询和定位线索，不创建计划、不绑定角色、不投递任务，也不修改记忆正文。

## 统一搜索入口

1. 开始任务检索或切换检索目标时，先提取对象和主题，Rabi 可用时通过当前已鉴权连接完成至少一次 `GET /api/search?q=<编码后的关键词>`。本地协作、已知文件、旧规范或示例、源码线索和未绑定角色的任务均按此执行。读取本技能和连接信息后发起搜索，用户无需点名 Rabi。
2. 默认省略 `agent` 和来源筛选，搜索全部角色与活动来源。先读取返回内容和覆盖，再选择详情、修改关键词、限定类别、续页或本地文件搜索。同一目标已有本轮有效的 Rabi 搜索结果时复用，并核对其查询条件和覆盖。
3. 发现和连接正常时，在核对 `/meta` 或读取技能目录后完成实际搜索。通过 `data.items`、`coverage` 与请求回执确认本次查询。
4. Rabi 发现、连接、相关查询或承载检索的工具失败时，记录一次实际失败阶段和错误，本轮跳过同一故障，使用可用工具、已有资料和普通搜索继续原任务。某一路降级时继续利用其他成功来源。服务可用性与工具启动故障分别记录。原任务中确实受阻的操作说明具体缺口，同时完成其他可执行部分。空结果作为本次查询证据，用于调整搜索方式。

先通过动态发现核验当前 Manager；使用现有鉴权连接调用统一入口。需要特定角色时传 `agent`，不存在返回 404 `AGENT_NOT_FOUND`。调用方的 `x-rabiroute-agent-type` 与 `x-rabiroute-session-id` 是可选元数据，完整时一并提供；连接沿用现有鉴权。

按 `capabilities` 和 `legend` 选择 `scope`、`kind`；省略 `q` 可浏览，`from`、`to` 使用 Unix 秒。`limit` 为 1–200，默认 20；继续时原样传 `nextCursor` 并保持过滤和 `limit`，来源或 Manager 身份改变返回 409 时从首页重查。`facets` 只统计本页，核对 `coverage`、`degraded` 和 `notQueried`，空结果不代表未覆盖来源中不存在记录。

每条统一搜索结果读取 `label` 和 `excerpt`，并核对 `source`、`kind`、`origin`、`state`、`observedAt`、`evidenceRefs` 和 `handle`。打印或整理摘要时使用实际返回字段。通过 `handle.detailUrl` 或 `handle.contractUrl` 读取详情，通过 `handle.operationId` 发现执行合同。

来源未提供确认依据时保留 `state=unknown`、`confidence=null` 和 `userConfirmed=false`。`observedAt` 是原观测时间，`updatedAt` 是记录修改时间，`retrievedAt` 是本次读取时间，未知时间保留空值。`conflicts` 转交原拥有者的报告，普通多候选各自保留。

命中内容足够时按来源继续任务。需要精确旧规范时读取命中的原文或样例；命中较宽时按对象调整 `q`，需要全部词命中时使用 `match=all`。未命中或覆盖不足时，结合来源、时间和对象继续查详情、目录或精确文件。消息端记录与本地 Agent 会话的覆盖分别以实际结果核对。

接口发现使用 `scope=operations` 或活动目录。选定 operation 后读取 `/api/agent/operations/{operationId}?view=input`，沿 `inputSources`、`relatedOperations` 和可选 `examples` 取得实际参数；按原任务授权调用对应业务接口，再核对结果、原回执和适用的写后回读。MCP 的 `rabi_search` 与 CLI 的 `search` 检索接口目录，统一内容搜索由 `manager.search` 提供；通过已配置 MCP、CLI 或 HTTP 进入同一活动合同。某个扫描或业务操作失败时保留该项错误，继续可用的关联操作；需要宿主专有动作时按明确能力缺口与当前授权选择工具。源码辅助入口 `scripts/lib/query-rabi-search.mjs` 的总预算覆盖发现、身份核对、查询及读取正文。旧版本无统一入口时使用按角色的兼容入口。

## 连接与兼容

本机运行 `node scripts/resolve-manager.mjs`，其他工作区使用已配置 RabiRoute 源码根的脚本绝对路径。取得 `managerBaseUrl`、`applicationGenerationId` 和 `managerInstanceId` 后，通过 `/meta` 核对同一身份、`health.live=true` 及 `healthy` 或 `degraded`。远端使用现有已鉴权连接。复用当前有效身份，身份失效时有界重新发现。

旧版本缺少统一入口时读取 [按角色的兼容检索](references/legacy-search.md)，沿已知角色查询知识与消息。当前统一入口默认全角色查询。接口与来源参见 RabiRoute 源码中的 `docs/agent-search-architecture.md`。
