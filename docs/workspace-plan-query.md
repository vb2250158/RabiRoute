[English](workspace-plan-query_en.md) | 简体中文

# 工作区计划查询

`POST /api/roles/:roleId/plans/query` 是只读分页查询，与 WebGUI 共用关键字递归匹配、状态/标签过滤和排序。正文支持 `query`、`cursor`、`limit`（1–250）、`view`、`sort`、`statuses` 和 `tags`。

必填 `bindingScope` 包含 `agentType`、绝对路径 `workspace` 与宿主确认存在的 `sessionIds`。任务或秘书绑定须同时匹配三项；空身份集合返回空页。过滤发生在排序、分页、总数和 facets 计算前。同一计划的多个绑定只产生一项。接口不查询 Agent 宿主，调用方负责提供当前工作区的真实会话身份。

DSH 的 Rabi 增强先通过路由人格配置匹配工作区，再按角色并行请求摘要页。按钮发现阶段不读取计划；弹窗按页加载，关闭取消读取和事件订阅。计划正文仍由 Rabi WebGUI 按需加载。

## 状态驱动推进

`GET/PUT /api/roles/:roleId/plan-advance/settings` 按人格和工作区保存状态规则。`POST .../check` 只返回候选、阻止原因、指纹及实际提示词；`POST .../run` 必须带检查得到的指纹，重新核对计划、审批、原绑定会话和空闲状态后才保留派发回执。自动推进默认关闭，状态提示词由人格配置提供。回执按工作区和计划持久去重；结果不明确时停止自动重试。派发走正式 Agent 线程桥，DSH 使用 `queue`，防止检查后出现的新回合被插入打断；真正执行前提示原会话重新读取计划。宿主提供当前工作区的真实 `sessionIds`，Rabi 不按标题猜测会话。
