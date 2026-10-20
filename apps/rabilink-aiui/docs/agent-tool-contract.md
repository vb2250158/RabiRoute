# AIUI Agent 工具合同核对

[English](agent-tool-contract_en.md) | 简体中文

状态：原生工具结果提交 API 未证实；应用已使用官方支持的普通消息实现执行循环，真实宿主待验收。

## 官方依据

已读取官方站点公开内容接口返回的 `0.18.0`（`v0.18.x`）正文，而非只读到网页外壳：

- [模型文档页面](https://js.rokid.com/AIUI/api/ai/language-model?lang=zh-CN&version=0.18.0)
- [公开正文接口](https://js.rokid.com/api/aiui/docs/content?version=0.18.0&locale=zh-CN&sourcePath=3-api%2Fai%2Flanguage-model)
- [该版本源文档](https://raw.githubusercontent.com/jsar-project/AIUI/v0.18.x/documentation/3-api/ai/language-model.md)

文档明确支持 `LanguageModel.create({initialPrompts, tools})`、`prompt(input)`、`promptStreaming(input)`、`clone()`、`destroy()`，并要求同一会话同时只有一个活跃请求。工具事件字段为 `callId`、`functionName`、`arguments`、`toolType`、`index`、`isComplete`。`arguments` 通常已解析为对象。

文档示例只监听 `toolcall` 后执行应用逻辑，没有给出工具结果回传方法或带 `tool_call_id` 的消息结构。结构化消息明确说明 `user`、`system`、`assistant`，没有证明 `tool` role 可用。因此不能凭方法猜测加入 `respondWith`、`submitToolResult`，也不能把普通用户文本提示当成官方工具结果通道。

## 补充官方仓库核查

后续六次定向公开抓取确认：`jsar-project/AIUI` 的 GitHub API 重定向到 `yodaos-project/AIUI`。对 `main` 与 `v0.18.x` 的模型正文核查仍只找到 `toolcall` 事件及应用处理示例，未找到按 `callId` 提交执行结果并续轮的合同。

- [main README](https://raw.githubusercontent.com/yodaos-project/AIUI/main/README.md) 将项目定位为 Developer Tools & Skills。
- [main 模型正文](https://raw.githubusercontent.com/yodaos-project/AIUI/main/documentation/3-api/ai/language-model.md) 是此次文档核查依据，不代表当前设备安装版本。
- [固定提交目录树](https://api.github.com/repos/yodaos-project/AIUI/git/trees/0fc2d412bf60859ffa2acab6b72375bee3584807?recursive=1) 中的 packages 包含 `cloud-integration`、`create-aiui-agent`，未提供可据以验证结果续轮的宿主 `LanguageModel` 实现。

该研究没有启动或调用真实宿主。不能把 `main` 称为最新发行 runtime，也不能据此断言结果提交 API 不存在；结论仅是目前公开证据未证实，仍需实际宿主类型、版本或官方实现证据。应用改用明确的观察消息续轮，不猜测原生结果提交 API。

## 当前实现边界

AIUI 页面中的宿主模型是眼镜 Agent 的执行者。PC 提供 HTTP 工具服务，不替代该模型，也不要求 QuickJS 启动 stdio。Skill 是受限的指引资料；MCP 配置引用不代表工具已经连接或加载。

2026-10-10 补读 [官方 AI 类型参考](https://raw.githubusercontent.com/yodaos-project/AIUI/main/skills/aiui-dev/references/apis/ai.md)。其明确：请求输入允许 `user`、`assistant`，工具事件在请求完成后发送；同一会话保留消息历史，并且同时只能有一个活跃请求。`AgentWorker` 是页面/组件生命周期 Worker，不提供另一个模型结果提交合同。

默认对话现在使用应用管理的决策协议：原生工具声明为空，模型返回完整动作 JSON；应用通过已有受管工具执行后，将实际结果作为 `user` 消息中的明确应用观察交回同一个模型。观察携带工具调用编号、不可信标记及真实结果，身份和权限仍由角色及连接合同拥有。此实现不使用或声称提供原生 `tool` role、`tool_call_id` 或自动 JavaScript 工具执行。

执行器检查当前请求编号、已连接工具、参数、幂等状态及限额，格式无效或半个动作不执行。模型循环的夹具证明结果会进入下一次推理，真实宿主行为仍需验收。详见 [执行循环](agent-turn-runtime.md)。

## 后续验收

必须记录真实宿主版本、应用动作、同一调用编号对应的执行回执及观察驱动的后续推理；再验证取消、超时、重复事件和权限拒绝。现有模拟测试、文档与模型可用性检查均不能替代真机证据。

`rabi_api_help` 和 `rabi_api_call` 使用同一个通用 Manager 传输。可选 `targetDeviceId` 选择已鉴权其他电脑；默认目标在本轮开始时固定。同一 `operationId` 的目标、方法、路径、正文摘要参与操作指纹，未知写入不能换目标重发。Relay 不注册每个业务接口，也不根据角色或配置版本分发。详见[接口传输](generic-api-transport.md)。
