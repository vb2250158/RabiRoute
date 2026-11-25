[English](agent-search-architecture_en.md) | 简体中文

# Agent 统一搜索

`GET /api/search` 汇总计划与记忆、消息记录、身份关系、会话情景、画面采集、角色 Skill、已注册操作以及可用设备的候选。来源由活动操作目录声明，每条结果提供原始读取或执行入口。

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

续页时保持过滤条件和页大小。消息端索引固定首次查询时已提交的消息前缀，后续追加在刷新后出现。角色会话消息的读取窗口或其他来源快照改变时，从首页重查。Manager 身份、角色范围、原消息前缀或归档布局实际变化也会返回 409。`expand` 尚未实现。`scripts/lib/query-rabi-search.mjs` 将一次发现、身份核对、请求和正文读取纳入同一调用预算，并从剩余预算中预留 20%（最多 500 毫秒）用于响应传输与正文读取，让慢来源到期时仍能收到其他来源的结果及覆盖缺口。

## 页面测试

在角色的“消息记录”页面，点击“全天记录”左侧的“搜索接口测试”。选择调用身份和搜索范围，输入关键词并选择来源后搜索；留空关键词可浏览。匹配方式、排序、页大小、搜索预算、调用方身份覆盖和完整 JSON 参数位于“高级设置”。弹窗关闭后再次打开会保留当前角色的条件与结果，切换角色后重新初始化。

调用身份使用当前角色或路由配置的主 Agent，作为请求元数据记录；搜索范围单独控制 `agent` 参数。主 Agent 缺少会话 ID 时，可在高级设置补充。请求沿用页面所属 Manager 的已鉴权连接。

“搜索结果”展示匹配词、来源、类型、角色和可用时间，可展开正文、读取真实详情、复制接口地址与调用参数。相邻同标题消息可展开全部原始记录。向下滚动接近结果底部时自动加载下一页，也可点击“加载更多结果”手动续页或重试。续页沿用上次查询条件和身份，条件修改后请重新搜索。新查询等待、失败或取消期间保留上次成功结果，并标明实际查询条件。

“来源状态”显示各来源完成情况及失败原因。“请求与返回”保留每页的实际参数、身份请求头、HTTP 状态、耗时、请求 ID 和完整返回，也保留本次失败回执。

## 理解结果

`capabilities` 表示当前声明的来源。`coverage.notQueried` 列出显式请求但未查询的来源，整体状态为 `partial`。`coverage.excluded` 列出被消息端或类型筛选排除的来源。`facets` 只统计当前页。来源失败时保留其他来源的可用结果。

角色「消息记录」中的时间轴汇总消息端、角色会话和画面采集。统一搜索的 `messages` 匹配消息端正文、发送者和目标，也搜索角色账本中的 Agent 间投递、角色面板、任务回复与 AIUI。角色账本每次读取最近至多 100 条，有更早记录时报告覆盖缺口。按 `adapter` 筛选时仅查询消息端，`includeArchives` 控制消息端归档。

`identities` 搜索角色已保存的参与者、消息端账号、关系卡片和声纹身份。`scenarios` 搜索保留的会话情景。`events` 搜索时间轴保存的画面采集，匹配标题、描述和采集设备，可从结果读取原图。

各条结果提供 `origin`、`detailUrl`、`handle` 和证据字段。`state`、`confidence`、`userConfirmed` 由来源依据决定；未知值不因搜索命中而变成确认事实。`observedAt` 是原观测时间，`retrievedAt` 是本次读取时间，`updatedAt` 是记录更新时间。使用 `handle` 读取原文或活动合同后再决定行动。

统一搜索复用原索引和设备服务，不建立新的权威数据副本。消息相关性排序一次读取全文索引候选集，避免按写入顺序逐条重复查询全文索引。普通消息时间线继续使用写入顺序查询。调用时各来源受同一截止和取消信号约束；大数据量、逐条小页和多来源会增加工作量，按任务需要选择适当页大小，并以实际环境测量性能。

旧版没有统一入口时，按已知角色使用 [计划与记忆摘要搜索](knowledge-search.md) 和 [消息检索索引](message-history-search.md)；仍不可用时记录实际错误并继续普通搜索。使用流程见 [搜索技能](../skills/rabi-knowledge-search/SKILL.md)。

### 搜索远程电脑

在 **RabiLink → 主页 → 已授权设备** 的卡片上，点击标签图标编辑别名和标签。别名作为卡片标题，原设备名在高级信息中保留。别名和标签由当前 Manager 按 RabiLink 应用和设备身份保存。

提到另一台电脑时，先用 Rabi CLI 执行 `--operation manager.search --query '{"scope":"devices","q":"设备名称或标签"}'`。这个来源也参与默认搜索和角色范围搜索。结果通过 `handle.deviceId` 和设备详情定位目标，相关操作提供终端和桌面入口。旧 Manager 缺少 `devices` 来源时，先用 Rabi CLI 查询已授权设备目录。

## 插件数据源与角色 Skill

接口发现直接提取插件 `ApiOperationDefinition.discovery`，统一搜索和专用接口目录共用字段、分词与排序。增加插件无需修改宿主业务关键词表。

插件若还要搜索自身记录，在原只读 operation 上声明 `contract.searchable` 的 `scope`、`legend`、`kinds`，并提供 `searchLanes({request, roles})`。每个 lane 从原拥有者读取 `items`、`version`、`complete` 与可选 `gaps`；原请求的取消信号和截止时间传入 `read`。宿主自动发现活动 reader，隔离故障来源，并随原 operation 卸载和等待在途读取结束。`searchable` 单独声明来源目录；没有 reader 时明确报告覆盖缺口。

`skills` 来源读取角色原技能目录，匹配名称、摘要和关键词，返回角色、skillId、详情地址及 `manager.personas.skills.detail` 合同。正文按需读取，不混入摘要，也不执行技能脚本。所有平台使用同一搜索协议。DSH 或其他人格插件已经加载相同技能时复用当前内容；这不关闭搜索，也不改变其他宿主取得目录和正文的方式。
