简体中文 | <a href="./README_en.md">English</a>

# io.rabiroute.manager.persona

内置 Manager 插件。实例 `manager:persona` 提供 `manager.persona@1`。实现只通过 `@rabiroute/plugin-sdk` 和清单声明的版本化能力访问宿主资源。

## 角色 Skill

`GET /api/roles/:roleId/skills`、`/skills/:skillId` 与 `/download` 保留原列表、正文和完整资源包读取。编辑使用 `GET /api/roles/:roleId/skills/:skillId/source`，返回完整 `document`、文件索引和强 ETag。

创建使用 `POST /api/roles/:roleId/skills`，JSON 为 `{id,content,files?}`；`content` 是完整 `SKILL.md`，`files` 是 Skill 内相对路径到 UTF-8 内容的映射。更新使用 `PUT /api/roles/:roleId/skills/:skillId`，支持 `{content?,files?,deleteFiles?}`，未指定的附属资料保持。删除使用相同路径的 `DELETE`，从当前目录移除并在角色状态区保留恢复副本。

写入携带原 `Idempotency-Key`，更新和删除携带编辑源返回的原 `If-Match`。相同请求键与意图回读原结果，冲突返回 409，过期版本返回 412。`GET /api/roles/:roleId/skill-operations/:requestId` 查询原写入回执。全部操作沿原角色目录、连接及角色锁执行。

替换前再次核对原目录移入恢复区后的完整版本。外部修改返回 412 并恢复原内容。替换或恢复未确认时返回 `SKILL_REQUEST_UNCERTAIN` 与原请求编号，保留准备回执和恢复副本供原操作核对。

## 自动化投递模板

添加自动化时先选择默认或插件投递模板，再在原规则编辑器调整触发时间、目标 Agent、忙时策略和正文。模板展开为普通规则，后续模板更新保留用户已编辑内容，执行使用原自动化调度器。

“每天指定时间”可添加或移除多个时间点，一条规则共用动作和启停开关。输入未补全时保留草稿并阻止保存，时间有效后统一去重排序；[配置 API](../../../docs/role-configuration-api-contracts.md) 使用同一每日时间列表。

个人 Bot 的投递目标可选择 DSH，再选择 DS Bot 和实际 Bot；这不要求配置主角色会话。只有明确保存为该 DS Bot 目标的规则才显示在它的任务列表中，存储角色和 Bot 绑定人格可以不同。原主角色规则保持原目标。目录读取、原配置 revision 与原生投递回执见[DS Bot 自动化目标](../../../docs/role-configuration-api-contracts.md#ds-bot-自动化目标)。

默认包括记忆整理与 Skill 维护、阶段复盘与记忆记录、计划进展核对、消息摘要、运行状态巡检和空白消息投递。记忆整理正文要求先按主题读取记忆和已有 Skill，更新已有方法或创建新 Skill，再保存、回读并汇总结果。

`GET /api/automation/templates?limit=20&query=...&cursor=...` 返回摘要分页，`GET /api/automation/templates/:templateId` 按需返回完整投递 action。插件在原 operation 的 `discovery.automationTemplates` 声明模板，目录按活动快照缓存和刷新，坏条目单独提示。模板投递目标采用原 Agent 目标格式，应用失败保留原规则草稿。
