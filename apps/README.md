<!-- docs-language-switch -->
<div align="center">
<a href="./README_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# 客户端应用

`apps/` 保存可以独立构建、验收和发布的 RabiRoute 客户端。应用可以使用 Manager、Relay 或共享 SDK，但不拥有 PC 端 Route、Persona、Agent 会话或 Action Gate 的最终状态。

| 目录 | 平台 | 职责 |
| --- | --- | --- |
| [`rabilink-android/`](./rabilink-android/README.md) | Android 手机 + Rokid 眼镜 | 会话列表与单聊、持续消息、远程配置、可穿戴健康入口，以及随手机构建的眼镜前端。 |
| [`rabilink-aiui/`](./rabilink-aiui/README.md) | Rokid AIUI | 眼镜前台 Agent 消息端、配置助手、AIX 打包和验收；当前暂停新增产品功能。 |

共享 Android 通讯契约位于 [`packages/android-sdk/`](../packages/android-sdk/README.md)。可复制 Route/Persona 与 Relay 样板仍位于 [`examples/`](../examples/README.md)。
