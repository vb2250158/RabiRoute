# 路由人格示例

每个子目录是一套可公开的人格包，通常包含：

```text
<RoleId>/
├── persona.md
└── routes.json
```

## 示例列表

- `Rabi/`：轻量 QQ / NapCat 路由人格示例。

## 编写规则

- `persona.md` 使用正常 Markdown 和真实换行。
- `routes.json` 只按 JSON 要求转义一次。
- 不提交真实 QQ 号、群号、token、Cookie、本机用户名、私聊内容或运行期 `data/` 内容。
- WebUI 文本框里不要输入字面量 `\n`；如果看到可见 `\n`，说明模板被双重转义。
