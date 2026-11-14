<!-- docs-language-switch -->
<div align="center">
<a href="./README_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# 首次启动的 Route 模板

新工作区首次启动时，配置归口把这些模板复制到 `data/route`。`main` 默认启用，其余模板保持禁用；已有 Route 不会被这些默认值覆盖。

自有监听端口使用 `0`，启动后由原监听器分配可用端口。请求地址取自当前 Route 状态或 API 发现公布的实际地址，不从模板端口拼接 URL。需要固定端口时，可以显式保存一个非零端口。

`main.napcatHttpUrl` 是外部 NapCat HTTP 服务的示例地址，使用前应核对实际 QQ 实例。微信的厂商地址及其他显式外部服务地址保持原协议，不参与 Rabi 监听端口分配。

`voice-chat` 不预设本机 TTS URL，使用已配置的当前 Speech 服务。显式配置的外部 TTS 地址仍然有效。

小爱模板保留自动端口配置；独立桥接的实际监听地址和转发方式见[小爱桥接说明](../../../src/plugins/xiaoai-rabiroute/README_zh.md)。此模板不新增 Gateway 原生小爱监听器。旧 FenneNote 端口字段已退役，不会从模板恢复该入口。
