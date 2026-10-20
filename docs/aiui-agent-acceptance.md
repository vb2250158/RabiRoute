<!-- docs-language-switch -->
<div align="center">
<a href="./aiui-agent-acceptance_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# AIUI Agent 接入与验收

当前为实验实现。源码自动化测试与真机验收分别记录；服务器部署、安装版本、平台上传和眼镜端到端验证以目标环境的验收记录为准。

AIUI 使用乐奇配置的模型、ASR 和 TTS。绑定角色后沿用角色资料、Skill 与消息记录；默认访问角色所属 PC，也可明确选择其他 PC。角色、工作区和 Route 绑定不限制已鉴权连接的接口权限。未绑定角色仍可调用 Manager 接口；启用的远端 Agent 同样可调用全部业务接口。

## 新版合同

| 要求 | 实现归属 | 验收状态 |
| --- | --- | --- |
| 角色、Skill、默认 PC 与聊天记录 | 角色所属 PC，设备保存绑定引用；模型归乐奇 | 源码接线与隔离测试；移动端保存到眼镜下一轮的真机验证待完成 |
| 当前及未来 Manager 接口 | 通用 HTTP 契约与目标 PC；Relay 不维护业务接口白名单 | 通用请求与未知接口测试已覆盖；在用服务器与新 PC 版本联调待完成 |
| 跨 PC 能力 | 目标 PC 身份、应用连接与同一通用传输 | LAN、P2P、Relay 与独立 Manager 双向消息、正式回复 HTTP 测试；公网双 PC 与眼镜实际路径待验证 |
| Route 自动投递 | `deviceAgent` 适配器、所属 PC 投递队列、眼镜模型 owner | 原 deliveryId、会话纪元、冒领与拒绝路径测试；真实消息唤醒及接收待验证 |
| 唤醒请求 | 手机领取 nonce，通过已配置的乐奇自定义指令唤醒眼镜 | 普通应用发送双指广播曾被真机拒绝；公开章节仅说明接收事件，发送能力尚待证实 |
| 输出与语音 | 同一眼镜 Agent 输出句子调用原生 TTS，ASR 同时接收 | 源码与模拟事件测试；真实 ASR/TTS 并行及回声排除待验证 |
| 语音插入引导 | 非回声 ASR 文本停止 TTS，完整输入引导后续推理 | 不取消推理的测试；真实宿主行为待验证 |

`queued`、唤醒已提交和网络 ACK 都是过程状态。只有指定会话 owner 领取原消息后，投递才确认接收；结果还需原 sessionId、ownerEpoch 和 claimToken 回传。失联、切代和未知写入先读取原回执，不换 ID 重发或改用 PC 模型。

跨电脑投递由原 PC 保存唯一请求记录，设备所在 PC 只保存运输消息和回执。接收前回查原记录，接口来源由当前签名连接验证；公开代号和裸请求头不能声明设备身份。详见[精确投递与正式回复](agent-endpoint-delivery.md)。

## 配置与更新

移动端入口为“全天记录 → 设备 → 眼镜 → 眼镜设置 → 当前使用的角色”。设备绑定时明确选择拥有连接与投递状态的 PC；角色可以来自其他 PC。不同的归属分别保存引用，不能通过旧默认任务目标猜测。

所有客户端按新版合同更新。旧业务授权、知识工具白名单与服务器业务别名退役，不迁移旧业务配置；旧数据保留在私有备份。真实消息任务、身份和回执仍按原身份核对，不能把旧记录丢失当成新消息。

## 验收步骤

1. 更新 PC、Relay、手机与 AIUI 候选，核对实际运行 generation、资源 hash 和包版本。
2. 绑定一个角色，确认下一轮使用对应资料、Skill 与默认 PC，模型仍由乐奇配置；检查移动端对应角色聊天记录。
3. 未绑定角色及启用但未绑定 Route 的远端 Agent，调用另一个工作区和另一个 PC 的接口，确认权限不受绑定限制。
4. 新增一个目标 PC 接口，仅更新 PC；保持同一 Relay，确认设备可发现并调用。
5. 两次向同一眼镜会话投递原消息；验证唤醒、领取、响应及重复投递去重。关闭眼镜 owner，确认只排队并显示真实失败原因。
6. 推理中和 TTS 中分别说话，确认 ASR 工作、文字出现后只停播报、完整输入引导同一任务，且没有双回复或回声输入。
7. 分别验证 LAN、P2P 和 Relay，记录实际选择及回退原因；模拟断网、重启与撤销连接，确认不重放未知写入。

## 相关文档

- [设备 Agent 接入](device-agent-adapter.md)
- [精确投递与正式回复](agent-endpoint-delivery.md)
- [角色与设备配置 HTTP](aiui-agent-profile-http.md)
- [通用 API 传输](../apps/rabilink-aiui/docs/generic-api-transport.md)
- [Agent 执行循环](../apps/rabilink-aiui/docs/agent-tool-contract.md)
- [Peer Tunnel](rabilink-peer-tunnel.md)
- [Relay 部署与职责](rabilink-relay-server.md)
