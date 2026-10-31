简体中文 | <a href="./README_en.md">English</a>

# io.rabiroute.manager.message-processing-automation

内置 Manager 插件。实例 `manager:message-processing-automation` 提供 `manager.message-processing-automation@1`。实现只通过 `@rabiroute/plugin-sdk` 和清单声明的版本化能力访问宿主资源。

## 发布与提醒寿命

候选只构造两种原生提醒服务，不订阅计划更新，不读取待提醒集合或启动定时器。公共 `context.publication.add` 的同步 `publish/rollback` 一起切换或恢复两个共享服务指针；候选失败保留原服务与原订阅。

`afterPublish` 等待旧 activation 的 `previousRetirement`，再检查取消和两个指针的归属，随后订阅计划更新并启动消息处理提醒、知识回调提醒。部分启动失败按发布后 runtime failure 撤下新 activation，并清理两种服务；不会把已执行的动作声称为已回滚。

退役停止接收计划更新，注销自己的订阅，并等待两种原生服务、仍在读取的启动任务和已接收的计划处理工作。客户端或订阅断开不解除原工作寿命。旧实例只清除仍指向自身的共享指针；重复清理返回同一 Promise，不关闭新订阅或新提醒。计划处理失败通过原运维日志记录。

## 验证范围

受控回归覆盖候选失败、最终就绪拒绝、同步发布失败恢复、成功替换与版本回滚、原计划工作与提醒投递等待、部分启动失败和重复清理。测试使用真实原生提醒服务与受控定时器、投递函数，不进行真实 Agent 或平台外发；完整构建和安装版验收分别记录。
