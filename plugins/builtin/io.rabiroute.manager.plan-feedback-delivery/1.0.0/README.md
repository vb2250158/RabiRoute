简体中文 | <a href="./README_en.md">English</a>

# io.rabiroute.manager.plan-feedback-delivery

内置 Manager 插件。实例 `manager:plan-feedback-delivery` 提供 `manager.plan-feedback-delivery@1`。实现只通过 `@rabiroute/plugin-sdk` 和清单声明的版本化能力访问宿主资源。

候选版本仅登记正式 `context.publication`，不会提前更改启用状态、替换恢复器或启动恢复扫描。同步发布失败会还原原启用状态、恢复器和 readiness 入口。

成功发布时暂时关闭反馈投递入口；旧 owner 取消扫描、恢复尝试及重试计时器，并等待原始 producer、调度和已接纳反馈 flights 实际结束。确认退役后，新 owner 才构造恢复器、读取最终持久化失败状态并重新启用投递。旧 owner 清理不能关闭新 owner。超时或 abort 只结束等待，不能证明原始工作已退出；无法确认退出时，新恢复循环不会启动。

第一次启动仍等待原计划与路线 readiness。已经启动的恢复器在版本替换或回滚后自动恢复；切换期间收到的 readiness 会延后执行。原反馈收据检查、缺失消息调度、重试退避、持久化失败状态及通知语义沿用原业务实现，取消后的迟到结果不会发出旧版变更事件。

原生 `PlanFeedbackRecoveryService.stop()` 保留有界取消行为；独占插件退役使用 `stopAndJoin()` 等待真实工作，并复用原生存储工作合同追踪 worker 的 `closed`，不把结果拒绝当作进程或任务已经释放。重复退役复用同一个清理 Promise。只读 Manager 不构造或启动恢复器。

恢复器清理抛错时，退役仍等待开始清理时已接纳、以及清理期间登记的反馈 flights 结束，再返回原始清理错误。重复调用保持同一个等待结果或原始拒绝结果。
