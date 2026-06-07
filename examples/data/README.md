# 示例 data 目录

这里是一份可以复制到项目根目录的示例 `data/` 内容。

没有 `data/route` 和 `data/roles` 时，manager 会优先复制这一整包示例；也可以手工复制。

用途：

- 提供一份完整的 `data/route/main/adapterConfig.json` 示例。
- 给默认路由配置提供唯一角色 `roles/Rabi`。
- 给默认人格提供 `roles/Rabi/personaConfig.json` 消息模板规则。
- 演示本地路由配置的 `rolesDir` 应该指向 `./data/roles`。
- 让用户复制后可以直接在 WebUI 里选择并预览示例人格。

使用方式：

```powershell
xcopy examples\data data /E /I
```

```bash
cp -R examples/data/. data/
```

这里不放运行日志、真实消息、token、Cookie、真实 QQ 号或私有路径。
