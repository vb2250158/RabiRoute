<!-- docs-language-switch -->
<div align="center">
<a href="./performance-monitoring_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# 常驻性能记录与查看

> 受众：本机运维人员和项目维护者。用于保留最近一段时间的性能证据，定位 Manager、Gateway 或浏览器界面中的持续变慢、内存增长和慢请求。

## 开启和查看

1. 打开 RibiWebGUI，进入“性能监控”。
2. 打开“开启性能记录”，设置采样间隔、保留时间、最大空间和慢操作阈值。
3. 保存后，Manager 和当前浏览器立即按新配置采集。已启动的 Gateway 最迟在 30 秒内读取新配置。
4. 页面显示 CPU、内存、垃圾回收、接口 P95、事件循环延迟、内部阶段热点、接口热点、采集器状态和最近 JSON 记录。

该功能默认关闭。关闭后不再新增记录，已有文件仍按保留时间和最大空间清理。

性能页直接读取 Manager 内存中的有界数据：最近原始记录最多保留 1000 条且合计不超过 16 MB；趋势使用 10 秒、1 分钟和 5 分钟的增量汇总，最长覆盖 48 小时。尚未写入 JSONL 的样本也会立即显示。720 小时保留只影响磁盘文件，不会让 Manager 恢复或常驻全部原始样本。

## 文件位置和格式

性能记录与普通运行日志分开保存在：

```text
data/.runtime/performance/performance-YYYY-MM-DD-HH.jsonl
```

每小时一个文件，每行一个完整 JSON 对象。文件属于本机运行数据，不提交到仓库。示例：

```json
{"schemaVersion":1,"kind":"performance_sample","sampleId":"...","time":"2026-08-17T08:00:00.000Z","intervalMs":5000,"source":{"kind":"manager","id":"manager","runtimeId":"...","pid":1234},"system":{"cpuPercent":4.2,"rssBytes":146800640,"heapUsedBytes":73400320,"heapTotalBytes":94371840,"externalBytes":2097152,"eventLoopP50Ms":10.1,"eventLoopP95Ms":12.6,"eventLoopMaxMs":18.4,"eventLoopUtilization":0.03,"gcCount":1,"gcDurationMs":2.4,"gcMaxMs":2.4},"http":{"operation":"all","count":21,"errorCount":0,"totalMs":146.2,"p50Ms":4.8,"p95Ms":31.2,"maxMs":46.7,"totalBytes":482100,"operations":[]},"operations":[{"operation":"manager.http.json_serialize","count":21,"errorCount":0,"totalMs":18.6,"p50Ms":0.4,"p95Ms":3.1,"maxMs":4.2}]}
```

`source.kind` 的取值：

- `manager`：Manager 进程的 CPU、内存、事件循环和 HTTP 请求。
- `gateway`：每个 Gateway 进程的 CPU、内存、事件循环和 HTTP 请求。
- `webgui`：已打开页面的 Manager API 耗时、导航耗时和浏览器长任务。

`operations` 记录低基数的内部阶段，不写任务 ID、角色 ID或消息 ID。当前覆盖：

- Manager：元信息和 Gateway 状态构建、JSON 序列化、计划目录缓存/刷新、只读 Worker 排队与执行、Agent 扫描中的 Desktop 就绪与任务目录阶段、消息看板摘要/写入、RabiSpeech 状态查询合并及健康与能力探测、性能汇总。
- Gateway：路由判断、AgentPacket 构建、消息登记、Agent 投递和完整转发。
- 通用运行路径：JSONL 历史追加，以及语音/飞书消息去重时的历史文件扫描。
- WebGUI：路由切换到页面完成两帧绘制的耗时。

页面按累计耗时排列内部阶段和接口。接口同时显示累计响应字节，可区分“计算慢”和“返回数据过大”。记录器自身的追加、汇总、写文件和清理耗时单独显示，避免性能工具掩盖自身开销。

`/api/events` 和 `/api/speech/events` 是持续保持连接的事件流，不计入接口耗时、P95 和慢请求；它们的连接时长不代表 Manager 处理变慢。页面顶部的 Manager 指标读取最近上报的 Manager 运行实例，重启前的历史实例只保留在时间图和明细中。

## 优先检查的性能风险

| 现象 | 先看埋点 | 常见原因 |
| --- | --- | --- |
| `/gateways` 或 `/api/gateways` 变慢 | `manager.gateways.build_*`、`manager.http.json_serialize`、接口累计字节 | 状态构建读取的诊断信息增多，或响应对象过大 |
| 语音记录、冲突检查偶发排队 | `manager.read_worker.queue_wait.*`、`manager.read_worker.execute.*` | Worker 并发已满、单次目录扫描或解析耗时增长 |
| Agent 扫描很慢 | `manager.agent_scan.desktop_ready`、`manager.agent_scan.codex_catalog`、`manager.read_worker.*.agent_scan`、`/api/scan/agents` 响应字节 | Desktop 就绪检查或任务目录服务变慢；任务目录阶段最多等待 8 秒，超时后页面继续加载并显示可重试提示 |
| 近期记忆读取很慢 | `manager.read_worker.*.role_memory_*` | 记忆目录较大；枚举、Markdown/JSON 解析和 `viewedAt` 写入都在 Worker 中执行 |
| 消息看板响应过大 | `manager.message_board.summary`、`/api/message-processing/board` 响应字节 | 列表只返回界面所需摘要；完整证据按需求详情接口读取 |
| 语音状态首次查询慢 | `manager.speech.status.cache_hit`、`manager.speech.status.shared_flight`、`manager.speech.probe.health`、`manager.speech.probe.capabilities` | RabiSpeech 冷态健康检查或模型能力发现耗时；并发查询共用一次探测，紧邻查询复用 500 ms 状态结果 |
| 计划页首次打开慢 | `manager.plan_catalog.cold_load`、`manager.plan_catalog.refresh`、`manager.plan_catalog.cache_hit` | 冷启动需要枚举并解析计划文件，或文件变更频繁导致刷新 |
| 消息处理时事件循环出现尖峰 | `runtime.history.append`、`runtime.history.duplicate_scan`、事件循环 P95 | 同步 JSONL 写入，或去重逻辑扫描持续增长的历史文件 |
| 消息已经路由但回复迟迟未到 | `gateway.forward.message_register`、`gateway.forward.agent_deliver.*`、`gateway.forward.total` | Manager 登记、Desktop/Agent 投递或外部处理端等待 |
| 页面切换卡顿 | `webgui.route_render.*`、浏览器长任务、JS 堆内存 | 页面组件绘制量大、主线程长任务或浏览器内存压力 |
| 所有接口同时短暂变慢 | 垃圾回收耗时、事件循环 P95、CPU | GC、CPU 争用或同步阶段阻塞主线程 |

判断时先比较同一时间段的接口、内部阶段、事件循环和 GC。只有接口变慢而内部阶段正常时，再检查网络、浏览器或调用端等待。

请求路径会在写入前删除查询参数，并把常见动态 ID 替换为占位符，避免按具体任务或消息生成大量不同的指标名称。性能文件仍可能反映接口名称、进程 ID 和本机运行时间，分享前应按诊断材料处理。

## 配置范围

| 设置 | 范围 | 默认值 |
| --- | --- | --- |
| 采样间隔 | 1–60 秒 | 5 秒 |
| 保留时间 | 1–720 小时 | 48 小时 |
| 最大空间 | 16–4096 MB | 256 MB |
| 慢操作阈值 | 100–120000 毫秒 | 2000 毫秒 |

Manager 每小时检查过期文件和空间上限。达到空间上限时，先删除最旧的性能文件。内存另外限制为每层最多 20000 个时间桶和 50000 个操作项、10000 个去重 ID、1024 个来源状态和 100 条慢操作。单个时间桶超过 64 个操作名称时，其余名称合并为 `__other__`。

## 接口

WebGUI 使用以下 Manager 接口：

- `GET /api/performance/config`：读取配置。
- `PATCH /api/performance/config`：保存配置。
- `POST /api/performance/batches`：Gateway 和 WebGUI 批量上报样本。
- `GET /api/performance/summary?rangeMs=...`：读取降采样后的趋势和慢操作。
- `GET /api/performance/logs?limit=...`：读取最近的原始记录。
- `GET /api/performance/status`：读取文件数量、空间、待写记录和错误状态。
- `GET /api/performance/events`：新样本通知，用于刷新页面。

这些接口沿用 Manager 的 WebGUI 局域网访问验证。Gateway 上报只接受本机地址，并且 Gateway ID 必须已存在。

## 主线程保护

- `/api/scan/agents` 在独立有界低优先级子进程中执行目录探测、任务读取和结果构建；相同并发请求共享一个扫描任务。Codex Desktop 任务目录阶段最多等待 8 秒，超时会终止短生命周期元数据进程并返回部分扫描结果。
- Codex Desktop 任务默认每页 200 条。界面按需加载后续页，避免一次构建和序列化数 MB 响应。
- 近期记忆和沉淀记忆的目录枚举、文件解析、生命周期投影及查看时间写入在低优先级只读子进程中执行。
- 消息处理看板列表不返回附件、本地路径、原始回复上下文和完整证据；需要这些内容时读取单项详情。
- 同一 RabiSpeech 地址的并发状态查询共用一个探测任务，紧邻查询复用 500 ms 状态结果；多个页面不会重复创建同一批 `/health` 和 `/v1/capabilities` 请求。
- 性能汇总读取 10 秒、1 分钟和 5 分钟的内存增量汇总；最近记录只保留 1000 条、合计最多 16 MB，接口最多返回 1000 条，非法 `limit` 使用默认 100 条。页面查询不触发写盘或 JSONL 解析。
- 记忆和 Agent 扫描等只读子进程在请求之间保持常驻并复用模块缓存。所有池合计最多执行 2 项低优先级重任务；各状态中的 `executionMode`、`workerPids`、`globalActive` 和 `globalMaxConcurrency` 显示隔离方式与总预算，`workers` 与 `spawnedWorkers` 可发现异常重启。
- Manager 启动时只扫描与当前保留配置和最长 48 小时查询范围相交的 JSONL，并逐行建立汇总；不会解析剩余的长期磁盘历史。
- 子进程达到并发或队列上限时返回可重试错误，不把任务移回 HTTP 主线程执行。

## 判断异常

- 采集器显示离线：最近三次采样间隔内没有收到记录。先确认对应进程仍在运行。
- 文件数量或空间不再变化：确认开关已开启，并查看页面错误提示和 `/api/performance/status` 的 `lastError`。
- 页面有请求耗时但没有 CPU：WebGUI 采集器正常，Manager 或 Gateway 采集器没有上报。
- 短时间尖峰：切换到最近 15 分钟查看原始变化；长期增长则使用 6 小时或 24 小时范围。

该系统保存近期趋势和慢操作证据，不生成火焰图，也不替代操作系统级性能分析器。
