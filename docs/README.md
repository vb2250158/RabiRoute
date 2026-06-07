# RabiRoute 文档

项目级文档集中放在这里。第一次部署按顺序看前两篇；要写路由或人格时看中间两篇。

## 上手与配置

- [快速上手](getting-started.md)：安装、启动 manager、接 NapCat、验证链路。
- [配置与接入](configuration.md)：`data/route`、RibiWebGUI、消息端、Agent 端、可选 NapCat 插件入口。
- [NapCat 无值守](napcat-unattended.md)：QQ 登录态、NapCat WebUI、Windows 永久环境变量和进程守护边界。

## 路由与人格

- [路由配置](routing-configuration.md)：`adapterConfig.json`、消息端、Agent 端和路由入口参数。
- [路由人格](routing-and-personas.md)：`persona.md`、`personaConfig.json`、成长型人格包、Rabi 默认看板娘示例。
- [Pipeline presets](pipeline-presets.md)：把默认输入端、输出端、TTS 和提示词输出模式打成一组。
- [语音交互工作站](voice-interaction-workstation.md)：FenneNote 转录、RabiRoute 路由、角色对话和 OumuQ TTS 的公开安全接线方式。

## 维护

- [排障](troubleshooting.md)：NapCat 登录/外发失败、Windows 中文消息乱码、Codex IPC、普通群消息不转发。
- [架构说明](architecture.md)：项目边界、分层、演进路线和红线。
