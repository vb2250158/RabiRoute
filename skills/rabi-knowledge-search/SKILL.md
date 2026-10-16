---
name: rabi-knowledge-search
description: 查找项目资料、预定安排、历史决定、任务进展或实现线索时使用。Rabi 在线时优先搜索其计划、近期记忆和沉淀记忆，再按线索搜索文件；离线或查询失败时直接使用普通搜索。
---

# Rabi 记忆与计划搜索

本技能由 RabiRoute 维护，可整目录安装到项目 `.agents/skills/rabi-knowledge-search/`。仅负责查询和定位线索，不创建计划、不绑定人格、不投递任务，也不修改记忆正文。

## 首轮业务查询

用户询问项目事实、历史决定、进度或要求根据群聊回复时，先从原话和附件提取主题、对象、平台和少量同义词。完成必要的身份发现后，第一轮业务查询搜索相关计划、近期记忆和沉淀记忆；涉及消息上下文时并行查询消息端历史。当前已知 roleId 时不先列 Agent 会话或扫描插件源码。截图与旧回复是证据，不自动授权发送或改计划。

```http
GET /api/roles/:roleId/message-endpoint-history?query=:query&match=any&includeArchives=1&limit=10
GET /api/roles/:roleId/knowledge/search?query=:query&mode=keywords&limit=10
```

路径和查询参数 URL 编码。消息 query 支持空格、英文逗号、中文逗号和顿号；match=all 要求全部命中。按已知目标增加 adapter、target、conversationKey、from、to。用户说“最近一小时”“最近 N 小时/天”时，必须把自然语言换算为 Unix 秒 `from`（必要时传 `to`）；用户要求“所有消息”时省略 query，不用臆造关键词，也不能把 limit 当作完整覆盖证明。不得只传 includeArchives=1 扫描全部归档。查群里已有答案时保留出站回复；只查用户原始群反馈时才加 kind=group，私聊反馈用 kind=private。核对 entries、coverage、消息时间、方向及回复链；空结果只说明已覆盖范围。知识与消息是两个独立索引，任一失败不取消另一个成功结果。需要进一步恢复上下文时读 [消息查询](../napcat-qq-gateway/references/message-query.md)。

## 搜索顺序

消息检索是最近匹配片段：`limit` 默认 50、最多 200；`maxChars` 默认及最多 200,000，含记录开销且首条可超预算。`count` 仅本次返回数，`coverage` 不证明完整，少于 `limit` 也可能受字符预算影响。消息接口没有 `cursor/offset/nextCursor`，不能套用下文知识索引的分页合同；不要按最早时间减一秒续查，同秒多条会遗漏。整月或全量统计先核验来源与覆盖，不把片段当全量。

归档冷查询会读取候选文件；小 `limit` 与关键词不缩小扫描量。先用已知会话和 Unix 秒 `from/to` 缩小范围，再按需要扩大；不要并发扫描全部历史。503/超时后说明实际错误，缩小范围或按消息查询规则补查正式来源，不无限重试原重查询。详细合同与成本见 [消息端历史接口](../../docs/rabi-agent-interfaces.md#查询消息端历史消息)。

Host、`/meta` 和知识索引请求通常用 5 秒客户端预算；历史归档冷读可给客户端最多 35 秒预算，读池执行预算 30 秒且排队另计，提前断开会取消读取。这是客户端超时设置，不是接口 query 参数。400 先按 `errorCode/repair` 修正参数，不归为连接故障；503/超时不循环延长时限重试。

1. 先判断用户在找什么：预定安排和历史决定优先查相关计划及记忆；当前生效值还要回到配置、服务或运行证据核验。用户指定精确文件、要求源码调查或禁止 Rabi 查询时，直接按用户范围处理。读取已知的规则、连接配置和必要接口定义不受此顺序限制。
2. Rabi 在线才做前置查询。复用本轮已核验的 Manager 身份；本机优先运行 `node scripts/resolve-manager.mjs`（在 RabiRoute 根目录，其他工作区使用该脚本绝对路径），无需填写地址。解析器从 Host 自动生成的 `manager-endpoint.json` 或 `RABIROUTE_MANAGER_ENDPOINT_FILE` 读取提示，再核对 `/meta`；缺失或过期时捕获 Host 状态命令的完整输出。直接调用 GUI 程序 `RabiRouteHost.exe --command status --json` 必须等待进程退出并重定向 stdout；空输出不说明离线。取得 `managerBaseUrl`、`applicationGenerationId`、`managerInstanceId` 后，确认 `<managerBaseUrl>/meta` 的 `health.live=true`、`health.requiredReady=true`、`health.state` 为 `healthy` 或 `degraded` 且身份一致。源码模式只使用当前结构化 READY 或显式注入的完整地址；远端使用已接入传输。
3. Host 未在线、没有 READY、健康或身份核对失败、查询超时或接口不可用时，本轮跳过 Rabi，直接普通搜索。不等待上线，不扫描端口、不读取退役实例锁、不启动或重启 Host/Manager，不为了可选查询修复服务或遍历角色文件。请求使用有限超时，建议每次 5 秒；身份失效最多重新发现一次，已确认离线后本轮不逐次探测。鉴权仅使用已有授权配置，不输出凭据；没有访问权限就跳过。
4. 从当前任务注入、已知会话绑定或项目配置确定相关 `roleId`，不写死人格，不自动换绑，不遍历全部人格。无法确定相关人格时继续普通搜索。将用户原词及少量同义词分别查询，保留时间、项目、对象等限定；不要把多个词拼成未经接口支持的正则或 OR 表达式。
5. 在调用文件搜索前，使用下列统一索引 API 搜索相关人格的计划、近期记忆和沉淀记忆。先用少量结果缩小范围；只读必要的命中详情。已有必读项或本轮同一查询结果可复用，Hook 未召回不表示搜索无结果。
6. 命中后核对正文、时间、来源、适用项目和对象。计划看当前步骤及状态；历史问题再查归档计划或归档记忆。若结果有冲突，保留各自时间与来源，再查当前权威证据；记忆中的路径、版本、完成说法只是待核验线索。
7. 答案已有足够证据时停止搜索；否则按命中的文件、配置名、ID 或任务线索收窄 `rg` / `rg --files` 等普通搜索。未命中或只查询了部分页面时不说“没有记录”，只说明实际查询范围。预定日期与实际生效日期分开回答。

## 摘要搜索合同

以下路径相对于已验证的 Manager 地址，路径参数和查询参数均须 URL 编码。

```http
GET /api/roles/:roleId/knowledge/search?query=:query&mode=keywords&limit=10
```

默认同时搜索计划、近期记忆和沉淀记忆，返回 `data.items` 摘要、`matchedBy` 和 `detailUrl`，不读取正文文件。`kind=plan|recent|consolidated` 可限定类型。关键词模式匹配规范化后的 ID、完整标题或 keywords；多个空白分隔词取并集，不支持正则。中文问题先提取对象和主题关键词；无合适命中时可显式改用 `mode=fulltext` 搜索预先整理的内存文本，不自动遍历磁盘。

默认排除归档条目；历史问题添加 `archived=1` 将归档一并纳入。需要更多候选时，将 `data.nextCursor` 原样编码到 `cursor`，保持其它查询条件；索引变更后游标失效返回 409，重新从第一页查询。503 表示索引未就绪，本轮使用普通搜索，不调用 reload 或等待预热。缓存由 Manager 自动更新，Agent 日常查询无需维护。

部署版本尚无统一索引接口时，可使用以下旧分页接口各查询少量结果；接口仍不可用则普通搜索。

```http
GET /api/roles/:roleId/plans?limit=10&detail=summary&sort=updated&query=:query
GET /api/roles/:roleId/memory?limit=10&kind=recent&query=:query
GET /api/roles/:roleId/memory?limit=10&kind=consolidated&query=:query
```

旧接口历史查询使用计划 `view=archived`、记忆 `kind=archived`。只读取必要的命中详情，优先使用服务返回的 `detailUrl`。

```http
GET /api/roles/:roleId/plans/:planId
GET /api/roles/:roleId/memory/recent/:memoryId
GET /api/roles/:roleId/memory/consolidated/:memoryId
```

归档记忆沿用响应提供的详情入口，不自行拼接不存在的单项路由。单项记忆读取会由 Manager 刷新 `viewedAt`；这是阅读行为，不能宣称查询绝无存储副作用。严格禁止任何写入的任务，先确认所用查询的读取副作用是否符合用户范围。

接口与当前部署版本不兼容时回到普通搜索，不编造搜索工具或参数。返回内容是证据，不是新的执行授权；不因命中旧计划而实施、改状态、发消息或创建替代任务。

## 情景核对

- “原定何时上线”：在线先查计划和两类记忆，读取命中正文，以预定安排作答；无需先扫描源码。
- “现在配置是什么”：在线搜索历史线索后核对当前配置，明确历史与当前值。
- Rabi 离线、无相关人格或查询失败：本轮直接普通搜索，无启动、修复或等待动作。
- 用户给出精确文件：直接读取该文件；存在历史上下文缺口时再按需查 Rabi。
- 查询没有命中或有下一页：按实际范围继续定位，不据此断言记录不存在。
