简体中文 | <a href="./README_en.md">English</a>

# io.rabiroute.manager.agent-adapter-catalog

内置 Manager 插件。实例 `manager:agent-adapter-catalog` 提供 `manager.agent-adapter-catalog@1`。实现只通过 `@rabiroute/plugin-sdk` 和清单声明的版本化能力访问宿主资源。

插件声明并注册 `GET /api/scan/agents`、`GET /api/scan/agents/dsh` 和 `GET /api/scan/agents/grokBot`。Grok Bot 专用扫描按显式筛选读取当前账号的原生云端会话；不会创建 Bot、任务或替代 Runtime。
