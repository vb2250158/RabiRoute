<!-- docs-language-switch -->
<div align="center">
<a href="./README_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# 示例 data 目录

这里是一份可以复制到项目根目录的示例 `data/` 内容。

当 `data/manager.json`、`data/route` 或 `data/roles` 不存在时，Manager 会分别复制这里的安全示例；已有文件和目录不会被整包覆盖。也可以手工复制整包。

用途：

- 提供 `manager.json` 内置插件组合示例；`manager:core` 必须启用，其他插件可以按实例关闭和局部重载。
- 提供一份名为“Rabi Demo”的完整 `data/route/main/adapterConfig.json` 示例；它通过 `agentRoleId: "Rabi"` 绑定 Rabi 本体。
- 给默认路由配置提供人格 `roles/Rabi`，并提供 RabiLink 专用的 `roles/RabiActive`。
- 给默认人格提供 `roles/Rabi/personaConfig.json` 自动化规则和最近消息投递数量；示例包含消息通知 Agent 与定时通知 Agent，不默认运行脚本。
- 给默认人格提供 `roles/Rabi/plans` 和 `roles/Rabi/memory` 的公开示例结构。
- 给默认人格提供“一计划一任务”跟踪 Skill 范例；它不绑定具体聊天平台、审批人或项目规范。
- 提供 `route/RabiLink` 与 `roles/RabiActive` 配套模板，演示 AIUI observation 的 record-first 账本、空闲/周期审阅和任务外主动下行；Relay 地址与 token 仍只在本机全局配置中填写。
- 提供默认禁用的 `route/weixin` 个人微信实验模板；登录 token、同步游标和 context token 只会在启用后写入本机运行期 `data/`，示例不包含真实账号或凭证。
- 演示本地路由配置的 `rolesDir` 应该指向 `./data/roles`。
- 让用户复制后可以直接在 WebUI 里选择并预览示例人格。

`manager.json` 默认列出十三个内置实例。其中八个服务实例没有 UI contribution：`manager:gateway-runtime`、`manager:rabilink-relay`、`manager:memory-consolidation`、`manager:fennenote-output`、`manager:message-processing-control`、`manager:message-processing-automation`、`manager:plan-feedback-delivery` 和 `manager:napcat-supervisor`。它们分别持有 Gateway 进程、Relay 连接、记忆整理、FenneNote 输出 API、消息处理控制 API、消息处理提醒、计划反馈恢复和 NapCat 启动检查的生命周期；停用实例会撤销对应入口并释放本实例持有的资源。剩余中心化可选 API 仍在迁移。

整包复制后只有 `main` 默认 Route 启用。RabiLink、voice-chat、Rokid 原生语音、XiaoAI、WeCom 和个人微信 Weixin 均为禁用模板。填写凭据或完成扫码、检查工作目录和端口后再逐条启用。

使用方式：

```powershell
xcopy examples\data data /E /I
```

```bash
cp -R examples/data/. data/
```

这里不放运行日志、真实消息、token、Cookie、真实 QQ 号或私有路径。
