# 设备知识写入操作回执

[English](rabilink-knowledge-operation-receipts_en.md) | 简体中文

0.3.22 的知识请求由同一 RabiLink 应用的真实设备凭据鉴权，默认允许目标 PC 实际提供的知识工具，包括写入。Manager 是知识业务和持久数据的唯一真源；Relay 仅保存通过 PC 返回的有限传输回执。无需另配角色、工具或写权限 grant。当前连接与服务合同见[知识运行合同](rabilink-knowledge-runtime.md)。源码和测试不能代替已安装版本或真实设备验收。

## 写入意图与结果

写入分派前持久化稳定操作键和正文摘要，并记录当前 owner、目标 PC、角色、工具与不透明设备凭据摘要的内部作用域。角色和工具标识本次业务意图，不构成额外授权白名单。工具只接受 Manager 全局 `rolesRoot` 实际拥有的人格；Route 自定义目录里的同名人格不能冒充该知识存储 owner。Manager 的输入校验、强 ETag、幂等键和业务边界继续有效。每设备最多保留 128 条，不淘汰旧键，不通过删除历史恢复写入容量。结果在响应设备前由原子存储持久化。

确认成功要求外层与结构化状态均为 2xx、非 `isError`、`ok=true`、`uncertain=false`、`committed`、相同键、强 ETag 和非空资源 ID。仅保留已知回执字段及业务 `data`；超过 32 KiB、假成功或 5xx 均不能确认。落盘失败返回 `503 uncertain`。失败日志 `knowledge_receipt_persistence_failed` 只包含服务器生成的 requestId、阶段（validate/read/normalize/lookup/write）和白名单错误码（EACCES/EPERM/ENOENT/EIO/ENOSPC，其他为 UNKNOWN），不记录操作键、正文、凭据或 scope。诊断日志失败不覆盖原不确定结果，也不触发业务重放。

## 原键查询

`GET /api/rabilink/device/knowledge/operations/:key` 使用真实设备凭据，返回 `{code:0,data:{idempotencyKey,state,receipt?}}`。`state` 为 `confirmed`、`failed` 或 `unknown`；`failed` 仅用于明确权威 `not_started`。每次读取复核当前应用、设备凭据与归属、owner 和选定目标 PC，不再检查已退役的角色、工具或写权限 grant。查询不要求 PC 在线，不调用 Manager，也不触发近期记忆详情 touch。

回执不包含内部 scope 或凭据摘要，响应禁止缓存。设备或应用停用、凭据变化、owner 或目标 PC 变化均拒绝访问原正文；不能通过第二设备的相同操作键读取结果。路径只解码一次，查询兼容历史 256 字符键；新写请求仍必须满足当前稳定键合同。

旧 key/hash 无回执条目及不存在键返回 `unknown`，不推断未执行。重启前尚未收到结果、等待超时后才到达的 worker 结果可能保持 `unknown`；当前不回收迟到结果。客户端不得重放 POST 或换键来查询，也不得以相似标题证明原操作成功。损坏的持久回执导致存储校验失败，不静默删改历史。

## 验证边界

自动化验证使用临时数据与模拟业务，覆盖断线后原键 GET、重启后的已确认与未知结果、凭据/owner/目标变更、第二设备隔离、假回执及真实原子写入失败。当前 PC 路径直接使用 Manager 接口；历史 Relay/PC/MCP 测试不证明这条新路径已经部署。

此前回执恢复曾出现五秒持久化等待超时，单独重跑及后续固定源码回归通过均不能证明其根因已消除。后来完成条件改为客户端原键 GET，保留期限和次数上限且不重放 POST；这改进了恢复验收方式，没有抹去历史失败。旧包、测试计数和设备能力的证据分别保留在[历史 AIUI 验收记录](aiui-agent-acceptance.md)，不能作为 0.3.22 新连接和知识路径的通过证据。
