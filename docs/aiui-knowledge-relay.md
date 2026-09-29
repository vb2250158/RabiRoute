# AIUI 知识 HTTP Relay（实验实现）

[English](aiui-knowledge-relay_en.md) | 简体中文

设备 profile 的 MCP 引用不是授权。owner 通过 `GET/PUT /manage/api/apps/:appId/devices/:bindingId/knowledge-grant` 单独管理 `{allowedRoles,allowedTools,allowWrites}`；默认空列表且禁止写。PUT 正文为 `{expectedRevision,idempotencyKey,grant}`，沿 profile 管理写入的 JSON、自定义头与同源检查。版本首次为 0；冲突 412，同键异正文 409。授权操作台账最多 128 条，容量满拒绝。

设备独立凭据调用 `POST /api/rabilink/device/knowledge`，正文仅 `{operation:'list'}` 或 `{operation:'call',name,args}`。应用 Token 不可代替设备凭据；目标必须显式选定且属于相同应用，禁止请求传目标、URL、Token 或身份。PC 未广告 `knowledgeBridge` 能力时返回 503 `KNOWLEDGE_BRIDGE_NOT_READY`，不入队。现有能力规范化会将广告转为小写。

Relay 服务端构造 queue `knowledge:{appId,deviceBindingId,ownerAccountId,targetDeviceId,grant}` 与 `nonReplayable`，固定 path `/__rabilink/knowledge`，body 仅原工具请求。通用 WebGUI 创建入口拒绝保留路径；PC 必须在 Manager 代理之前分流并独立验证授权交集，通过官方 SDK 连接本机 MCP HTTP，不能将该路径交给 Manager。

写工具和会 touch 的近期详情必须启用写权限并携带原业务幂等键。Relay 在派发前持久记录 key/意图摘要，重复键不会新建队列；即使重启也失败关闭。同键同意图返回结果不确定并要求权威核对，而非声称已完成；异意图返回冲突。该意图台账也限 128 条，暂不自动淘汰。写请求 lease 过期不重投；超时明确 `uncertain`。不得换键自动重试。

领取及重领前重新核对当前设备凭据、owner、目标和授权；已撤销的读请求不会沿旧授权重领。凭据摘要仅留 Relay 内部队列，不传给 PC。撤销不能回滚已领取并开始执行的请求。

隔离测试覆盖真实 Relay → PC Runtime → 官方 MCP HTTP → 模拟知识结果、写结果不确定、重复键、Relay 重启后的防重放；租约测试执行真实 claim 函数并注入时钟，验证写不重领以及角色撤销、目标变更、重新绑定后拒绝读重领。跨网、真实 Manager 写后权威核对和真机尚待整体验收。未部署到公网，未操作真实知识。
