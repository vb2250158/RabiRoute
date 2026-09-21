---
name: rabiroute-developer-publish
description: RabiRoute 开发发布兼容入口。构建、部署或检查改动是否生效时转到 rabiroute-build，并按当前发布合同选择完整包或 Web 补丁。
---

# 开发发布入口

先读 [构建与部署](../rabiroute-build/SKILL.md)、[Windows 发布合同](../../docs/windows-launcher-and-packaging.md) 和 [Web 补丁合同](../../docs/web-hot-patches.md)。保留此名称用于历史调用；不维护第二套安装流程。

核对源码、构建候选和实际安装载荷的版本。Manager 的完整地址与 applicationGenerationId、managerInstanceId 来自当前 Host status 或源码 READY；读取 `/meta` 验证身份后再请求业务接口。不得使用旧端口或直接启动 Manager。

Web 补丁需核对当前合同中的兼容指纹、已激活候选及根 HTML 资源版本；后台或共享合同变化按完整发布处理。构建完成、补丁候选生成、安装完成和运行生效分别报告。构建期间发生应用切代时重新发现并核验当前身份，不把自动恢复当成发布成功。

构建受宿主环境注入影响时先定位具体变量及失败原因，按支持的构建环境处理，不以关闭权限或安全检查绕过错误。保留活动任务与运行数据；只有发布操作包含重启授权时，才通过 Host 的正式入口执行。
