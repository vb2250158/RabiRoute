<!-- docs-language-switch -->
<div align="center">
<a href="./rabilink-knowledge-operation-receipts_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# 旧知识意图回执：退役入口

旧知识桥、专用意图队列、逐工具授权和手机授权编辑器已退役。本页仅保留旧文档链接的定位，不再作为运行或配置指引。旧业务配置不迁移。

通过[通用 API 传输](../apps/rabilink-aiui/docs/generic-api-transport.md)调用目标 PC 的 [Manager 接口](rabi-agent-interfaces.md)。启用并鉴权的 Agent 与本机调用者使用相同接口，不要求工作区、角色或 Route 授权。绑定仅选择自动投递目标；Relay 负责连接、鉴权和原样中转。

知识、角色、Skill 与消息状态归所属 PC。沿用目标接口实际提供的版本、身份和回执合同；写入不确定时读取原资源或原回执，不改键自动重放。

当前实现及剩余验收见 [AIUI 验收](aiui-agent-acceptance.md)和 [Relay 部署](rabilink-relay-server.md)。无需配置旧知识 URL、额外 MCP 密钥或旧权限表单。
