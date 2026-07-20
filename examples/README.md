<!-- docs-language-switch -->
<div align="center">
<a href="./README_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# 示例目录

这里放可以公开提交、复制和检查的 RabiRoute 示例。示例只使用占位值、localhost、模板变量和脱敏路径；不要写入真实 QQ 号、群号、token、Cookie、本机用户名、私聊内容或运行期 `data/`。

示例不是运行前置依赖。首次启动时，如果 `data/route` 或 `data/roles` 对应目录不存在，Manager 会从 [`examples/data/`](./data/README.md) 分别复制路由和人格示例。现有目录不会被整包覆盖。

## 从这里开始

想先运行主项目，优先复制 [`examples/data/`](./data/README.md) 到仓库根目录的 `data/`。这会得到一条默认启用的 QQ / NapCat + heartbeat 路由，以及 Rabi 人格、消息规则、计划和记忆结构示例。

整包中只有 `main` 默认启用。RabiLink、Rokid 原生语音、voice-chat、WeCom 和 XiaoAI 都是需要凭据、设备或外部服务的禁用模板，不会在首次复制后自动连接。

```powershell
xcopy examples\data data /E /I
```

```bash
cp -R examples/data/. data/
```

## 示例地图

| 目录 | 成熟度 | 用途 |
| --- | --- | --- |
| [`data/`](./data/README.md) | 当前示例 | 可复制的 Route、Persona、计划和记忆数据包。 |
| [`rabilink-relay/`](./rabilink-relay/README.md) | 当前示例 | Relay 工具导入和鉴权配置样板，不包含真实 token。 |
| [`rabi-link-vela-probe/`](./rabi-link-vela-probe/README.md) | 历史探针 | vela 手环验证应用，保留为设备调查证据。 |
| `.env.example` | 可选样板 | 不经过 Manager、直接用环境变量启动单 Gateway 时使用。 |
| `send-webhook-demo.*` | 当前示例 | 向通用 Webhook 入口发送测试文本。 |

手机伴侣和眼镜端已经是可独立构建、验收和发布的产品工程，统一放在 [`apps/`](../apps/README.md)，不再归类为示例。

## Webhook 发送示例

先启动一条包含 `webhook` 消息端的 Route，并确认它监听的地址，例如：

```text
http://127.0.0.1:8791/webhook
```

使用零依赖的 Node.js 或 Python 示例：

```powershell
node examples/send-webhook-demo.mjs
python examples/send-webhook-demo.py
```

也可以显式传入 endpoint 和正文：

```bash
node examples/send-webhook-demo.mjs http://127.0.0.1:8791/webhook "来自外部系统的测试任务"
python examples/send-webhook-demo.py http://127.0.0.1:8791/webhook "来自外部系统的测试任务"
```

## 公开安全边界

示例数据必须保持可公开、可复制。真实设备凭据、用户消息和运行日志只能留在本机配置或运行期目录，不应补进这些模板。
