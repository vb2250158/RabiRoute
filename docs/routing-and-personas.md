# 路由与人格

路由规则、`routes.json`、route kind、`regex` 和消息模板写法见 [路由配置](routing-configuration.md)。这里专门讲人格包。

## 路由人格

RabiRoute 的“人格”不是单独一段 prompt，而是一个角色包。角色包同时决定两件事：

- `persona.md`：这个角色如何说话、如何判断消息、如何整理上下文、哪些事不能做。
- `routes.json`：这个角色关心哪些 route kind、普通群消息用什么关键词触发、命中后给处理端什么模板。

一个角色目录通常包含：

```text
<RoleId>/
├── persona.md
├── routes.json
├── growth.md
├── skills.md
└── prompts/
```

公开示例：

- `examples/data/roles/Rabi/persona.md`
- `examples/data/roles/Rabi/routes.json`
- `examples/data/roles/Rabi/`

Rabi 示例是 RabiRoute 默认的兔娘看板娘与陪伴型成长人格样例，主要演示 `persona.md`、`routes.json`、`growth.md`、`skills.md` 和 `prompts/` 如何配合。真实项目可以在本地 `data/<gateway-id>/roles/<RoleId>/` 里扩展更完整的直接 @、回复、私聊、关键词和成长规则。

一个 gateway 可以同时拥有多个路由人格。每个角色目录里的 `routes.json` 会被 manager 组装成一个 route profile；这些 route profile 共用同一个 gateway 的消息端适配器。

```text
data/roles/Rabi/routes.json
data/roles/QAReviewer/routes.json
data/roles/DevAssistant/routes.json
```

上面三套路由都会使用同一个 NapCat WebSocket 监听端口和同一个 NapCat HTTP 地址。不要为了多个路由人格复制多个 gateway，除非它们真的对应不同 QQ 号、不同平台账号或不同监听端口。

本地使用时，推荐直接复制示例 data 包：

```powershell
xcopy examples\data data /E /I
```

```bash
cp -R examples/data/. data/
```

也可以只复制单个人格到 gateway 的角色目录：

```powershell
xcopy examples\data data /E /I
```

然后在 WebUI 的 `路由人格` 中选择 `Rabi`。选择人格后，转发给处理端的提示末尾会追加角色文件路径，消息记录也会写入该角色目录。

项目内还提供了一个开源 skill，用来指导创建新人格：

- `skills/create-rabiroute-persona/SKILL.md`

它说明了如何一起设计 `persona.md` 和 `routes.json`，让角色既有稳定气质，也有对应的路由触发策略。
