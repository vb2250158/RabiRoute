[English](message-query_en.md) | [简体中文](message-query.md)

# 消息查询：先 Rabi，失败后再绕过

适用于“看看群”“看群聊记录”“查最新反馈”及群聊、私聊历史检索。只读查询无需重复审批；不得变成发送、消息重放、服务重启或配置修改。

## 发现与查询

1. 从用户原话和附件提取对象、主题、平台及少量同义词，结合当前任务注入、项目配置或已知绑定确定 `roleId`、Route、群/私聊和时间范围。第一轮业务查询先搜索消息历史及相关计划、记忆，再按命中线索查文件；需要加载技能或发现连接时只做这些必要准备。角色已知时不列 Agent 会话，不先查插件文件来猜接口。仅关键目标仍无法确定时询问，不枚举无关账号和群。
2. 优先使用宿主提供的受管 Manager GET 入口；若它已负责 Host 发现及逐次 `/meta` 核验，无需另发健康探针。其他调用入口通过 `RabiRouteHost.exe --command status --json` 取得 `managerBaseUrl`、`applicationGenerationId` 和 `managerInstanceId`；源码模式使用当前 Manager 输出的结构化 READY 地址；外部调用可显式提供当前完整 URL。读取 `<managerBaseUrl>/meta`，要求 `health.live=true`、`health.requiredReady=true`、`health.state` 为 `healthy` 或 `degraded` 并核对 generation 与实例身份；目标接口判断自身依赖是否可用。generation 改变后重新发现，不缓存旧 URL，不扫描端口、不读取退役实例锁、不直接启动或结束 Manager。
3. Hook 的“Host 未运行”汇总提示不等于本轮状态查询证据。区分程序未找到、状态超时、解析失败、未 READY、鉴权和连接故障。旧地址或瞬时失败时重新发现并作一次有界重试，不无限重试。
4. 消息全文搜索使用 `GET /api/roles/{roleId}/message-endpoint-history?query={关键词}&match=any&includeArchives=1&limit=10`。路径参数和查询参数 URL 编码；`query` 支持空格、英文逗号、中文逗号、顿号分隔，`match=all` 要求全部命中。按已知目标补充 `adapter`、`target`、`conversationKey`、`from`、`to`。查已有答案时保留出站回复；仅查用户原始群反馈时加 `kind=group`，私聊反馈加 `kind=private`。返回 `entries`、`count`、`coverage`，核对消息时间、消息 ID、回复 ID、会话与方向，不能把机器人答复当作用户反馈。
5. 涉及项目事实、历史决定或任务归属时，同时使用 `GET /api/roles/{roleId}/knowledge/search?query={关键词}&mode=keywords&limit=10` 搜索计划、近期记忆和沉淀记忆。两个查询互不依赖时并行执行；关键词无适当命中时可用 `mode=fulltext`，历史事项按需加 `archived=1`。只读必要的 `detailUrl`，计划命中后核对状态及原 `taskBinding`。只说明实际覆盖范围，不把知识索引命中当成群消息命中。
6. `GET /api/gateways` 只用于必要的 Route 诊断，近期摘要不能代替历史搜索；`GET /api/roles/{roleId}/chat-history` 存的是 Agent 最终回复，也不能代替消息端历史。宿主工具拒绝诊断路径时，仍使用已允许的 `/api/roles/{roleId}/message-endpoint-history`，不反复试路径或扫描安装包。404、超时、503 或覆盖不足按下节降级；接口字段有冲突时才核对当前 Rabi 的 `docs/rabi-agent-interfaces.md`。空结果先核对目标、归档和时间覆盖，不证明群里没有消息。

## 受控绕过

- 动态发现及有界重试仍失败、接口不可用，或已核对接口无法覆盖所需历史时，才绕过。成功且完整的空结果不触发连接故障降级；摘要窗口不足属于能力不足。鉴权拒绝不得靠旁路逃避权限；独立本地读取必须已有授权及访问权限。
- Rabi 可用时，从当前 Route 绑定和状态定位 NapCat；Rabi 不可用时，只用当前任务明确提供的连接、当前运行实例配置或已确认的正式日志位置。配置文件存在不代表实例在线。
- 不从旧任务、记忆、安装残留或示例端口选择账号，不逐个尝试历史账号。直连前通过当前配置的 `get_status`、`get_login_info` 核对在线状态和账号身份，再用只读 `get_group_msg_history`、`get_msg` 查询指定目标。凭据只在请求中使用，不回显；身份不符则停止该连接查询。
- 本地日志只读目标 Route/人格、群/私聊及时间范围，核对消息时间与覆盖范围，不把旧存档说成实时记录。缺少可信当前来源时，报告具体缺口，不猜地址。
- 结果保留来源、目标、消息 ID、时间及覆盖范围。绕过时简短说明 Rabi 失败或能力不足的原因及实际来源；区分“连接失败”“查到零条”“历史未覆盖”。下一次独立查询仍从 Rabi 开始，不把旁路变成默认入口。
