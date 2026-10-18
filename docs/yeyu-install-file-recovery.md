# 安装目录独有文件恢复

## 2026-10-19 安装门禁复核

基线 `fe8faba91d748441c01f7f723a1bd7054aeb6b3e`。对下列文件执行 `git hash-object --no-filters`、`git hash-object --path=<path>`，逐一比较 `git log --all -- <path>` 的历史 `<commit>:<path>` blob，四个均未匹配；Git 换行规范化后仍不匹配。

| File | Raw installed blob | Git-filtered blob |
| --- | --- | --- |
| `src/agentAdapters/yeyuGamerManagerApi.test.ts` | `16cb794eecea4bb8e68eba8c315cc946b468a592` | `16cb794eecea4bb8e68eba8c315cc946b468a592` |
| `src/agentAdapters/yeyuGamerManagerApi.ts` | `986db734db190128033fcf216e1018b2b4532314` | `986db734db190128033fcf216e1018b2b4532314` |
| `scripts/extract-mgq-dialogue-candidates.mjs` | `32206e4ec9bd6560d28daa525083d231400f3442` | `48336386aeded243670d5d10ee96498f06db608d` |
| `scripts/extract-rgss-dialogue-events.mjs` | `12abdcc6968724729ef74d25fd092516441d96b4` | `8a22e706539f8280bb02e8709a19a954296bb013` |

安装 API 副本保留完整旧客户端及 enabled 测试，main 仅转导出 integrations 唯一实现并验证身份。脚本差异仅为机器专属默认路径，main 要求显式参数。PR #16（`88dc43d38a3120f29d5410a93161a63125678670`）已通用化这些文件，但语义可解释不等于 blob 完全相同。

本次仅提交脱敏裁决证据，不恢复旧逻辑或私有路径。安装停止，未构建、安装、重启 Host、验证 send 或删除备份。需明确裁决后才能继续，不能将本文当作部署验收。


[English](yeyu-install-file-recovery_en.md) | 简体中文

本次仅将安装目录中的手工修改整理为 PR，不安装、不部署、不操作 Host、Manager 或游戏工具。

## API 文件

原来的 `src/agentAdapters/yeyuGamerManagerApi.ts` 已迁移到 `src/integrations/yeyuGamer/managerApi.ts`。恢复的旧路径仅重新导出唯一实现，供安装目录中尚未迁移的导入使用；不重新注册路由，不恢复旧的客户端 enabled 开关。启用状态仍归插件 Profile，现有请求授权和超时处理保持不变。待这些外部导入全部迁移后可删除兼容路径；仓库运行入口仍直接使用 integrations 实现。

旧测试中的有效合同已由新位置的测试覆盖。恢复路径的测试验证导出身份一致，不复制旧 Schema 和旧配置断言。

## 离线提取脚本

仅处理使用者已合法取得的本地文件，不访问 Manager，也不启动游戏。必须显式提供所有路径；已移除安装目录副本中的机器专属默认路径。

```powershell
node scripts/extract-mgq-dialogue-candidates.mjs ./translation.json ./reports/candidates
node scripts/extract-rgss-dialogue-events.mjs ./Data ./translation.json ./reports/events
```

首个脚本从翻译字典提取 Alice / Ilias 标签、后续窗口及名字提及。第二个读取已解包的 Ruby Marshal 4.8 `.rvdata2` 事件文本；不负责解包游戏。输出 JSONL 与摘要，应保留在本地，不提交原始文本或报告。

这些是研究候选而非可靠的完整说话人归属。事件脚本仅识别目标标签，其他标签和事件分支可能导致归属延续；解析失败记录在错误报告中。不要把候选直接用作正式人格或完整语料。
