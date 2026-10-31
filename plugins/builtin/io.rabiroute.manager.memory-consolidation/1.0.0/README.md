简体中文 | <a href="./README_en.md">English</a>

# io.rabiroute.manager.memory-consolidation

内置 Manager 插件。实例 `manager:memory-consolidation` 提供 `manager.memory-consolidation@1`。实现只通过 `@rabiroute/plugin-sdk` 和清单声明的版本化能力访问宿主资源。

## 发布与调度寿命

候选只构造原生调度器并延迟其执行，不替换当前共享指针，不扫描记忆、不创建整理批次、不投递 Agent，也不停止共享手动触发进程。公共 `context.publication.add` 的同步 `publish/rollback` 切换或恢复调度器指针；后续候选失败继续使用原调度器。

`afterPublish` 等待 `previousRetirement`、检查取消与当前归属后才释放调度器的启动门。首次启动沿用 Manager 原有就绪调用；热替换或版本回滚继承原调度器的启动意图。等待旧实例退役期间，新的 `start/reschedule/runOnce` 调用不会提前执行。插件与提供 `deferActivation/activate/isStarted` 的原生调度器必须一起交付。

旧安装版若没有这些方法或前任实例缺少 `isStarted`，候选返回 `memory_scheduler_activation_requires_switch` 并保留原实例。新增 `activationDeferred/startRequested` 字段的初值不能从旧实例的空闲状态可靠还原：它可能尚未就绪，也可能已经运行但没有待办任务。本实现未提供这项状态迁移；该具体边界需要 Host 受控应用切换，同代调度器之间仍走原生热替换。

退役先停止原调度器接收新工作，再停止原 `manager:memory-consolidation` 手动触发进程组，同时等待调度执行和进程确认退出；两条清理路径都会完成后才报告错误。这个原生进程 owner 保持原值，新 activation 仅在旧 owner 完整退役后复用它。候选从未取得该 owner 时不调用 `stopOwner`；重复旧清理返回同一 Promise，不会再停止后来的进程。调度器停止后，迟到的评估或创建批次结果会被等待，但不会继续创建或投递下一项工作。

## 验证范围

受控回归覆盖候选失败、最终就绪拒绝、同步发布失败恢复、热替换与版本回滚、旧进程退出等待、并发就绪调用、重复清理和迟到异步结果。进程归属测试使用真实原生 registry 与受控 child，不调用真实 Agent；完整构建和安装版验收分别记录。
