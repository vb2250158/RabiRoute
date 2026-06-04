# 示例目录

这里放可以公开提交、可复制使用的 RabiRoute 示例。示例必须使用占位值、localhost、模板变量和脱敏路径；不要放真实 QQ 号、群号、token、Cookie、本机用户名、私聊内容或运行期 `data/` 内容。

示例不是运行前置依赖。没有 `data/gateways.json` 时，manager 会优先复制整包 `examples/data`；缺少 examples 时才自己创建最小 QQ / NapCat 到 Codex Desktop 配置。

如果你想“把示例拖出来就能跑”，优先复制 `examples/data` 到仓库根目录的 `data`。这会得到默认 QQ gateway、RabiRoute 兔娘看板娘人格和对应路由规则。

## 示例 data 包

- `data/gateways.json`：默认 QQ / NapCat 到 Codex Desktop 的示例配置。
- `data/default-main/roles/Rabi/`：默认 gateway 配套的 RabiRoute 兔娘看板娘与陪伴型成长人格，包含 `growth.md`、`skills.md`、`prompts/` 和备份用 `old/`。
- `.env.example`：可选的环境变量样板，只用于不走 manager、直接用 env 启动单个 gateway 的场景。

使用方式：

```powershell
xcopy examples\data data /E /I
```

```bash
cp -R examples/data/. data/
```

复制后可以直接在 WebUI 里看到默认 QQ gateway 和 RabiRoute 兔娘看板娘人格。

如果需要用环境变量启动单个 gateway，可以再复制：

```powershell
copy examples\.env.example .env
```

```bash
cp examples/.env.example .env
```

## 路由人格示例

- `roles/Rabi/`：默认兔娘看板娘与陪伴型成长人格示例，包含 `persona.md`、`routes.json`、`growth.md`、`skills.md` 和 `prompts/`。

复制到本地 gateway 的角色目录：

```powershell
mkdir data\default-main\roles
copy examples\roles\Rabi\persona.md data\default-main\roles\Rabi\persona.md
copy examples\roles\Rabi\routes.json data\default-main\roles\Rabi\routes.json
```
