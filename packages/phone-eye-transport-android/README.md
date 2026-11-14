[English](README_en.md) | 简体中文

# 手机与眼镜 Android 传输

此 Android 库提供手机端 HTTP、流式响应、WebSocket 升级传输和可配置有效期的设备租约。Rabi 手机应用通过 Gradle 项目依赖使用同一份实现。

调用方负责验证每个请求、设备身份、权限和上游目标；此库不提供认证，也不选择 Rabi Manager 或 DSH Host。服务在所有网络接口监听系统分配的端口，调用方必须在处理请求前完成授权。现有 JSON 便捷构造器保留供 Rabi 使用，流式接口可供其他宿主接入。

当前仅完成 Rabi 接入迁移，DSH 接入和眼镜真机验证尚未完成。
