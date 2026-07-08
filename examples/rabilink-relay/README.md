# RabiLink Relay Examples

这里放可以提交的 RabiLink Relay 示例文件。

这些文件只能使用占位域名、占位 token 或公开安全的示例值。真实运行中的域名、服务器 IP、Relay token、当前导入用 OpenAPI 和 handoff 记录必须放在：

```text
data/rabilink-relay/
```

Rizon 有两个相似入口：

- 新建或覆盖整个插件时，使用 `rokid-rabilink-plugin.*.example.json` 这类完整插件导入文件。
- 在插件详情页里点“导入工具”时，优先使用 `rokid-rabilink-tools-import.example.postman.json` 这种 Postman Collection 工具导入文件。

完整插件示例分三类：

- `CURRENT`：OpenAPI 内声明 `X-RabiLink-Token` security scheme，适合私有插件。
- `MANUAL_AUTH`：OpenAPI 不声明 security scheme，导入后在插件级手动配置 `X-RabiLink-Token`，适合私有插件的兼容导入。
- `AGENT_TOKEN`：公开/模板插件用，插件级不写个人 token；在智能体引用工具时把 `token` 参数绑定为该智能体自己的 RabiLink 应用 token。

插件介绍建议保留 GitHub 链接，方便用户找到安装和 token 绑定说明：

```text
RabiLinkMessage 用于把 Rokid 智能体中的语音或图片上下文转发到电脑端 RabiRoute/Codex，并把回复逐条返回眼镜。使用说明和源码：https://github.com/vb2250158/RabiRoute。公开/模板插件不要写发布者 token；请在智能体工具参数里绑定自己的 RabiLink 应用 token。
```

插件图标使用仓库根目录的 `assets/rabiroute-icon.png`。OpenAPI 示例里已写入 `info.x-logo.url` 指向 GitHub raw 图标；如果 Rizon/灵珠不自动读取 `x-logo`，就在插件编辑页手动上传这个图标。

工具导入示例只包含正式交互需要的 `submitRabiLinkTask` 和 `getRabiLinkMessages`，避免导入旧的 taskId 拉取调试接口。
如果 Rizon 的 OpenAPI 工具导入报 `convert protocol failed: inconsistent API URL prefix`，使用 Postman Collection 版。Postman 版必须写成完整 HTTPS URL，例如 `https://rabi.example.com/rokid/rabilink/tasks`；不要使用 `{{base_url}}`，Rizon 当前不会展开 Postman 变量。

校验命令：

```powershell
npm run relay:rabilink:openapi:check
```
