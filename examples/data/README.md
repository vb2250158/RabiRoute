# 示例 data 目录

这里是一份可以复制到项目根目录的示例 `data/` 内容。

没有 `data/route` 和 `data/roles` 时，manager 会优先复制这一整包示例；也可以手工复制。

用途：

- 提供一份完整的 `data/route/main/adapterConfig.json` 示例。
- 给默认路由配置提供角色 `roles/Rabi`，并提供 RabiLink 专用的 `roles/RabiActive`。
- 给默认人格提供 `roles/Rabi/personaConfig.json` 消息模板规则和最近消息投递数量。
- 给默认人格提供 `roles/Rabi/plans` 和 `roles/Rabi/memory` 的公开示例结构。
- 给默认人格提供适用于旅游、调研、设计、实施、排障等所有计划的“一计划一会话任务追踪”角色 Skill 范例；它不绑定 QQ 群认领、具体审批人或项目实现规范。
- 提供 `route/RabiLink` 与 `roles/RabiActive` 配套模板，演示 AIUI observation 的 record-first 账本、空闲/周期审阅和任务外主动下行；Relay 地址与 token 仍只在本机全局配置中填写。
- 演示本地路由配置的 `rolesDir` 应该指向 `./data/roles`。
- 让用户复制后可以直接在 WebUI 里选择并预览示例人格。

整包复制后只有 `main` 默认路由启用。RabiLink、FenneNote、Rokid 原生语音、小爱和企业微信均作为禁用模板出现；填写各自凭据、检查工作目录和端口后再逐条启用，避免首次启动时抢占端口或连接占位服务。

使用方式：

```powershell
xcopy examples\data data /E /I
```

```bash
cp -R examples/data/. data/
```

这里不放运行日志、真实消息、token、Cookie、真实 QQ 号或私有路径。
