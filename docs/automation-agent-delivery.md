[English](automation-agent-delivery_en.md) | 简体中文

# 自动化中的 Agent 投递目标

Agent 端设置定义可用接收者和运行参数；角色自动化规则决定每条消息投给谁。配置主角色、秘书或消息处理池不会改变其他规则的目标。

## 页面配置

在「角色 → 自动化」编辑规则，在「通知 Agent」下选择「投递目标」：

- 主角色：使用当前路线的主角色绑定。
- 计划秘书：使用消息关联计划的秘书绑定。缺少计划或秘书绑定时失败，不选择其他计划的秘书。
- 消息处理 Agent：使用现有消息处理池、任务状态和模型配置。
- 记忆整理 Agent：创建或复用现有整理会话。
- 自定义：依次选择 Agent 端和指定会话。会话下拉支持输入名称或 ID 搜索，列表以名称为主、完整 ID 和工作目录为辅，可继续加载更多。切换 Agent 会清空旧会话；未选齐 Agent 和会话时不能点“完成”。选定后可展开会话详情。

修改后保存。刷新后应看到相同目标。修改主角色绑定会影响之后引用主角色的规则；已选定的自定义会话不随之变化。

## 数据归属

角色 `personaConfig.json` 的 `automationRules[].action.target` 保存目标。引用接收者时仅保存稳定 ID；接收者目录 `agentRecipients` 和现有 Agent 会话、模型及实例参数保存在路线的 Agent 配置中。

```json
{
  "id": "private-to-primary",
  "enabled": true,
  "trigger": { "type": "message", "routeKinds": ["private"] },
  "action": {
    "type": "deliver_agent",
    "target": { "kind": "recipient", "recipientId": "primary" },
    "template": ""
  }
}
```

自定义目标保存 `kind: "session"`、`agentTargetId`、`agentAdapter`、`sessionId`、`sessionName`、`workspace`。同名会话按实例和完整 ID 区分。指定会话接口不会通过名称创建替代任务。

共享角色的规则可用 `sourceRouteIds` 限定适用路线；未设置时适用于所有引用该角色的路线。默认规则只在初始化或迁移时产生，读取已保存规则不会补回删除项。

## 升级与恢复

升级前先预览受影响角色；每次传入引用该角色的完整路线目录：

```powershell
node --import tsx scripts/migrate-agent-delivery-targets.ts --persona data/roles/Example/personaConfig.json --routes data/route
# 核对预览后执行同一命令并添加 --apply
```

迁移器将旧消息池、记忆整理开关的投递范围转换成显式规则。同一角色在不同路线上的旧行为不同时，生成带路线条件的规则。原会话 ID、秘书绑定、模型、池状态和其他角色字段保持原值。转换前保存原始文件快照，写入前检查并发修改，写入后逐文件回读；失败则恢复已写文件，遇到外部修改时保留快照并报告冲突。版本标记防止重复迁移。旧目录格式可通过 `ManagerConfigRepository.migrateLegacyConfigs()` 的显式维护流程转换；Manager 启动不执行全目录同步迁移。

运行时缺少目标的旧规则会失败，需先迁移，不能依靠旧开关再次选目标。运行代码中已退出消息池和记忆整理的隐式目标选择。旧字段仅供迁移识别；计划系统自身使用的配置仍按原合同工作。

失败记录保存原规则、接收者目录及已解析的会话。批量重试分别保留原投递身份，不合并成新的主角色消息。原绑定失效时失败；无目标快照的历史记录不能自动重试。指定会话投递保存待确认状态和回执；结果不确定时查询原会话，未确认前不重复发送。

## 验证范围

单元和集成测试覆盖目标选择、并发隔离、原回执恢复、迁移回滚、保存和规则投影。部署验收还需确认新页面资源和 Manager 版本，以及本地、远端目标会话的实际回执。构建通过不代表真实投递已通过。
