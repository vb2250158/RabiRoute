简体中文 | <a href="./README_en.md">English</a>

# io.rabiroute.manager.remote-agent

内置 Manager 插件。实例 `manager:remote-agent` 提供 `manager.remote-agent@1`。实现只通过 `@rabiroute/plugin-sdk` 和清单声明的版本化能力访问宿主资源。

候选 Hub 构造只保存引用，不启动发现、连接或任务。公开 Hub 指针通过正式 publication 提交；发布失败恢复原 Hub，失败候选只回收自己。退役先停止本 Hub 接收，再等待本路由和 Hub 的真实回调、socket 关闭；旧实例不会清空或关闭新 Hub。重复 shutdown 等待同一清理 Promise，强制终止请求仍须等实际 socket 关闭。

生命周期通过可控原生 owner 和 Plugin Kernel fixture 验证，真实远端设备验收仍待发布流程完成。连接鉴权、任务归属和公开接口权限语义保持原合同。
