> 历史任务材料，2026-11-14 标记。当前 C 盘源码与实装 Host 为 0.15.2（`dcfb8a42`）。本文保留原任务阶段内容，版本、行号及完成标记沿用原时点。当前行为结合[代码架构](code-architecture.md)、[Agent 接入规范](agent-adapter-standard-requirements.md)与正式验收证据核对。

# RabiRoute 日志优化方案

> 状态：P0 已实施（2026-11-12），P1–P3 待评审。实施记录见文末第 10 节。
> 规范依据：`programming-design-style/references/operation-logging-and-lock-coordination.md`、`dynamic-record-lifecycle`、`docs/path-and-directory-conventions.md`。

## 1. 问题定义

日志的问题不是「量不够」，而是三件事：

1. **分类混**：日志、业务数据、可重建缓存都写成 JSONL、都放在 `data/` 附近，容易被当成同一种东西统一清理或统一保留。
2. **入口散**：`operationalLog` 是唯一合规的结构化入口，但只覆盖控制面；业务层的错误靠零散 `console` 和 `error.message` 字符串。
3. **故障现场留不住**：出错时最需要的是堆栈和上下文，而这两样恰好是缺失最严重的部分。

用户侧最直接的感受是第 3 条：**出问题没有堆栈，只能靠猜。**

## 2. 边界：先分清日志、数据、缓存

判据只有一条：**删掉会不会丢失业务事实。**

| 类别 | 判据 | 例子 | 处置原则 |
|---|---|---|---|
| 日志 | 删了不丢业务事实，只丢排障线索 | `logs/manager/*`、`*-adapter.log.jsonl`、Gateway 运行日志、性能记录 | 可轮转、可过期、可删除 |
| 数据 | 删了就丢业务事实 | 消息记录、计划、记忆、投递回执、`*-replies.jsonl`、`delivery-replay-ledger.jsonl` | 只能无损归档，不能删 |
| 缓存 | 可从上游重建 | TTS 音频、`.runtime/imports/`、性能内存桶、发布候选 | 明确授权后可过期 |

项目已有的判例：

- `docs/path-and-directory-conventions.md:39`：`logs/manager/` 用于排障，**不是业务真源**。
- `docs/path-and-directory-conventions.md:55`：日志可以删除或轮换，但计划、记忆、消息记录和发送回执有各自的数据合同。
- `docs/code-architecture.md:241`：`automation-executions.jsonl` 只记录本机执行状态，**不属于角色数据**。

**本文档只优化第一类。** 第二类只做「无损归档」的容量治理，不进入日志轮转；第三类不涉及。

## 3. 现状

### 3.1 写入链

三个记录域，两个共享面。

- **运行诊断域**：`operationalLog`（控制面结构化操作日志）、`managerRuntimeDiagnostics`（进程崩溃与停顿）、`RuntimeRegistry.appendLog`（Gateway stdout，仅内存）。
- **业务证据域**：`history.ts`（消息、adapter 日志）、`messageContextStore.ts`（会话上下文）、`deliveryReplayLedger.ts`（投递回放）、`outbox.ts` / `rabilinkReplies.ts`（发送回执）。
- **性能与设备域**：`performanceStore.ts`、`rabilink-device-log-store.mjs`、Windows Host 日志。

共享面只有两处：`src/shared/projectDirectoryLayout.ts` 统一路径根；`src/observability/dataMutationAudit.ts` 的审计事件总线（最终经 `installOperationalMutationAuditSink` 汇入 `logs/manager/`）。

**写入器本身不复用**：`history.ts`、`outbox.ts`、`messageContextStore.ts` 各自内联文件名直接 `fs.appendFileSync`，没有公共 `appendJsonl` 抽象。

### 3.2 记录集清单

| 记录集 | 性质 | 写入者 | 路径 | 生命周期 | 错误堆栈 |
|---|---|---|---|---|---|
| `manager-operations-YYYY-MM-DD.jsonl` | 日志 | `manager/operationalLog.ts` | `logs/manager/` | 按天分卷，30 天 / 512MB | **有** |
| `manager-runtime-YYYY-MM-DD.jsonl` | 日志 | `managerRuntimeDiagnostics.ts` | `logs/manager/` | 按天分卷，未见清理 | **有** |
| Gateway 运行日志 | 日志 | `manager/runtimeRegistry.ts:84` | 无（内存 200 行） | 进程内，重启即丢 | **无** |
| `*-adapter.log.jsonl` | 日志 | `history.ts` `appendAdapterLog` | `data/route/<route>/` | **无** | **无字段** |
| `group-messages` / `private-messages` | 数据 | `history.ts` | `data/` | 无 | 不适用 |
| `conversation/current.jsonl` | 数据 | `messageContextStore.ts` | `data/` | 72h 触发 / 24h 候选，归档到 `archive/<n>~<m>.jsonl` + `index.json` | 不适用 |
| `delivery-replay-ledger.jsonl` | 数据 | `deliveryReplayLedger.ts:10` | `data/route/` | 无 | 不适用 |
| `rabilink-replies.jsonl` | 数据 | `adapters/rabilinkReplies.ts:26`、`outbox.ts` | `data/route/<route>/` | 无 | 不适用 |
| 性能记录 | 日志 | `manager/performanceStore.ts` | `.runtime/performance/` | 按小时分卷，48h / 256MB | 无 |
| 设备诊断日志 | 日志 | `scripts/rabilink-device-log-store.mjs` | relay 侧 | 5000 行覆盖截断 + 脱敏 | 无 |
| Host 日志 | 日志 | Windows Host | `logs/` | 2MB × 4 轮转 | 未核实 |

### 3.3 生命周期动作要分开看

- **按日期分卷**：`manager-operations`、`manager-runtime`、性能记录。只是切文件，不减少总量。
- **归档**：`messageContextStore` 的 72/24 双窗口。**只搬不删**，`archive/<first>~<last>.jsonl` + `index.json` 记录范围与去重指纹。
- **沉淀**：`roleKnowledge.ts` 把记忆写入知识库，**只标记不删源**。
- **删除**：`operationalLog` 的 30 天 / 512MB 清理、设备日志的 5000 行覆盖。**只有这两类做过真正的删除。**

结论：**「归档」和「删除」被混为一谈的风险最高**。业务账本一旦套用日志的删除策略，丢的是业务事实。

### 3.4 堆栈覆盖

| 记录域 | 错误堆栈 | 调用点栈 | 前端可见 | 落盘 |
|---|---|---|---|---|
| `manager-operations` | 有 | 默认关闭 | 无 | 有 |
| `manager-runtime` 崩溃 | 有 | 不适用 | 无 | 有 |
| `*-adapter.log.jsonl` | 无字段 | 无 | 无 | 有 |
| Gateway 运行日志 | 无 | 无 | 无 | **不落盘** |
| 业务 JSONL 失败记录 | 多为无 | 无 | 不适用 | 有 |
| 角色存储审计 | **假栈** | 无 | 无 | 有 |

支撑数据：

- `error instanceof Error ? error.message` 在 `src/` 下 **160 个文件、315 处**。
- `appendAdapterLog` / `appendAdapterLogToDir` 调用 **55 处**。
- `managerOperationalError` 调用 **39 处**，其中 34 处在 `controlPlaneRoutes.ts`。

## 4. 问题清单

### P0-1 出错时没有堆栈（三层断裂）

- **类型层**：`AdapterLogRecord`（`src/history.ts:223-231`）没有 `stack` 字段，55 处调用想记也无处可放。
- **调用层**：315 处只取 `error.message`，集中在 `forwarding.ts`（14）、`controlPlaneRoutes.ts`（16）、`agentThreads.ts`（9）、`companionActivity.ts`（9）、`outbox.ts`（8）。
- **展示层**：`adapterLogEntry`（`controlPlaneRoutes.ts:3672-3689`）只把整条记录放进 `raw`，WebGUI 无任何 stack 渲染。

后果：adapter 连接失败、消息投递失败、outbox 重试失败这类最需要定位的问题，日志里只有一句人话，没有出错位置。

### P0-2 Gateway 崩溃没有兜底，且日志不落盘

- 全仓只有 manager 装了 `uncaughtExceptionMonitor`（`managerRuntimeDiagnostics.ts:170`）；`gatewayMain.ts` 及其余进程没有任何 `uncaughtException` / `unhandledRejection` 处理器。
- Node 默认把堆栈打到 stderr → `RuntimeRegistry.appendLog`（`runtimeRegistry.ts:84-90`）收进内存 200 行 → 不落盘。
- 进程崩溃后，内存随进程消失，**堆栈永久丢失**。

### P0-3 角色存储审计写的是假栈

`roleStorageApplication.ts:533/628/1082` 把 `publicError` 当 `error` 写审计，而 `publicError` 是 `publicMutationError`（`:270`）**新建的对外错误对象**。`managerOperationalError` 取到的是包装函数的调用栈，指向的位置不是真实失败点。

### P0-4 调用点栈默认关闭

`diagnosticGroups` 默认 `new Set()`（`operationalLog.ts:177`），必须显式配置 `RABIROUTE_DIAGNOSTIC_LOG_GROUPS` 才会在 `:285-290` 补 `diagnostic.stack`。符合「关闭态零成本」，但默认排障只能看到「哪个错误」，看不到「谁调用的」。

### P1-1 adapter 日志分类错位

`*-adapter.log.jsonl` 按用途是日志（`project-function-map.md:235` 写「排障」），按 `AdapterLogRecord` 结构也是日志，却和业务账本同放在 `data/route/`，且没有开关、没有保留期。

### P1-2 console 旁路

`src/` 下 60+ 个文件直接 `console.log/error/warn`。需要区分三类，不能一刀切：

| 类型 | 例子 | 处理 |
|---|---|---|
| 进程间协议 | `gatewayMain.ts:227` ready 行、`gatewayCommands.ts` 的 `*_RESULT:` | 保留，封装并注明「被父进程解析，不是日志」 |
| 启动 fatal | `manager.ts`、`config.ts` 早期失败 | 统一 `fatalStartup()`，同时写 `operationalLog` |
| 业务旁路 | `controlPlaneRoutes.ts:2682/7227/9020` | 接 `operationalLog.bind()`，删除裸 console |

### P1-3 分类只靠文档和记忆

哪些是日志、哪些是数据，目前只写在文档里，新增写入点没有强制登记，容易再次混。

### P2-1 证据类 JSONL 无容量上限

`group/private-messages`、各 adapter 消息记录、`agent-packets`、`delivery-replay-ledger`、`role-panel/messages` 全部只增不减。`history.ts` 同步追加，语音/飞书去重还要全文件扫描，文件越大越慢（`docs/performance-monitoring.md:78` 已列此风险）。

### P2-2 去重全文件扫描

`appendVoiceTranscriptOnce`（`history.ts:362-372`）是 `readFileSync` 全文 + 逐行 `JSON.parse`，且同一条记录写两个文件（`:409`、`:411`），每次语音转写最多两次全文件扫描。

### P2-3 脱敏实现三份重复

`operationalLog.ts:87` 的 `redactProjectRoot`、`managerRuntimeDiagnostics.ts:63` 的 `redactedText`、`rabilink-device-log-store.mjs:12-37` 的 key 正则，各写一套。

## 5. 目标

1. **故障可定位**：任何 error 级别的日志，都能看到真实堆栈；Gateway 崩溃也能留下现场。
2. **分类可执行**：日志、数据、缓存三类在代码里有登记，不靠人记。
3. **生命周期匹配语义**：日志可轮转，数据只归档不删除。
4. **不引入新平台**：规范明确不要求远程日志服务、ELK、OpenTelemetry。

## 6. 分期方案

### P0：让故障可定位（建议先做）

| 编号 | 动作 | 涉及文件 | 验收 |
|---|---|---|---|
| P0-a | `AdapterLogRecord` 加 `stack?: string`；`appendAdapterLog` / `appendAdapterLogToDir` 接受 `error?: unknown`，传 Error 时自动提取 `message` + `stack`（截 16KB），调用方已给 `message` 时保留原文案 | `src/history.ts:223-292` | 单元测试：传 Error 时写入 stack 且指向真实抛错行；传字符串时不写 stack |
| P0-b | 改造关键 catch 使用 `error` 参数：`forwarding.ts`、`outbox.ts`、`napcatAdapter.ts`、`webhookAdapter.ts`、`wecomAdapter.ts`、`weixinAdapter.ts`、`heartbeatAdapter.ts`、`feishuAdapter.ts`、`rabilinkRelayWorker.ts` | 上述文件约 20 处 | 制造一次 adapter 连接失败，`*-adapter.log.jsonl` 中该条记录有 `stack` |
| P0-c | `gatewayMain.ts` 注册 `uncaughtException` / `unhandledRejection`：用已有的 `operationalLog` 记 `gateway_uncaught_exception` / `gateway_unhandled_rejection`，带 `managerOperationalError` 原始栈；同时把栈写 stderr 供父进程捕获；`flush()` 完成后 `exit(1)`，2 秒兜底退出 | `src/gatewayMain.ts:181-192` | 人为 `throw new Error("probe")`，`logs/manager/manager-operations-*.jsonl` 出现该事件且 stack 指向 `gatewayMain` 之后的真实调用行；进程以 1 退出 |
| P0-d | 运行日志落盘：`projectDirectoryLayout` 加 `gatewayLogRoot = logs/gateway`；抽一个轻量行日志 sink（队列 + 100ms 批量 append + 失败重试），由控制面注入 `RuntimeRegistry`；按 gateway 分文件、按天分片，保留 7 天 / 100MB | `src/shared/projectDirectoryLayout.ts`、`src/manager/runtimeRegistry.ts`、`src/manager/controlPlaneRoutes.ts:1716/2778` | 造 300 行输出 → 文件 300 行、内存 200 行、API 200 行；重启后文件仍在；ready 行与 `*_RESULT:` 不落盘 |
| P0-e | 修假栈：`roleStorageApplication.ts` 三处 `error: publicError` 改为 `error`，`throw publicError` 保持不变 | `src/manager/roleStorageApplication.ts:542/637/1091` | 制造 storage mutation 失败，日志 stack 指向真实失败点，HTTP 响应体仍只含 publicError 字段 |
| P0-f | `operationalLog.record()` 在 `level === "error"` 时无条件补 `diagnostic.stack`，其余级别仍按 `diagnosticGroups` | `src/manager/operationalLog.ts:285` | 关闭所有组时不产出；只开 `conversation` 组时 error 记录带调用点栈；非 error 记录不带 |

P0 完成后，**「出问题没有堆栈」这条痛点闭环**：adapter 有栈、Gateway 崩溃有栈、角色存储不再有假栈、控制面 error 有调用点栈。

### P1：让分类成立

| 编号 | 动作 | 验收 |
|---|---|---|
| P1-a | `*-adapter.log.jsonl` 迁到 `logs/route/<routeId>/`；`readAdapterLogs`（`controlPlaneRoutes.ts:3831`）双读，新路径优先、旧路径 fallback；旧文件不删不移动，一个正式版本后退役；新增 30 天 / 单 Route 100MB 清理 | 新旧路径各放一条，日志页两条都能看到；超过 30 天的旧分片被清理 |
| P1-b | console 按三类治理，先做 `gatewayCommands.ts`、`controlPlaneRoutes.ts`、`config.ts` 三个文件 | console 计数基线只降不升；协议行行为不变 |
| P1-c | 新增 `src/shared/recordClassification.ts`，每个记录集声明 `recordClass: "data" \| "log" \| "cache"`、`sourceOfTruth`、`lifecycle`；新增写入点未登记则测试失败 | 故意加一个未登记的 `appendFileSync`，测试报错 |

### P2：容量与性能

| 编号 | 动作 | 前置决定 |
|---|---|---|
| P2-a | 证据类 JSONL 按 72/24 双窗口**无损归档**，抽 `src/shared/jsonlArchive.ts`，复用 `messageContextStore` 的 `archive/<n>~<m>.jsonl` + `index.json` 模式 | **归档键**：补 `sequence` 还是按字节偏移。补 sequence 要改所有记录类型，但崩溃恢复简单；字节偏移不动数据，恢复逻辑复杂 |
| P2-b | 去重扫描改尾部窗口（24h / N 行），超出窗口记 `duplicate_scan_window_exceeded`，不静默改变语义 | 无 |
| P2-c | 抽 `src/shared/redact.ts`，合并三份重复实现；日志写入时脱敏，业务数据只在导出/分享时脱敏 | 无 |

### P3：防回潮

| 编号 | 动作 |
|---|---|
| P3-a | `docs/project-function-map.md:214` 的「运行数据与日志」表增加「性质 / 生命周期」两列 |
| P3-b | 在 CI 或本地检查中加入 console 计数与未登记写入点基线 |

## 7. 不做什么

- 不引入远程日志平台、ELK、OpenTelemetry。
- 不删除任何业务数据，不把 `data/` 当临时目录。
- 不对业务数据做写入时脱敏（会破坏回放和审计）。
- 不重写 `history.ts`，只在既有入口上增量扩展。
- 不为了「统一」把纯文本 Gateway stdout 硬转成结构化事件（协议行必须保持原样）。

## 8. 验收清单

- [ ] 任意一次 adapter 失败，日志记录里有 `stack`，且栈顶指向真实文件行。
- [ ] Gateway 进程抛未捕获异常后，`logs/manager/` 有对应记录且含 stack。
- [ ] Gateway 重启后，重启前的 stdout 日志仍可查。
- [ ] 角色存储失败日志的 stack 不再指向 `publicMutationError`。
- [ ] 关闭全部日志组时，高频路径无新增字符串拼接与堆栈采集。
- [ ] `*-adapter.log.jsonl` 迁移后，日志页新旧文件都能读到。
- [ ] 业务 JSONL 归档后，历史查询仍能命中归档内容。

## 9. 待决定

1. **P2-a 的归档键**：补 `sequence`（改记录类型，恢复简单）还是按字节偏移（不动数据，恢复复杂）。这个取舍影响 P2 的数据兼容策略，需要拍板。
2. **P1-a 的迁移窗口**：旧路径保留几个正式版本，建议至少一个。
3. **P0 是否一次做完**：P0-a/b（adapter 堆栈）与 P0-c/d（Gateway 落盘）可以分开交付，前者改动小、收益直接，后者涉及新目录与生命周期。

## 10. 实施记录（P0，2026-11-12）

### 已落地

| 项 | 实际改动 |
|---|---|
| P0-a | `src/history.ts`：`AdapterLogRecord.stack`；新增 `AdapterLogInput`、`adapterLogErrorFields`、`normalizeAdapterLog`；两个 append 入口改用统一归一化。非 Error 的 `{ message, code }` 对象也能取到 message，不会写成 `[object Object]`。 |
| P0-b | `src/forwarding.ts` 8 处、`src/adapters/napcatAdapter.ts` 4 处、`wecomAdapter` / `feishuAdapter` / `heartbeatAdapter` / `rabilinkRelayWorker` 各 1 处，catch 内改为传 `error`。 |
| P0-c | `src/gatewayMain.ts`：新增导出 `installGatewayCrashHandlers`，记录 `gateway_uncaught_exception` / `gateway_unhandled_rejection`，写 stderr，flush 后 `exit(1)`，2 秒强制退出兜底。 |
| P0-d | `src/manager/lineLog.ts`（新）+ `gatewayLogRoot` + `RuntimeRegistry` 可选 `appendLine` + `controlPlaneRoutes` 注入。批量 50ms / 200 行，按 source 和日期分片，保留 7 天 / 100MB。 |
| P0-e | `src/manager/roleStorageApplication.ts`：实际 **6 处**（mutation 3 + read 3），方案只列了 mutation 的 3 处。`throw publicError` 未动。 |
| P0-f | `src/manager/operationalLog.ts`：`diagnosticGroups.has(group) \|\| level === "error"`。 |

### 审查中发现并修复

1. `flush()` 在已有写入进行中调用时，只等待当前批次，后续排队行会被漏掉 → 改成循环排空，最多 3 次。
2. Gateway 崩溃兜底的 2 秒定时器原本 `unref()`，flush 卡住时进程会以 code 0 自然退出，Host 无法判定崩溃 → 去掉 `unref`，并在 `finish` 里清除定时器。
3. `runGatewayMain` 启动失败分支只卸载了审计 sink，漏卸载崩溃监听器 → 补上。
4. 分片名缓存原先只保留最后一个 key，多个 Gateway 交叉输出时命中率为 0 → 改为按 source 缓存。
5. `flush()` 耗尽重试后静默返回，调用方无法感知丢行 → 改为抛出带 pending 行数的错误。

### 已知限制（有意保留）

- 运行日志 sink 退出前最多丢 50ms 输出。Manager 没有统一的 SIGTERM 关闭钩子，强行注册会改变 Host 的生命周期语义，因此不做。
- 分片日期用 UTC，与 `manager-operations-*.jsonl` 口径一致；行首时间戳是本地时间，两者在跨时区时看起来会差一天。
- `roleStorageApplication` 改记原始 error 后，`redactProjectRoot` 只替换 rootDir 的三种写法，rootDir 之外的绝对路径会进入 `logs/manager`。日志为本机私有目录，视为可接受的排障信息。

### 验证

- `npx tsc -p tsconfig.json --noEmit` 通过。
- 相关测试全绿：`history`、`operationalLog`、`roleStorageApplication`、`gatewayMain`、`lineLog`、`runtimeRegistry`、`projectDirectoryLayout`、`forwarding`、`napcatAdapter`、`heartbeatAdapter`、`wecomAdapter`、`feishuAdapter`、`weixinAdapter`、`webhook*`、`rabilinkRelayWorker`、`gatewayDiagnostics*`、`gatewayStatusSnapshot`，累计 160+ 用例。
- 未覆盖：`runGatewayMain` 启动失败分支的监听器卸载（需要构造完整 Gateway 启动失败，当前靠代码审查确认）；2 秒强制退出路径未做真实进程验证。
