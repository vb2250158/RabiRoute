# RabiRoute 文档

项目级文档集中放在这里。第一次部署按顺序看前两篇；要写路由或人格时看中间两篇。

## 上手与配置

- [快速上手](getting-started.md)：安装、启动 manager、接 NapCat、验证链路。
- [配置与接入](configuration.md)：`data/gateways.json`、RibiWebGUI、消息端、Agent 端、可选 NapCat 插件入口。

## 路由与人格

- [路由配置](routing-configuration.md)：route kind、`routes.json`、`routeProfiles`、`regex`、模板正文和真实换行规范。
- [路由人格](routing-and-personas.md)：`persona.md`、成长型人格包、Rabi 默认看板娘示例。
- [语音交互工作站](voice-interaction-workstation.md)：FenneNote 转录、RabiRoute 路由、角色对话和 OumuQ TTS 的公开安全接线方式。

## 维护

- [排障](troubleshooting.md)：NapCat 外发失败、Windows 中文消息乱码、Codex IPC、普通群消息不转发。
- [架构说明](architecture.md)：项目边界、分层、演进路线和红线。
