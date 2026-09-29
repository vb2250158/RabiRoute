# 设备知识写入操作回执

[English](rabilink-knowledge-operation-receipts_en.md) | 简体中文

本次为冻结眼镜 AIX 和 PC 安装包之后的 Relay 源码修订，未部署；此前发布包不包含此功能。Manager 仍是知识业务真源，Relay 仅保存其通过 PC 工具返回的有限传输回执。

写入分派前保留原有 key/hash 意图，新增当前 owner、目标 PC、角色、工具和不透明凭据摘要的内部作用域。每设备仍最多 128 条，不删除旧键，不实现生命周期。结果在响应设备前由既有原子存储持久化。成功要求外层与结构化状态均为 2xx、非 isError、ok=true、uncertain=false、committed、相同键、强 ETag 和非空资源 ID。仅保留已知回执字段及业务 data；32 KiB 以上、假成功或 5xx 均不能确认。落盘失败返回 uncertain。失败分支记录 `knowledge_receipt_persistence_failed`，仅包含服务器生成的 requestId、阶段（validate/read/normalize/lookup/write）及白名单错误码（EACCES/EPERM/ENOENT/EIO/ENOSPC，其他为 UNKNOWN），不记录操作键、正文、凭据或 scope。诊断日志本身失败不会覆盖 503 uncertain，不触发业务重放。

`GET /api/rabilink/device/knowledge/operations/:key` 使用真实设备凭据，返回 `{code:0,data:{idempotencyKey,state,receipt?}}`。state 为 confirmed、failed 或 unknown；failed 仅用于明确权威 not_started。读取重新校验当前设备归属、目标 PC、角色、工具及写权限，不要求 PC 在线，不调用 Manager 或近期详情 touch。回执不包含内部 scope 或凭据摘要，响应禁止缓存。撤权和目标变化拒绝访问原正文。路径只解码一次，键兼容原 256 字符上限。

旧 key/hash 无回执条目及不存在键返回 unknown，不推断未执行。重启前尚未收到结果、wait 超时后才到达的 worker 结果仍可能保持 unknown；此版本不补迟到结果回收。客户端不得重新 POST 或换键来查询，不得以相似标题证明原操作成功。损坏的持久回执导致存储校验失败，不静默删改历史。

测试使用临时目录、模拟知识业务及真实 Relay/PC/MCP HTTP；包括设备在业务处理时断开后 GET 恢复、重启保持已确认或未知、授权撤销及假回执等。另有实际持久化分支故障注入（原子写入抛错仅返回 503 uncertain），以及真实 HTTP 第二设备同键不泄露、owner／目标变更拒绝测试。断线端到端测试曾在并行联合运行中出现 5 秒持久化等待超时，单独重跑通过，随后包含安全诊断的固定源码联合测试单次 52/52 通过，动态合同 6/6 通过，2017 文件前后哈希未变；这不解释此前超时，不能宣布其根因已消除。随后端到端测试将完成条件从服务器文件监听改为客户端原键 GET 查询，保留 5 秒总期限、最多 100 次读取，未知时最多等待 50ms，不重放 POST；该固定输入联合 52/52、动态合同 6/6 通过，2017 文件哈希未变。这是客户端恢复验收方式的改进，不是历史故障的根因修复。本次不开放眼镜写工具、不新增 Manager 业务、不修改冻结包。
