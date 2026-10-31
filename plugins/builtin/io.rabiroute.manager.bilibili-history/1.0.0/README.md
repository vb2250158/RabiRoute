简体中文 | <a href="./README_en.md">English</a>

# io.rabiroute.manager.bilibili-history

内置 Manager 插件。实例 `manager:bilibili-history` 提供 `manager.bilibili-history@1`。实现只通过 `@rabiroute/plugin-sdk` 和清单声明的版本化能力访问宿主资源。

候选构造与准备不暂停原任务、不写桥状态。`context.publication.add` 注册的 `afterPublish` 在正式发布后等待原实例退役完成，再恢复最新队列并迁移无人格旧任务。清理按实例隔离，代码回滚恢复原任务 ID、游标和配对。接口与失败恢复见[历史桥合同](../../../../docs/bilibili-history-bridge.md)。
