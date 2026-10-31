简体中文 | <a href="./README_en.md">English</a>

# io.rabiroute.manager.napcat-supervisor

内置 Manager 插件。实例 `manager:napcat-supervisor` 提供 `manager.napcat-supervisor@1`。实现只通过 `@rabiroute/plugin-sdk` 和清单声明的版本化能力访问宿主资源。

候选准备不启动 guardian，也不改全局启动或停止函数。正式 `context.publication` 发布同步安装本 activation 的函数并固定配对控制上下文；同步发布失败按引用身份恢复原函数。旧实例清理只停止自身，不会清除新实例的函数。

发布后的 `afterPublish` 等待 `previousRetirement` 确认旧 supervisor 完整停止，再允许新 guardian 运行。等待期间的启动请求不能绕过屏障；旧实例退役失败或超时会拒绝屏障，新 guardian 保持未启动，失败交回 kernel 处理。只读模式或关闭自动启动时不安装 supervisor。

Manager 监听器和 Route 目录均就绪后才执行启动登录。每个 activation 只尝试一次启动登录；同一 guardian 的失败恢复不重复登录。退役会取消并等待本 guardian，进程绑定和 QQ 寿命继续由原 `NapcatLifecycleOwner` 管理。受控同 Manager 替换、回滚和失败候选回归位于 `src/manager/napcatPluginPublication.test.ts`，不使用真实账号。
