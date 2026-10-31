[English](persona-identity-api-contracts_en.md) | 简体中文

# 角色身份关系 API 的可执行合同

本组负责原身份关系、候选观察和声纹身份接口。可执行合同用于 HTTP 分发与远端发现；身份事件、冲突分支、文件锁和去重仍由原 `identityRelations`、`personaVoiceIdentities` owner 执行。

| 操作 ID 后缀 | 方法 | 角色下路径 |
| --- | --- | --- |
| `relations.read` | GET | `/:roleId/identity-relations` |
| `relations.patch` | PUT | `/:roleId/identity-relations` |
| `observations.append` | POST | `/:roleId/identity-relations/observations` |
| `voice.read` | GET | `/:roleId/voice-identities` |
| `voice.patch` | PUT | `/:roleId/voice-identities` |

每项均保留 `/api/roles` 与 `/roles` 两个前缀，共 10 个具体路由。完整 ID 使用 `manager.personas.identities.` 前缀；`/roles` ID 增加 `.alias`。原 `knowledge`、`knowledge-alias` 派生 ID 保留为别名。已鉴权空远端节点可以调用全部公开操作，不增加角色、上下文或逐功能许可。身份被确认也不扩大业务授权。

## 原记录与观察约束

关系读取保留完整目录和按 platform、endpointIdentityNamespace、senderStableId 三项共同查询的账号上下文；conversationKey/projectId 只用于原上下文筛选。返回原冲突状态与候选分支，不把不同分支合成唯一确定身份。

关系维护保留 endpoint_account、participant、relation_card 三类原补丁，沿用原文本规范化、列表限额、状态、引用检查和 event-head 冲突消解。相同稳定记录的无变化补丁返回 200；追加新事件返回 201。没有显式 participantId/relationId 的创建可能生成新 ID，不能把重复提交当作天然幂等。

候选观察仍要求原账号已有唯一候选参与者关联，参与者未冲突且仍是 candidate，并含可追踪的源 messageId。候选观察不能覆盖已确认账号、身份或关系，也不能把显示名当作确认依据。

## 声纹关联与恢复

声纹读取保留全表和 sourceHostId+voiceprintId 共同查询。显式 participantId 必须指向当前角色中 confirmed/corrected 且无冲突的参与者；它是对象一致性检查。字段遗漏保留原绑定，显式 null 撤销原关联并退役旧账号 links；删除与重放沿用原声纹事件语义。

关联更新仍先写原身份关系账本，再写声纹账本，并发布原两类 Manager 事件；不新增跨账本事务或删除已提交历史。原 mutator 已开始后失败、部分账本已提交或事件/代际复核失败时，返回不确定标记。调用者应读取两个原接口，核对稳定 ID 与当前字段后继续，不能盲目生成新记录或回滚历史。

每次请求在消费正文前捕获当前角色目录、连接和 Manager 身份，在原写入与事件发布前后复核。换根或取消发生在写前时不会开始 native mutation；写后变化不能返回旧业务结果。正文保持原生产入口 `maxBytes=0` 和空 `{}` 语义，未知字段不构成额外功能授权。

## 验证与范围

隔离 HTTP 回归覆盖全部 10 个路由的真实空节点鉴权、原观察与去重、同角色声纹关联、遗漏/null/删除重放、原冲突分支、双账本部分提交与不确定回执、写后代际变化，以及写前换根与取消。测试使用临时原生账本，不写真实身份或声纹数据。

该组不改变角色生命周期、角色配置、业务任务授权或其他 owner。源代码定向通过不代表安装版或真实设备验收；其他旧 prefix 入口须在各自迁移后再删除。
