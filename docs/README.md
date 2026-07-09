# RabiRoute 文档

项目级文档集中放在这里。第一次部署按顺序看前两篇；要写路由或人格时看中间两篇。

## 上手与配置

- [快速上手](getting-started.md)：安装、启动 manager、接 NapCat、验证链路。
- [配置与接入](configuration.md)：`data/route`、RibiWebGUI、消息端、Agent 端、可选 NapCat 插件入口。
- [NapCat 无值守](napcat-unattended.md)：QQ 登录态、NapCat WebUI、Windows 永久环境变量和进程守护边界。

## 路由与人格

- [路由配置](routing-configuration.md)：`adapterConfig.json`、消息端、Agent 端和路由入口参数。
- [路由人格](routing-and-personas.md)：`persona.md`、`personaConfig.json`、成长型人格包、Rabi 默认看板娘示例。
- [人格路由工作台计划](persona-route-workbench-plan.md)：人格配置页改造成 route 绑定、规则预览、AgentPacket 预览和诊断工作台的闭环设计。
- [计划和记忆机制](plan-and-memory-model.md)：说明计划、近期记忆、沉淀记忆、托盘视图和 Agent 获取上下文的方式。
- [Agent 需要关注的 Rabi 接口](rabi-agent-interfaces.md)：给 Agent 注入的计划、记忆和内置触发接口说明。
- [Agent 上下文注入说明](agent-context-injection.md)：说明默认注入项、按需注入项和最终投递给 Agent 的消息格式。
- [Pipeline presets](pipeline-presets.md)：把默认输入端、输出端、TTS 和提示词输出模式打成一组。
- [RabiLink Relay 公网中继](rabilink-relay-server.md)：当前 Rokid/灵珠和手机端 RabiLink 主链路，使用服务器应用 token、PC worker 直连、账号隔离和远程 PC WebGUI。
- [RabiLink 原生主动智能应用设计](rabilink-glasses-app-design.md)：原生手机常驻录音桥、随身本地 Agent、`Rabi Glass` HUD、手机配置主控台和 `RabiLink Lab` 测试入口收纳方案。
- [手机 App 远程接入历史方案](mobile-app-webhook-integration.md)：早期 Webhook / WebSocket 双向接入设计稿，仅作历史参考；当前 RabiLink 主链路以上一篇为准。
- [小米手环心率列表探针交接](xiaomi-band-heart-rate-probe-handoff.md)：Android APK / Vela 快应用探针、云端心率列表拉取、ZIP 证据包解析和下一台电脑继续开发说明。
- [语音交互工作站](voice-interaction-workstation.md)：FenneNote 转录、RabiRoute 路由、角色对话和 OumuQ TTS 的公开安全接线方式。
- [企业微信接入](wecom-integration.md)：企业微信智能机器人 WebSocket 双向群聊消息端设计、配置、模板变量和回传边界。

## 维护

- [排障](troubleshooting.md)：NapCat 登录/外发失败、Windows 中文消息乱码、Codex IPC、普通群消息不转发。
- [架构说明](architecture.md)：项目边界、分层、演进路线和红线。
- [代码架构](code-architecture.md)：后端 Module、消息主链路、manager 控制面、WebGUI 和常见修改入口。
- [项目功能手册](project-function-map.md)：通用项目功能地图，按功能索引数据真源、消费点、生效时机、副作用、代码入口和设计边界。
- 项目功能搜索页：在 RibiWebGUI 左侧栏底部 `GitHub` 按钮下面点击 `项目文档`，或访问 `/#/docs`。
- [Windows 桌面启动与完整打包](windows-launcher-and-packaging.md)：Windows 托盘入口、WebGUI 前端、Node 后端和完整桌面运行包的唯一真源。
