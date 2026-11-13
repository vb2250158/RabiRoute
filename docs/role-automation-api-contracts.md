[English](role-automation-api-contracts_en.md) | 简体中文

# 通过请求管理角色自动化

Agent 与角色页面使用同一份规则。已鉴权连接可通过请求查询、新建、修改、启停和删除自动化，无需直接编辑角色文件。保存规则不会立即执行其 Agent 或脚本动作；后续触发沿用原自动化运行机制。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/roles/:roleId/automation-rules` | 列出规则；支持 `query` 名称/ID搜索及 `enabled=true\|false` |
| GET | `/api/roles/:roleId/automation-rules/:ruleId` | 读取一条规则 |
| POST | `/api/roles/:roleId/automation-rules` | 创建规则 |
| PATCH | `/api/roles/:roleId/automation-rules/:ruleId` | 局部修改或设置 `enabled` |
| DELETE | `/api/roles/:roleId/automation-rules/:ruleId` | 删除规则 |

操作 ID 为 `manager.roles.automations.list/read/create/update/delete`，从当前 `GET /api/agent/help` 取得可执行合同。路径参数须 URL 编码。通用 Agent 客户端按目录调用，无需增加逐接口映射。Agent Hook 使用[角色配置 PATCH](role-configuration-api-contracts.md)的 `codexHooks` 字段。

读取返回 `data.roleId`、`data.revision`，以及 `data.rules` 或 `data.rule`。列表中的损坏项单独列入 `data.warnings`（原位置 `index`、可得的原 `ruleId` 和提示），正常规则继续可读和编辑；直接读取已知损坏项返回 409，不存在项返回 404。未修改的坏项原样保留；修正目标项时提交完整有效内容，没有稳定 ID 的损坏记录通过角色配置 PATCH 修正，不自动补成新规则或删除原数据。

所有写入携带稳定的 `Idempotency-Key` 和请求体 `expectedRevision`。revision 来自自动化响应或 `GET /api/roles/:roleId/configuration`，不同于正文接口的整包 revision。并发锁冲突返回 409，旧版本返回 412。

创建请求体：

```json
{
  "expectedRevision": "<configuration revision>",
  "rule": {
    "id": "daily-review",
    "name": "每日检查",
    "enabled": true,
    "trigger": {
      "type": "schedule",
      "schedule": { "id": "daily", "type": "daily_time", "timeOfDays": ["09:00", "14:00"] }
    },
    "action": {
      "type": "deliver_agent",
      "target": { "kind": "recipient", "recipientId": "primary" },
      "message": "检查当前计划并处理可执行事项。"
    }
  }
}
```

`timeOfDays` 支持一个或多个 `HH:mm` 或 `HH:mm:ss` 每日时间；存在时优先于旧字段 `timeOfDay`。保存规则不会推进已存定时配置版本。

省略 `rule.id` 时，后端根据角色和操作键生成稳定 ID。显式 ID 沿用原生去除首尾空白的行为，不能为空；已有 ID 返回 409。消息触发使用 `trigger.type=message`；脚本动作使用 `action.type=run_script` 和明确的 `scriptPath`。完整字段与 Agent 目标规则由活动合同及原生校验拥有。

修改请求为 `{ "expectedRevision": "...", "patch": { "enabled": false } }`。省略字段保留原值，相同类型的 trigger/action 和定时设置可局部合并；切换类型时提供新类型必填字段。规则 ID 不允许通过 PATCH 改名。删除请求体为 `{ "expectedRevision": "..." }`；其他规则保留，已删除的默认规则不会重建。

成功写入返回 `code=0`、`state=committed`、原 `operationId` 与新配置 revision，确认后端配置提交。实际投递、脚本执行、跨电脑同步另按后续真实回执判断。超时、`uncertain=true` 或 `mutationOutcome=unknown` 时保留原键和原载荷，按同一请求核对原回执，不从新配置重拼重试内容。已提交请求的重复调用返回原结果，不覆盖后续编辑。

本文描述当前源码合同；安装版支持情况与真实消息触发需分别验证。发现接口本身不确认写入或动作执行。
