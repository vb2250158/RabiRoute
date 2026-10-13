---
name: rabiroute-developer-publish
description: RabiRoute 开发发布兼容入口。区分构建验证、原生源码/Web 热补丁与完整安装包交付，并核对运行生效证据。
---

# 开发发布入口

先读 [构建与部署](../rabiroute-build/SKILL.md) 与[源码热补丁工作流](../source-hot-patch-development/SKILL.md)，按改动读取 [Web 补丁合同](../../docs/web-hot-patches.md) 或 [Windows 发布合同](../../docs/windows-launcher-and-packaging.md)。保留此名称用于历史调用；不维护第二套安装流程。

核对源码、构建候选和实际安装载荷的版本。Manager 的完整地址与 applicationGenerationId、managerInstanceId 来自当前 Host status 或源码 READY；读取 `/meta` 验证身份后再请求业务接口。不得使用旧端口或直接启动 Manager。

普通修改默认准备不可变候选，校验后原生热替换，不要求额外开启开关、设置环境变量或另起 watcher；后端、共享合同及新增模块变化按实际兼容性与状态迁移结果处理，不一律完整发布。Web 补丁核对兼容指纹、已激活候选和根 HTML 资源版本；源码补丁核对实际激活回执、活动修订及原场景。当前版本缺少目标能力时交原维护 owner 修复并验证，不把待实现能力写成已支持。

用户明确要求完整发布或安装包、首次安装，或有具体诊断证明 Host/native 运行时、依赖 ABI 或活动状态无法在当前进程安全替换时，按完整发布合同处理。候选准备和预检期间保留旧服务；进程切换由 Host 执行。构建完成、候选生成、安装完成和运行生效分别报告；切代后重新发现并核验身份。

构建受宿主环境注入影响时先定位具体变量及失败原因，按支持的构建环境处理，不以关闭权限或安全检查绕过错误。保留活动任务与运行数据；只有发布操作包含重启授权时，才通过 Host 的正式入口执行。
