[English](persona-knowledge-api-contracts_en.md) | 简体中文

# 角色知识搜索与校验的可执行合同

本组把原 Manager 知识索引、缓存刷新和已发布目录校验接入统一 HTTP 分发与远端发现。索引、存储 delta worker 和已发布目录继续由原 owner 持有，不新增计划或记忆真源。

| 操作 ID 后缀 | 方法 | 路径 |
| --- | --- | --- |
| `search` | GET | `/api/roles/:roleId/knowledge/search` |
| `cache.status` | GET | `/api/roles/:roleId/knowledge/cache/status` |
| `cache.reload` | POST | `/api/roles/:roleId/knowledge/cache/reload` |
| `validation` | GET | `/api/roles/:roleId/knowledge-validation` |
| `validation.alias` | GET | `/roles/:roleId/knowledge-validation` |

共 5 个具体路由，完整 ID 使用 `manager.personas.knowledge.` 前缀。原 `persona`、`knowledge` 和 `knowledge-alias` 派生发现 ID 保留为合同别名。已鉴权空远端节点也能成功调用公开接口，不增加角色、工作区或逐功能许可。

## 原索引与目录

搜索保留原关键词/全文模式、kind、归档、1–100 条分页、最多 512 字符的查询及带版本游标。返回原摘要、命中项与详情地址；不把计划或记忆正文改成新的返回合同。索引尚未就绪时仍返回 503，游标版本失效时返回 409。

缓存刷新保留原 kind+id 点刷新或 all 全量刷新，id 最多 512 字符；未知字段仍按原行为忽略。空正文仍解码为 `{}`，沿用生产入口原有 `maxBytes=0` 的无限应用层正文设置，不额外添加本组上限。返回 200 或仍在刷新的 202，只说明原索引状态。

知识校验只调用原 `validatePublishedRoleKnowledge` 读取已发布目录，并沿用原写入限制 DTO。目录未发布时请求原 Manager 刷新流程并返回 503 `cache_unavailable`；不会在 HTTP 请求中扫描源文件或造替代快照。该接口不写计划、记忆或角色配置。

## 连接、目录与 worker 生命周期

每次请求捕获当前角色目录、原鉴权连接、Manager 身份及原搜索服务实例。动态目录、代际或服务对象改变时，旧请求不能返回原索引结果；新请求按当前目录与服务执行。

刷新继续等待原 `KnowledgeSearchService.reload`，原 delta worker 的 deadline、退出与共享服务生命周期不变。取消单个调用者不会 abort 或替换其他请求共用的索引服务；原工作结束后才结束该调用者的处理。服务关闭与读取进程停止仍由原 Manager/pool owner 完成。

## 验证与范围

定向验证覆盖 5 个路由的真实空节点鉴权调用、原摘要与分页、kind/id/all 和未知字段、超过 1 MiB 的原无限正文语义、冷目录及双前缀校验、动态目录/服务变更、调用者取消与共享服务隔离，以及原生 delta 子进程完成读取后的实际关闭。原索引测试继续覆盖 watcher、reconcile、并发提交与迟到快照。

测试仅使用隔离临时数据与受控读取服务，不代表安装版或真实设备验收。计划、记忆 CRUD、角色配置及其他 owner 仍按各自边界迁移；全部完成前保留对应旧 prefix 分发。
