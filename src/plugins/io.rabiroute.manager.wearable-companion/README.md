简体中文 | [English](./README_en.md)

# 可穿戴健康 Companion

这个 Manager 插件把 RabiLink 可穿戴健康同步纳入当前 RabiRoute 应用代。

- Manager Plugin Kernel 激活插件并取得 Host 提供的运行身份；候选阶段不启动 worker，也不创建状态或日志目录。
- worker 只在正式 `context.publication.add.afterPublish` 成功发布、旧实例退役和取消检查后进入原有启动门；Manager startupReady 仍决定何时真正启动。
- Manager 的 `ProcessLeaseRegistry` 直接持有 PowerShell worker；插件卸载或应用代结束时释放整棵 worker 进程树。
- worker 只使用 Host READY 发布的动态 Manager URL，并在每次写入时携带 `applicationGenerationId` 与 `managerInstanceId`。
- 手机、ADB 或 PowerShell 暂不可用时进入可诊断的 degraded 状态，不创建独立计划任务，也不扫描或猜测端口。

`resources/` 中的脚本只由此插件的 worker 调用，不能作为独立生命周期入口。

发布失败保留旧 worker；旧实例清理只等待自己的进程实际 `close`，不会把 `exit` 或租约已移除当成清理完成，也不会关闭替换实例。重复 dispose 共用同一次清理。隔离测试 `src/manager/gatewayWearablePublication.test.ts` 使用受控子进程发射器与原生租约服务验证这些边界，不运行 PowerShell、ADB 或真实设备。
