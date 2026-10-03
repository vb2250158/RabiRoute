# PC 知识服务与 RabiLink 连接

[English](rabilink-knowledge-runtime_en.md) | 简体中文

同一 RabiLink 应用中已鉴权的设备连接后，默认可以使用 PC 已提供的知识工具，包括写入和近期记忆详情的阅读标记。无需再配置本机 MCP 地址、知识密钥、角色或工具白名单以及设备 grants。独立 Agent 节点、匿名局域网发现和其它应用的设备不因此获得访问权限。

PC 使用 Manager 已有的计划、记忆和知识接口；业务和持久化回执仍由 Manager 拥有。稳定工具映射、schema 与回执校验位于 `packages/rabi-knowledge-contract`，独立 `apps/rabi-mcp` 复用它们，PC 请求不依赖另起 MCP 进程。

运行上下文由当前 Manager 提供完整地址、application generation、实例 ID 和本机真实人格目录。调用前核对 `/meta` 的身份、live、requiredReady 和 healthy/degraded；写后复核身份，身份变更或确认失败标记 uncertain。启动预检仅核对身份，避免等待自身 READY 形成循环。`knowledgebridge` 能力表示当前预检成功；Manager 的 ready、人格目录变化及连接恢复事件触发重新检查，请求失败或事件流断开时撤销就绪状态。语音能力由真实能力接口和 Speech 的 ready / capabilities_changed 事件更新。事件流断线采用有界退避重连，空闲时不定时探测。能力广告不能当作业务完成。

Relay 专用 `/__rabilink/knowledge` 队列携带 `{appId,deviceBindingId,ownerAccountId,targetDeviceId}`，正文只有工具请求。PC 核对目标并使用实际人格目录，不接受正文覆盖身份、地址或工具范围。固定支持的工具默认全部开放，返回的 roleId 枚举只来自 Manager 全局 rolesRoot 的真实人格；Route 自定义人格目录不混入此知识 API。不存在的人格或未实现的工具仍被拒绝。

写工具和近期详情 touch 保留稳定幂等键及 nonReplayable 标记。网络失败返回 uncertain，不自动重发或换键。安装版地址必须由 Host 当前 status 动态发现，不能保存端口。

迁移：配置归一化与保存移除旧 `speechProxyEnabled`、`knowledgeBridge` 权限字段，保留服务器连接、应用令牌、实例身份、数据和其它参数。升级 PC 与 Relay 后生效；真实跨电脑及手机/眼镜验收独立于本机测试。
