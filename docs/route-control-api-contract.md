<!-- docs-language-switch -->
<div align="center"><a href="./route-control-api-contract_en.md">English</a> | 简体中文</div>
<!-- /docs-language-switch -->

# Route 控制接口的可执行合同

> 状态：源码迁移；专属隔离测试已通过。整包构建、安装版、真实跨机调用由总体验收另行确认。

`io.rabiroute.manager.route-control` 从 `createRabiControlOperations()` 注册接口。相同定义安装路由、执行输入和输出校验，并进入活动 API 目录。插件不再保留 exact/prefix 路由清单或调用旧 `handleRabiApi` HTTP 分发器。

## 操作与拥有者

全部操作使用 `manager.route-control.` 前缀，均为公开接口。已鉴权远端连接沿用相同入口；人格、计划和 Route 绑定不增加功能许可。

| 操作后缀 | 方法和路径 | 原拥有者 |
| --- | --- | --- |
| `identity.read` / `identity.update` | GET / PATCH `/api/rabi/identity` | 全局配置、Relay 同步及网关生命周期 |
| `link-home.read` | GET `/api/rabi/link-home` | 已保存的 Relay 配置与设备摘要读取 |
| `instances.list` | GET `/api/rabi/instances` | DNS-SD 发现及 generation 验证 |
| `routes.list` | GET `/api/rabi/instances/:guid/routes` | 本机 Route 目录或所选 Manager |
| `agent-options.read` | GET `/api/rabi/instances/:guid/routes/:routeId/agent-options` | 原 Agent 目录扫描服务 |
| `agent-binding.update` / `agent-binding.post` | PATCH / POST `/api/rabi/instances/:guid/routes/:routeId/agent-binding` | 原 Route 配置事务 |
| `rabilink-replies.list` | GET `/api/rabi/instances/:guid/routes/:routeId/rabilink-replies` | 原回复文件读取 |
| `message-processing.read` / `message-processing.update` | GET / PATCH `/api/rabi/instances/:guid/routes/:routeId/message-processing` | 原处理器状态及 Route 配置事务 |
| `message-processing.cleanup` | POST `/api/rabi/instances/:guid/routes/:routeId/message-processing-cleanup` | 原工作区、标题及适配器筛选规则与清理拥有者 |
| `manager-config.read` / `manager-config.update` | GET / POST `/manager-config` | Manager 配置仓库与目录准备流程 |

共 14 个操作。该数量仅描述本插件，不能用来证明项目所有公共接口已经迁移。

## 保留的执行语义

- Route 绑定和处理器配置修改仍要求原 `Idempotency-Key` 和强 `If-Match`。准备阶段先检查原 generation/instance 头及写入条件，再消费正文；远端目标同样不能转发弱 ETag。存储与提交回执继续由原 `writeConfig` 拥有。
- 原生忽略的读取正文由合同声明丢弃，不解码；`link-home` 继续拒绝查询参数、正文和分块正文。原生 JSON 写入保持空正文默认值、任意 Content-Type、未知字段和既有类型转换，不凭合同增加新的应用字节上限。
- 所选 Manager 来自现有 DNS-SD，转发前验证身份，只转发原条件头与 generation 头。不会转发调用者的 Cookie、Authorization 或 Relay token。上游可以独立演进，其合法 JSON 及状态保持原生透明转发；对应响应合同明确声明这一开放 JSON 边界，不冒充本机 DTO。
- 本机身份读取、修改返回公开 Relay 摘要，不返回其 token。设备首页仍使用已保存的 Relay 凭据，返回有限字段；配置或本机 GUID 在读取期间改变时拒绝旧结果。
- 清理继续按原规则保留显式指定和不属于消息处理的任务。DSH 删除可能部分成功；不得把 HTTP 成功等同于全部删除。没有请求级幂等的身份、路径配置和清理操作，结果不确定时先读原状态，再判断是否重试。
- 接口等待原拥有者的实际完成；断开 HTTP 不允许插件提前释放该操作租约。撤销原 Node 后，通用响应边界隐藏业务数据，并保留执行结果可能不确定的事实。

## 验证边界

专属测试通过真实合同注册器、隔离 HTTP 服务、真实 Node 登记和原全局配置文件执行。覆盖身份与路径配置回读、原 Route CAS/幂等回执、原设备首页、强条件先于正文、撤权、断连后租约等待、清理后两份原文件的独立回读。测试不发送真实 Agent 提示、不操作生产 Route，也不证明安装版或真实双机验收。

目标与总体验收见 [目标架构](api-contract-discovery-target-architecture.md) 和 [实施记录](api-contract-discovery-implementation-progress.md)。
