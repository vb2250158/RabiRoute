<!-- docs-language-switch -->
<div align="center">
<a href="./bilibili-history-bridge_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# Bilibili 历史桥接口

受众：接入开发者和维护者。以下描述源码中的可执行接口合同；源码测试通过不代表安装版已更新，也不代表真实浏览器或账号已经验收。

Manager 保存任务和接收浏览器扩展提交的页面，不直接访问 Bilibili 登录态。固定扩展只读取 `https://api.bilibili.com/x/web-interface/history/cursor`，不删除或修改观看历史。实际查询仍须符合用户指定的日期、数量和人格范围。

## 接口与发现

每个合同同时安装路由和生成发现目录，不再使用 `/api/bilibili-history/` 的旧业务处理器。下表标识共用 `manager.bilibili-history.` 前缀。基础路径 `/api/bilibili-history/` 区分大小写；三个动态读取接口保留原有兼容：`roles`、`days`、读取任务的 `jobs` 字面段允许混合大小写，参数值保持原样。其他固定接口和 POST 路径仍区分大小写。

| 方法和路径（以 `/api/bilibili-history/` 为前缀） | 操作标识 | 结果与副作用 |
| --- | --- | --- |
| `POST bridge/pair` | `bridge.pair` | 配对固定扩展；相同扩展恢复原生产者 token，不替换已有配对 |
| `GET status` | `status.read` | 读取配对状态和最近 20 个脱敏任务 |
| `GET roles/:roleId/days` | `roles.days.read` | 从该人格私有日分卷在内存重建日期索引，不写索引文件 |
| `GET roles/:roleId/days/:date` | `roles.day.read` | 读取单日记录；`offset` 默认 0，`limit` 默认 100、范围 1–500 |
| `POST jobs` | `jobs.create` | 为已存在的人格创建指定时间窗口任务，返回 202 和唯一任务 ID |
| `GET jobs/:jobId` | `jobs.read` | 查询原任务状态与聚合进度 |
| `GET bridge/next` | `bridge.next` | 更新扩展在线时间，将原排队任务改为运行中，返回固定只读端点和游标 |
| `POST bridge/page` | `bridge.page` | 持久化原任务页面、去重记录并推进游标或停止任务 |
| `OPTIONS :remainder` | `options` | 保留原前缀下所有路径的预检，包括空后缀和未知路径，返回无正文的 204 |

所有公开接口沿用 Manager 连接鉴权。已鉴权并启用的远端连接不需要逐功能许可。既有 `bridge/next`、`bridge/page` 的 token 用于识别浏览器页面生产者，防止伪造页面；它不是新增的 Manager 管理密钥。配对时若提供 Origin，必须与声明的固定扩展 ID 一致，不返回任意来源的 `Access-Control-Allow-Origin`。

JSON 请求最多 1 MiB，接受既有 Content-Type 行为和空正文默认 `{}`。合同在消费正文前捕获原桥实例和人格目录；实例退役或目录变化后拒绝向另一目录执行原请求。浏览器生产者身份不成立时，页面提交在解码正文前返回 401。

## 持久化与恢复

全局桥状态保存配对凭据、任务、游标和聚合计数；对外状态不包含 token、上一页去重键或逐记录内部索引。标题、URL 等逐条数据只存入目标人格的 `runtime/bilibili-history/daily/`。聚合作者或主题计数也属于私密行为资料，不应发到无关任务或公共材料。

创建任务没有请求级幂等键，202 只表示任务已排队。发生超时或不确定错误时，先在状态和原任务中核对日期窗口，不直接重复创建。`GET bridge/next` 会写状态，不能当作无副作用探测。

页面最多处理 30 条记录。原 `pageKey` 避免同一末页重复计数，稳定记录 ID 去重重叠页面；私有分卷、索引和桥状态不是一个跨文件原子事务，失败后应核对原任务与日期记录再恢复。遇到 `-101` 或 `-412` 立即暂停；其他非零响应标记失败。空页、越过窗口、游标不变或达到 20000 页时停止。

候选实例构造只读取状态，不暂停任务、不写文件。候选失败只关闭自己的实例和路由，原实例继续处理原队列。正式发布后，由 `context.publication.add` 注册的 `afterPublish` 等待 `previousRetirement`，然后重新读取原实例的最新配对、任务 ID、游标和排队进度，再暂停无人格的旧活动任务；只读启动只修改新实例的内存状态。回滚代码版本同样恢复现有队列，不另建任务。

插件退役先关闭原 owner、停止新请求，再等待它已接收的操作真正结束；新实例随后才启用。迟到的旧清理只影响原实例。发布后的迁移写入失败属于运行失败，不能宣称已自动撤销持久化。此模块没有自有后台 worker 或流；浏览器仍是唯一页面生产者，不由 Manager 启停。此模块不会打开浏览器、启动备用 Agent Runtime 或发送历史资料。

## 验证范围

针对性测试使用临时目录和合成页面，覆盖构造及准备失败不写盘、正式发布、原队列恢复、代码版本回滚、旧请求退役等待、只读迁移和迁移写入失败；保留配对、来源核对、空节点远端调用、日期分卷回读、重叠去重、风险暂停、全路径 OPTIONS 与正文限额回归。不访问真实账号，不将单元测试结果当作浏览器扩展或双机验收。
