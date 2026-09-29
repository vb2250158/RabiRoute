# AIUI Agent 工具合同核对

[English](agent-tool-contract_en.md) | 简体中文

状态：官方文档已核对，完整工具结果续轮接口尚未证实；不是设备验收报告。

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

该研究没有启动或调用真实宿主。不能把 `main` 称为最新发行 runtime，也不能据此断言结果提交 API 不存在；结论仅是目前公开证据未证实，仍需实际宿主类型、版本或官方实现证据。当前保持单步执行，不猜测 API。

## 当前实现边界

AIUI 页面中的宿主模型是眼镜 Agent 的执行者。PC 提供 HTTP 工具服务，不替代该模型，也不要求 QuickJS 启动 stdio。Skill 是受限的指引资料；MCP 配置引用不代表工具已经连接或加载。

在工具结果续轮接口未经官方类型、实现或真实宿主验证前：

1. 可实现受控 HTTP 工具请求与明确结果展示，但必须标明这是单步应用执行，不宣称完整自动多步 Agent 循环。
2. 使用 `callId` 去重，限制允许工具与参数；写操作保留稳定幂等意图，超时不能换键重放。
3. 模型文字不得替代真实工具回执；工具输出视为不可信数据，不作为新增权限。
4. 不通过第二模型或静默切到 PC Agent 掩盖宿主能力缺口。

## 后续验收

必须记录真实宿主版本、工具调用事件、同一 `callId` 对应的执行回执及官方支持的续轮结果；再验证取消、超时、重复事件和权限拒绝。现有模拟测试、文档与模型可用性检查均不能替代真机证据。
