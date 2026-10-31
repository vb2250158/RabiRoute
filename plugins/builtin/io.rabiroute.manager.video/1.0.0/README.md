[English](README_en.md) | 简体中文

# 视频生成插件

提供独立视频页面、任务 API、H3 工作流与任务持久化。默认启用页面，GPU 服务由用户从页面启动。通过 `host.manager.video@1` 获取限定的本机进程租约与合同工厂，通过 `host.manager.operations@1` 注册受 Manager 鉴权的 API；Manager 事件与原条件正文读取器仍来自 `host.manager.http@1`。

同一定义安装 34 个固定入口和 1 个原生动态模型 exchange，并进入活动目录；包括 PNG/MP4/WAV、Range、SSE、项目与算力回执。插件当前模块创建的原生 owner 直接注入工厂，不包装旧 HTTP 分发。方法、正文、恢复和退役边界见[可执行接口合同](../../../../docs/video-api-contract.md)。

请求授权由 Host 提供 `requestAccess(request)`；插件在异步等待和 fs/process/network/stream 派发前复核。已接受后台任务归插件生命周期，不持有原请求权限。撤销返回脱敏 403；写入结果区分 `not_started` 与 `unknown`，不承诺回滚。

完整安装、接口、数据位置与验收边界见 [视频生成插件说明](../../../../docs/video-generation-plugin.md)。模型和私有运行数据不包含在此包内。

任务与项目按文件隔离损坏记录，原文件不改写；状态和项目列表的 `recordIssues` 返回受影响 ID、范围与原因，正常记录继续可用。可识别的坏任务幂等键仍被保留，重复身份均不自动执行。若原任务文件完全无法解析幂等键，仅该任务域（本地任务或算力任务）的未匹配提交返回 409，已有合法回执、另一任务域、模型管理与项目继续工作；恢复原文件并重新加载插件后重新核对，不通过换 ID 重发。
