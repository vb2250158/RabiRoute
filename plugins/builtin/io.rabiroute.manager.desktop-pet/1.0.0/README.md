<a href="./README_en.md">English</a> | 简体中文

# 桌宠 Manager 插件

该插件独立拥有桌宠资源包、绑定和素材读取 API。它从人格目录读取受限资源包，并通过 Manager 的插件路由生命周期注册 `/api/desktop-pet/`；停用或替换插件时，路由会先停止接收请求并等待已接收请求结束。

桌面窗口与动画状态仍由 RabiRoute Desktop 消费，插件不会修改人格正文、任务状态或工作结果。
