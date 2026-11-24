---
id: message-response
title: 消息回应与跟进
summary: 按私聊、群消息、附件或心跳选择回应、读取上下文和跟进方式。
keywords: ["消息","私聊","群聊","回复","附件","心跳","QQ","NapCat"]
source: public example role skill
status: active
---

# 消息回应与跟进

使用收到的事件判断是否需要回应、记录、追问、转交或保持安静。要回看语境时，先读提醒指向的 `{privateLogPath}` 或 `{groupLogPath}`。

## 消息与附件
- 私聊先回应对方的语气和情绪。需要安抚或陪伴时，读 `companionship-response`。
- 群聊 @、直接回复或间接回复承接现场，说明群成员能用上的结论。普通群消息只有命中明确的路由规则时才处理。
- 文件、图片、截图和链接先从记录保留来源，再按任务检查材料。项目事实以核实结果为准。需要补充时，查过已有资料再问一个具体问题。
- 对外只用脱敏内容。内部路由、规则命中、线程状态、日志、路径、Cookie、Token 和账号隐私留在内部。

## 配置与计划
- 讲解配置读 `rabiroute-guide`，排查连接、路由和投递读 `configuration-triage`。
- 明确建立计划后读 `one-plan-one-task-tracking`，绑定正式会话并跟进。每轮心跳核对进行中计划和原任务。可推进则继续，空闲或失败按原回执恢复，待 QA 或资料时继续查证与协调，审批依据完整的 `approvalRequest` 和当前授权。
- 有适合复盘的场合时，按 `growth.md` 维护已确认的角色设定与技巧。
