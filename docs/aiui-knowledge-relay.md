# 设备知识请求与应用鉴权

[English](aiui-knowledge-relay_en.md) | 简体中文

设备以独立 RabiLink 设备凭据调用 `POST /api/rabilink/device/knowledge`，正文只包含 `{operation:'list'}` 或 `{operation:'call',name,args}`。认证通过、设备归属正确并选择同应用 PC 后，默认允许该 PC 提供的全部知识工具及写入，不再保存或交叉计算额外知识 grant。

应用 token 不能冒充设备凭据；客户端不能覆盖目标、URL、Token、owner 或归属。PC 未广告 `knowledgebridge` 时返回 503 `KNOWLEDGE_BRIDGE_NOT_READY`，不入队。Relay 构造四字段设备 metadata 和 nonReplayable，固定 path `/__rabilink/knowledge`；通用 WebGUI 队列拒绝保留路径。

入队、领取及重领重新核对当前凭据、owner、应用和所选目标。凭据撤销或改绑目标后不沿旧作用域重领；凭据摘要仅留 Relay 内部。已经执行的请求不能由撤销回滚。PC 经 Manager 既有接口读取和写入实际人格，不依赖单独 MCP 配置。

写工具和近期详情 touch 保留稳定业务幂等键。分派前持久记录意图摘要；同键不创建第二队列，异意图冲突。每设备台账上限 128，满时拒绝，不自动淘汰；写 lease 过期不重投，结果超时为 uncertain，不换键重试。恢复见[知识操作回执](rabilink-knowledge-operation-receipts.md)。

旧 owner 的 knowledge-grant GET/PUT/operations 接口返回 410 `KNOWLEDGE_GRANTS_RETIRED`，跨账号仍返回 404；管理页不再展示授权按钮。历史 grant 原样保留作旧数据，不参与授权；没有第二个配置入口。Relay 源码更新必须实际部署后才改变公网行为。
