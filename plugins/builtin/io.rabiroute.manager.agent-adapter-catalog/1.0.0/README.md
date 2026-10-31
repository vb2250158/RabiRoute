简体中文 | <a href="./README_en.md">English</a>

# io.rabiroute.manager.agent-adapter-catalog

内置 Manager 插件。实例 `manager:agent-adapter-catalog` 提供 `manager.agent-adapter-catalog@1`。实现只通过 `@rabiroute/plugin-sdk` 和清单声明的版本化能力访问宿主资源。

插件声明并注册 `GET /api/scan/agents`、`GET /api/scan/agents/dsh` 和 `GET /api/scan/agents/grokBot`。Grok Bot 专用扫描按显式筛选读取当前账号的原生云端会话；不会创建 Bot、任务或替代 Runtime。

候选阶段只准备本实例的目录服务与隐藏路由注册，不替换当前目录指针、不主动扫描。指针通过正式 publication 与活跃图同时切换；发布失败恢复原服务。退役只停止本实例，路由与服务清理同时开始并等待各自真实结束；重复 stop 共享同一结果，旧实例不会清空新实例指针。

当前生命周期通过可控原生 owner 与真实 Plugin Kernel fixture 验证；统一构建和目标环境运行验收由发布流程完成。扫描、连接和 Hook 操作仍沿原 API 与权限合同。
