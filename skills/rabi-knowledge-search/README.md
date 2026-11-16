[English](README_en.md) | 简体中文

# 安装 Rabi 记忆与计划搜索

面向项目维护者。任务检索先完成至少一次统一搜索，读取返回内容与覆盖，再选择详情查询、调整关键词或搜索本地文件。已知文件、旧规范、示例和直接协作同样执行；Rabi 发现、连接、查询或承载检索的工具失败时，记录一次实际错误，本轮跳过同一故障并继续本地检索与原任务。技能沿现有 API 工作。

源文件为本目录的 `SKILL.md` 和 `agents/openai.yaml`。将整个目录复制到目标项目 `.agents/skills/rabi-knowledge-search/`，并在项目 `AGENTS.md` 加入：

```markdown
- 任务检索先读 `.agents/skills/rabi-knowledge-search/SKILL.md`；Rabi 可用时先完成至少一次 `/api/search`，读取 `label`、`excerpt`、覆盖与 `handle`，再选择详情查询、调整关键词或本地搜索。已知文件、旧规范和直接协作同样执行；Rabi 发现、连接、查询或承载检索的工具失败时，记录一次实际错误，本轮跳过同一故障并继续本地检索与原任务。
```

安装前核对目标目录：首次安装创建目录，升级时先比较差异并保留项目修改，再同步源文件；复制后检查 `AGENTS.md` 路径是否可达。项目副本是本地化的派生版，`README.md`、`README_en.md` 等在项目里可能已被改写，不要用整目录覆盖。

上游改动后的差异比对和基线记录使用脚本，不靠人记得：

```powershell
pwsh -NoProfile -File scripts/Test-ProjectSkillSync.ps1 -ProjectPath <项目根>
pwsh -NoProfile -File scripts/Test-ProjectSkillSync.ps1 -ProjectPath <项目根> -Check
```

第一条报告每个技能相对基线的漂移，第二条作为门禁（不是 `in-sync` 或被目标项目 `AGENTS.md` 引用缺失时返回非零），移植完成后用 `-UpdateBaseline` 记录新基线。判定含义和 Agent 流程见 [项目技能的分发与漂移检测](../../docs/project-skill-distribution.md)。

统一搜索的角色范围和调用方身份元数据可省略，连接仍需既有鉴权；技能不保存机器地址、访问密钥或角色绑定。连接和请求遵循 [SKILL.md](SKILL.md) 的动态地址、有限超时和离线兜底。项目专属连接配置留在项目，不改写 Rabi 的通用正文。

用户级完整分发与宿主筛选使用同页的 agentSkills 流程。手工安装到项目时同时移植 napcat-qq-gateway 消息查询说明，或改成项目自己的现行说明，不留下缺失的相对链接。统一搜索架构可在 RabiRoute 源码文档中查阅。
