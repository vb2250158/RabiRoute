<a href="./dynamic-record-lifecycle_en.md">English</a> | 简体中文

# 动态整理记录统一规范

## 目标

RabiRoute 对会话、日志、ASR/TTS 元数据、计划和记忆使用统一的生命周期判断框架，但不把不同语义的数据强行使用同一种动作。

统一的是判断顺序、时间窗口、原子性、索引、幂等和验收；具体动作必须根据记录类型选择：

- 原始事实、审计流水和会话账本做无损归档。
- 近期记忆做语义沉淀。
- 日期或大小文件只做物理分卷。
- 临时缓存只有在明确保留策略授权后才能过期或删除。

## 默认双窗口

没有领域覆盖时，动态整理使用：

```text
hotWindowHours = 24
triggerAfterHours = 72
```

只有出现超过 72 小时的记录才触发一次整理；触发后处理超过 24 小时的合格范围。时间基准必须由数据集声明，不能默认都取文件 mtime。

## RabiRoute 当前映射

| 数据 | 真源 | 当前动作 | 时间语义 |
| --- | --- | --- | --- |
| 人格统一双向账本 | `data/roles/<RoleId>/conversation/current.jsonl` | 动态归档 | 有记录超过 72 小时时，将超过 24 小时的最大连续前缀移入序号归档 |
| 账本历史 | `conversation/archive/<first>~<last>.jsonl` 和 `index.json` | 保留 | 按稳定序号检索，不按自然日删除 |
| 近期记忆 | `memory/recent/*.md`，兼容旧 JSON | 沉淀 | 只有没有 `consolidatedAt` 的记录属于近期记忆；可编辑/默认显示按 `updatedAt` 与 `viewedAt`；24/72 沉淀按 `updatedAt` 与 `recalledAt`，并固定原始触发时的候选上限 |
| 已归档记忆来源 | `memory/recent/*.md` 中带 `consolidatedAt` 的记录 | 追溯保留 | 不再计入近期记忆，也不再次沉淀；在“已归档”中与归档计划一起查看 |
| 沉淀记忆 | `memory/consolidated/*.md`，兼容旧 JSON | 稳定保留 | 整理触发后生成，在独立“沉淀记忆”分类中继续参与召回 |
| 公共语音消息 | `data/speech/messages/YYYY-MM-DD.jsonl` | 日期分卷的审计流水 | 当前按自然日物理分片；这本身不是归档或沉淀 |
| 公共语音 Markdown 导出 | `data/speech/exports/transcript-*.md` | 按需重建的阅读视图 | 从公共语音消息按指定左闭右开时间段生成，不是真源 |
| RabiSpeech 诊断记录 | `plugin-adapters/rabi-speech/output/records/YYYY-MM-DD.jsonl` | 日期分卷的诊断流水 | 与人格路由记录分离 |
| 音频流收发与处理事件 | `plugin-adapters/rabi-speech/output/audio-stream-events/current.jsonl` | 动态归档的运行账本 | 稳定 `id/sequence`；有事件超过 72 小时时，将超过 24 小时的最大连续前缀移入 `archive/<first>~<last>.jsonl` 并原子更新索引 |
| 人格语音兼容记录 | `data/roles/<RoleId>/voice-transcripts.jsonl` | 兼容/审计记录 | 不替代统一双向账本 |
| 符合归档条件的终态计划 | `plans/active/<planId>/plan.json` 与 `personaConfig.json.planWorkflow` | 延迟归档 | 状态配置同时满足 `terminal=true` 与 `archiveEligible=true` 时，从 `updatedAt` 起等待 `planWorkflow.archiveAfterHours`，只将 `archiveStatus` 改为 `已归档`，保留状态 key，并把整个目录移入 `plans/archive/<planId>/`；默认模板为 72 小时 |
| TTS 音频缓存 | 人格或 RabiSpeech 音频缓存 | 到期回收 | 独立保留策略，不从账本归档规则推导 |
| ASR 短语音缓存 | `plugin-adapters/rabi-speech/output/asr-audio/` | 24 小时到期回收 | 只保存实际送入识别的 VAD 语段，供本机回听；不保存全天连续 PCM |

## 归档合同

有序账本必须：

1. 使用稳定序号定义顺序。
2. 仅移动已超过热窗口的最大连续完整前缀。
3. 先原子写入归档分卷，再更新索引，最后原子缩短当前文件。
4. 以序号范围作为幂等身份；重试不得重复记录。
5. 保持记录内容、稳定 ID、顺序和总数守恒。
6. 保留跨分卷恢复路径；当前文件找不到起点时先查索引。

## 沉淀合同

记忆整理必须：

1. 用 `max(updatedAt, viewedAt)` 计算活跃时间。
2. 默认在显式整理请求到来且存在超过 72 小时的近期记忆时启动。
3. 收集超过 24 小时且尚未沉淀的近期记忆。
4. 记录整理 run、输入 ID 和生成结果。
5. 保留来源近期记忆，并写入 `consolidatedAt` 与 `consolidationRunId`。
6. 来源文件不必移动目录，但写入 `consolidatedAt` 后在 Manager 和界面中归为“已归档”；不直接覆盖已有沉淀记忆。

Manager 会为最早的 72 小时触发点设置一次性任务；到点时重新读取记忆活跃时间，再决定是否创建和投递沉淀 run。它不使用常驻轮询。

## 分卷不是归档

`YYYY-MM-DD.jsonl` 解决单文件大小、追加和查询范围问题。它不表示：

- 数据在零点离开活跃上下文；
- 数据已被压缩或转移；
- 记忆已被总结；
- 数据已到期或被删除。

公共 ASR 可以继续按日期分卷，同时由人格 Route 把对应记录写入角色统一账本；后者独立执行动态归档。

## 新数据集接入清单

新增记录或日志前，必须写明：

- 真源、派生副本和消费者；
- 稳定 ID、排序字段和时间基准；
- 选择归档、沉淀、分卷、过期或重建中的哪一种动作；
- 24/72 默认值或明确覆盖值；
- 触发者、目标位置、索引和恢复路径；
- 幂等键、并发锁和原子提交顺序；
- 原始数据是否保留；
- 删除是否获得单独授权；
- 无丢失、无重复、边界时间、崩溃恢复和重试测试。

本机 Codex 的可复用执行规则由 `$dynamic-record-lifecycle` Skill 提供。
