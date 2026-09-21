# 计划分页读取：缓存、校准与性能边界

[English](plan-page-read-performance_en.md) | [简体中文](plan-page-read-performance.md)

面向维护者。状态：阶段性工程改进，须由正式构建和实际 Manager API 验证后发布；不是十万规模持久索引完成声明。

## 读取链与数据所有权

计划 JSON 仍是权威数据。Manager 进程发布成功写入时同步增加角色级失效版本；分页读任务携带版本，合并在途相同请求时也包含该版本。不同常驻读进程分别消费版本，不能把写入后的请求并入写入前的结果。

读进程先安装目录监听，再创建不可变目录快照。未变化的快照复用展示投影；展示缓存同时核对工作流内容，修改状态名称等配置不会沿用旧展示。原分页过滤、排序、总数、facets、归档视图和 cursor 算法保持原实现，不用实验 keyset 替换公开接口。

## 外部修改与故障

- 精确文件事件与托管版本指定的计划，在回复前重读。读取期间到达的新 dirty 事件也会再消费；连续变化超过有限重试预算时明确失败，不返回已知旧快照。
- 正常监听下，每隔至少 5 秒由下一次请求触发一次完整元数据校准。只列举 active/archive 两个桶，使用最多 16 个并发元数据操作，避免逐目录 `existsSync` 后再 `statSync` 的重复检查。
- 元数据指纹比较 size、mtime、ctime 和 inode。普通无文件名事件触发完整元数据复核，不一律清空正文；指纹变化才重读对应内容。字段不可用或为零时不信任缓存。监听 error/明确溢出错误、目录替换、版本缺口与显式 `authoritative` 读取仍强制重建正文。冷读在隔离进程中连续读取并校验前后元数据，分批让出事件循环。
- 未变化正文不重读，签名不变时继续复用不可变快照及展示。这些字段不是任意文件系统上的绝对保证。
- 监听不可用时保守扫描。读取错误失败关闭，下一次请求可以重建；不把失败当成功的空列表。
- 不承诺任意外部写入的线性一致性。丢失所有监听事件且所有可用指纹字段都未变化的改动，需显式权威重读。恢复 mtime 的同尺寸替换在本机隔离测试中可由 ctime/inode 检出，不能外推为所有文件系统的保证。
- 5 秒表示请求触发校准的间隔，不是绝对外部写入 SLA。无请求不轮询；校准耗时还取决于目录规模与文件系统。

没有采用“每请求只扫 256 个文件后静默返回旧结果”的方案，也没有引入永久后台轮询或第二份业务真源。

## 首屏计数使用交互队列

`GET` 角色知识 `counts` 由现有交互读取池处理，不再排在低优先级 catalog 批任务后。相同角色与失效版本的在途计数合并，写入后的请求不复用旧版本结果；未增加工作进程数或队列上限。计数只读文件元数据，不另建全正文目录。

原五字段完整保留：`activePlans`、`archivedPlans`、`recentMemory`、`consolidatedMemory`、`consolidationRuns`。记忆与整理运行数复用原计数实现；新增异步计划元数据读取的非不存在错误直接失败，不转换为零。

## 有界读进程生命周期

空闲读进程与 IPC 可以解除事件循环引用，但活动请求期限和停止确认期限必须保持引用，直到成功、错误、中止或期限到达。所有结束分支清理定时器。否则独立程序显式 `await run()` / `await stop()` 时可能提前退出；测试不应使用永久保活掩盖此问题。

## 可复制的隔离验证

在项目根目录使用与部署相同的 Node 可执行文件。命令中的 `node` 应解析为该版本；测试只创建系统临时目录，不读取配置中的真实人格。

```powershell
node --import ./scripts/test-manager-runtime-env.mjs --import tsx --test src/planReadInvalidation.test.ts src/manager/managerReadWorkerPool.test.ts
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit

$env:RABI_PLAN_BENCHMARK='1'
$env:RABI_PLAN_FAST='1'
node --import ./scripts/test-manager-runtime-env.mjs --import tsx --test src/rolePlanPageBenchmark.test.ts
Remove-Item Env:RABI_PLAN_BENCHMARK, Env:RABI_PLAN_FAST
```

基准生成 10001 个规范目录，包含冷读、20 次连续分页、三次间隔 5.1 秒的默认 facets 请求、点更与删除。输出保留每个样本、同步/异步 I/O 计数和触发全量校准的原因。它测量读链，不等价于真实 HTTP API；不得只摘取热态 p95 忽略冷读或间隔样本。资源竞争会影响结果，性能负载不要和其它重 I/O 回归并行运行。

## 十万 SQLite 实验不是生产能力

实验文件位于 `tests/performance/`，不在根 `tsconfig.json` 的 `src/**/*.ts` 编译范围，生产模块不引用它们：

```powershell
node --import tsx --test tests/performance/knowledgeSqlitePrototype.test.ts
```

只有显式设置 `KNOWLEDGE_SQLITE_BENCHMARK=100000` 才生成十万行。Node 22.17.1 / SQLite 3.50.0 的一次隔离试验中，20 个真实读 Worker 执行 480 次查询无错误，但总查询 p95 约 16.98 秒，索引与 WAL 空间约为原文本的 55.81 倍。因此该原型没有获准生产集成，不代表已通过生产十万计划验收，也不能据此否定所有持久索引设计。

后续工作仍包括选择性候选、精确 count/facets 的查询计划与分段耗时优化，以及真实 API 的并发、冷启动与写后读取验收。当前缓存阶段仍有全量元数据校准、点更后的全目录投影和冷内容重建成本。
