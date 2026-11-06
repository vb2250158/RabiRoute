简体中文 | <a href="./README_en.md">English</a>

# io.rabiroute.manager.message-processing-automation

内置 Manager 插件。实例 `manager:message-processing-automation` 提供 `manager.message-processing-automation@1`。实现只通过 `@rabiroute/plugin-sdk` 和清单声明的版本化能力访问宿主资源。

## 发布与提醒寿命

本插件负责计划更新订阅和知识回调提醒。Agent 请求在原目标任务的 Stop Hook 中按原 requestId 提示一次，不再由后台定时催办，也不在重启时发送历史请求。

候选只构造知识回调服务。同步 `publish/rollback` 切换或恢复它的共享指针；`afterPublish` 等待旧 activation 退役，再订阅计划更新并启动知识回调。启动不读取 Agent 请求存档。启动失败通过原 runtime failure 路径撤下对应 activation 并清理自身工作。

退役注销自己的计划订阅，等待已接收的计划处理、知识回调投递和启动任务。旧实例只清除仍指向自身的共享指针；重复清理返回同一 Promise，不关闭新实例。计划处理失败通过原运维日志记录。

## 验证范围

受控回归覆盖候选失败、最终就绪拒绝、同步发布失败恢复、成功替换与版本回滚、原计划工作与提醒投递等待、部分启动失败和重复清理。测试使用真实原生提醒服务与受控定时器、投递函数，不进行真实 Agent 或平台外发；完整构建和安装版验收分别记录。
