简体中文 | <a href="./README_en.md">English</a>

# io.rabiroute.manager.message-adapter-control

内置 Manager 插件，通过 `host.manager.message-adapter-control@1` 使用原扫描服务与消息端探针，提供 `manager.message-adapter-control@1`。页面和导航继续通过插件贡献注册。

`createMessageAdapterControlOperations` 从同一可执行合同注册 `GET /api/scan/message-adapters`，操作 ID 为 `manager.message-adapters.scan`。结果包含适配器、独立健康状态、扫描诊断、NapCat 实例观察与原 Gateway 摘要。可选 `gatewayId` 只作为请求元数据返回，不筛选探针；重复参数取第一个，空值视为未指定。未知参数和请求 body 保留忽略语义。

扫描复用原 provider registry、并行有界扫描和健康汇总。响应超时不会把适配器直接判为离线或未登录；接口不安装适配器、不改配置、不启动进程，也不登录或修复。已鉴权远端遵循同一公共合同和现有用户明确禁用项，无第二层逐适配器许可。

原生探针可能读取本地资料、检查进程或联系已配置的端点。扫描截止时间只限制响应等待；已开始的真实 adapter 与 NapCat 探针共用服务的追踪集合。插件退役停止接入，等待注册操作与真实探针结束，再移除 provider。HTTP 200 或扫描状态不代表真实设备、登录、消息收发已完成验收。
