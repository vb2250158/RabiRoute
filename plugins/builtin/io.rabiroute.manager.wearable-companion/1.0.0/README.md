# 可穿戴健康 Companion

这个 Manager 插件把 RabiLink 可穿戴健康同步纳入当前 RabiRoute 应用代。

- Manager Plugin Kernel 激活插件并取得 Host 提供的运行身份。
- Manager 的 `ProcessLeaseRegistry` 直接持有 PowerShell worker；插件卸载或应用代结束时释放整棵 worker 进程树。
- worker 只使用 Host READY 发布的动态 Manager URL，并在每次写入时携带 `applicationGenerationId` 与 `managerInstanceId`。
- 手机、ADB 或 PowerShell 暂不可用时进入可诊断的 degraded 状态，不创建独立计划任务，也不扫描或猜测端口。

`resources/` 中的脚本只由此插件的受管 worker 调用，不能作为独立生命周期入口。
