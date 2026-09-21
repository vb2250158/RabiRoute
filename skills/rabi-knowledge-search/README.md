[English](README_en.md) | 简体中文

# 安装 Rabi 记忆与计划搜索

面向项目维护者。技能让 Agent 在 Rabi 在线时先查询计划和记忆，再定位文件；Rabi 离线时直接使用普通搜索。无需修改 Manager 或安装 Hook。

源文件为本目录的 `SKILL.md` 和 `agents/openai.yaml`。将整个目录复制到目标项目 `.agents/skills/rabi-knowledge-search/`，并在项目 `AGENTS.md` 加入：

```markdown
- 查找资料、历史决定、预定安排或任务线索时，先读 `.agents/skills/rabi-knowledge-search/SKILL.md`；Rabi 在线时先查记忆和计划，再按需搜索文件，离线直接普通搜索。
```

安装前核对目标目录：首次安装创建目录，升级时先比较差异并保留项目修改，再同步源文件；复制后检查 `AGENTS.md` 路径是否可达。项目副本是本地化的派生版，`README.md`、`README_en.md` 等在项目里可能已被改写，不要用整目录覆盖。

上游改动后的差异比对和基线记录使用脚本，不靠人记得：

```powershell
pwsh -NoProfile -File scripts/Test-ProjectSkillSync.ps1 -ProjectPath <项目根>
pwsh -NoProfile -File scripts/Test-ProjectSkillSync.ps1 -ProjectPath <项目根> -Check
```

第一条报告每个技能相对基线的漂移，第二条作为门禁（不是 `in-sync` 或被目标项目 `AGENTS.md` 引用缺失时返回非零），移植完成后用 `-UpdateBaseline` 记录新基线。判定含义和 Agent 流程见 [项目技能的分发与漂移检测](../../docs/project-skill-distribution.md)。

当前任务需要已有的相关人格范围与受支持的连接入口；技能不保存机器地址、访问密钥或人格绑定。连接和请求遵循 [SKILL.md](SKILL.md) 的动态地址、有限超时和离线兜底。项目专属连接配置留在项目，不改写 Rabi 的通用正文。

用户级完整分发与宿主筛选使用同页的 agentSkills 流程。首轮群消息历史查询还引用 napcat-qq-gateway；手工安装到项目时同时移植该引用，或改为项目自己的现行消息查询说明，不留下缺失的相对链接。
