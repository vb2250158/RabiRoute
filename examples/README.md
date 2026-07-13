# 示例目录

这里放可以公开提交、可复制使用的 RabiRoute 示例。示例必须使用占位值、localhost、模板变量和脱敏路径；不要放真实 QQ 号、群号、token、Cookie、本机用户名、私聊内容或运行期 `data/` 内容。

示例不是运行前置依赖。没有 `data/route` 和 `data/roles` 时，manager 会优先复制整包 `examples/data`；缺少 examples 时才自己创建最小 QQ / NapCat 到 Codex 配置。

如果你想“把示例拖出来就能跑”，优先复制 `examples/data` 到仓库根目录的 `data`。这会得到默认 QQ 路由配置、RabiRoute 兔娘看板娘人格和对应消息模板规则。

## 示例 data 包

- `data/route/main/adapterConfig.json`：默认 QQ / NapCat 到 Codex 的示例路由配置。
- `data/route/voice-chat/adapterConfig.json`：FenneNote/Webhook 输入到 FenneNote 播放请求转发的 `voice_chat` pipeline preset 示例。
- `data/roles/Rabi/`：默认路由配置配套的唯一 RabiRoute 兔娘看板娘与陪伴型成长人格，包含 `growth.md`、`skills.md`、`prompts/` 和备份用 `old/`。
- `data/roles/Rabi/personaConfig.json`：默认人格消息模板规则，包含 Rabi 使用的 route kind、规则、模板和投递时附带的最近消息数量。
- `rabilink-aiui/`：Rokid AIUI 眼镜端消息端，提供“连接对话”和“配置助手”两种模式；通过 Relay 持续接收普通回复与主动消息，并调用已绑定 PC Rabi 的配置接口。
- `.env.example`：可选的环境变量样板，只用于不走 manager、直接用 env 启动单个 gateway 的场景。
- `send-webhook-demo.mjs` / `send-webhook-demo.py`：向通用 Webhook 入口发送一条测试消息的 Node.js / Python 标准库示例。

使用方式：

```powershell
xcopy examples\data data /E /I
```

```bash
cp -R examples/data/. data/
```

复制后可以直接在 WebUI 里看到默认 QQ 路由配置和 RabiRoute 兔娘看板娘人格。

如果需要用环境变量启动单个 gateway，可以再复制：

```powershell
copy examples\.env.example .env
```

```bash
cp examples/.env.example .env
```

Rabi 只保留这一份示例，避免同一人格出现多份副本。

## Webhook 发送示例

先启动一条包含 `webhook` 消息端的路由，并确认它监听类似下面的地址：

```text
http://127.0.0.1:8791/webhook
```

Node.js 版本：

```bash
node examples/send-webhook-demo.mjs
```

Python 版本：

```bash
python examples/send-webhook-demo.py
```

也可以显式传入 endpoint 和消息正文：

```bash
node examples/send-webhook-demo.mjs http://127.0.0.1:8791/webhook "来自外部系统的测试任务"
python examples/send-webhook-demo.py http://127.0.0.1:8791/webhook "来自外部系统的测试任务"
```
