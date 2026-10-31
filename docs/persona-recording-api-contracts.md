[English](persona-recording-api-contracts_en.md) | 简体中文

# 角色全天记录接口合同

状态：24 个具体操作已迁移到可执行操作注册；隔离存储、受控采集依赖与 HTTP 回归不代表真实麦克风、摄像头、NAS、手机或全天耐久已验收。使用与存储说明见[角色全天记录](persona-all-day-recording.md)。

基路径为 `/api/roles/:roleId/all-day-recording` 与原有兼容路径 `/roles/:roleId/all-day-recording`，二者指向同一原生 owner。每条基路径有以下 12 个操作：

| 方法 | 后缀 | 原执行者与结果 |
| --- | --- | --- |
| GET | 空后缀 | 原服务状态、设置与已发现手机来源 |
| GET | `/recent`、`/catalog` | 有界近期快照、日期目录与 loading/incomplete 信息；catalog 保留 day、refresh=1、summary=1 |
| GET | `/page` | 原 `(startedAt,id)` 双向游标，source/type 过滤，每页 100 |
| GET | `/transcripts`、`/events` | 原 26 小时时间窗、来源时间、读取覆盖和转写筛选 |
| PUT | `/settings` | 原设置校验、原子写、串行控制队列和状态回读 |
| POST | `/start`、`/stop` | 原唯一 Host 采集 owner；相同角色重复控制沿用原生幂等行为 |
| POST | `/index-repair/:day` | 原有界派生索引任务，立即回 queued；不是扫描已完成 |
| GET | `/media/:day/:file` | 原角色/电脑受控 JPEG/WAV，file 必须是 64 位小写哈希加扩展名 |
| GET | `/audio` | 先核对可见时间线事件，再读该事件的手机 owner/chunks 或原语音记录；保留上游状态与 MIME/字节 |

`createPersonaRecordingOperations` 的准备阶段固定原连接、Manager 身份、角色目录及原 runtime/service/store/read model；已鉴权启用的远端默认可用，不按上下文加功能许可。本机来源与只读配置保留。设置正文延续原无限应用字节上限、空正文 `{}` 和原生校验；全部控制仍要求 `application/json`，start/stop/repair 忽略正文，不能要求原接口没有的字段。

原 `AllDayRecordingService` 继续串行处理控制，并在原队列、存储与语音调用边界复核授权。HTTP 取消等待已接受的原调用终态，不把取消回执当成录制已经停止。手机资源 owner 只能来自原事件，查询不能冒认来源或绕过已选择设备。读取 worker、60 秒历史期限、独立重建队列以及原持久记录保留规则不变。

设置与派生缓存按完整原目录区分；根切换后新请求不复用旧根缓存，旧异步投影不能发布为当前结果。索引重建排队时固定原目录，进入队列和设置等待后核对目录；释放 runtime 时等待已接受的重建任务，原始事件不因迁移删除。HTTP queued、loading 和 worker 真正退出是不同事实。写后失败或身份变化应读取原设置/会话/事件确认，不能跨代自动重复采集。
