# 示例目录

这里放可以公开提交、可复制使用的 RabiRoute 示例。示例必须使用占位值、localhost、模板变量和脱敏路径；不要放真实 QQ 号、群号、token、Cookie、本机用户名、私聊内容或运行期 `data/` 内容。

示例不是运行前置依赖。没有 `data/route` 和 `data/roles` 时，manager 会优先复制整包 `examples/data`；缺少 examples 时才自己创建最小 QQ / NapCat 到 Codex Desktop 配置。

如果你想“把示例拖出来就能跑”，优先复制 `examples/data` 到仓库根目录的 `data`。这会得到默认 QQ 路由配置、RabiRoute 兔娘看板娘人格和对应消息模板规则。

## 示例 data 包

- `data/route/main/routeConfig.json`：默认 QQ / NapCat 到 Codex Desktop 的示例路由配置。
- `data/route/voice-chat/routeConfig.json`：FenneNote/Webhook 输入到 FenneNote 播放请求转发的 `voice_chat` pipeline preset 示例。
- `data/roles/Rabi/`：默认路由配置配套的唯一 RabiRoute 兔娘看板娘与陪伴型成长人格，包含 `growth.md`、`skills.md`、`prompts/` 和备份用 `old/`。
- `data/roles/Rabi/roleMessageConfig.json`：默认人格消息模板规则，包含 Rabi 使用的 route kind、规则和模板。
- `.env.example`：可选的环境变量样板，只用于不走 manager、直接用 env 启动单个 gateway 的场景。

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
