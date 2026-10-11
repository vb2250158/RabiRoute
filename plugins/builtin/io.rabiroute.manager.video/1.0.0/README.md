[English](README_en.md) | 简体中文

# 视频生成插件

提供独立视频页面、任务 API、H3 工作流与任务持久化。默认启用页面，GPU 服务由用户从页面启动。通过 `host.manager.video@1` 获取限定的本机进程租约，通过 `host.manager.http@1` 注册受 Manager 鉴权的 API 与事件。

请求授权由 Host 提供 `requestAccess(request)`；插件在异步等待和 fs/process/network/stream 派发前复核。已接受后台任务归插件生命周期，不持有原请求权限。撤销返回脱敏 403；写入结果区分 `not_started` 与 `unknown`，不承诺回滚。

完整安装、接口、数据位置与验收边界见 [视频生成插件说明](../../../../docs/video-generation-plugin.md)。模型和私有运行数据不包含在此包内。
