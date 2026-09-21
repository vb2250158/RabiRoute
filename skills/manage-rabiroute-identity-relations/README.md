[English](README_en.md) | 简体中文

# 安装 RabiRoute 身份关系管理技能

面向需要维护人格身份定位的维护者与 Agent。技能让处理端按账号查“这是谁”、确认或纠正人物、处理多电脑并发冲突与共用账号，并在对话现场只提交候选观察。

源文件为本目录的 `SKILL.md`。使用方式二选一：

- RabiRoute 仓库内直接读 `skills/manage-rabiroute-identity-relations/SKILL.md`。
- 安装到其他项目时，复制 `SKILL.md` 到目标项目 `.agents/skills/manage-rabiroute-identity-relations/SKILL.md`，并在项目 `AGENTS.md` 加入引用：

```markdown
- 处理人格身份定位、确认或纠正账号归属、排查认错人时，先读 `.agents/skills/manage-rabiroute-identity-relations/SKILL.md`。
```

本技能已列入 `project-skills.json` 的用户级 `agentSkills`，`install=true`、`audience=runtime`、`hosts=["*"]`；它不属于该清单中面向下游项目 `.agents/skills/` 本地化副本的 `skills` 条目。用户级安装遵循 `agentSkills` 分发流程；若需纳入下游项目技能同步，应先登记项目 `skills` 清单再复制，避免出现无人维护的漂移副本。

安装前核对目标目录：首次安装创建目录，升级时先比较差异并保留项目修改。技能不保存机器地址、访问密钥或人格绑定；连接与请求遵循 `SKILL.md` 的动态地址与实例身份核对要求。

数据真源与字段定义见 [接口合同](../../docs/rabi-agent-interfaces.md) 的「身份关系记忆接口」一节，页面入口与成熟度见 [项目功能手册](../../docs/project-function-map.md)。
