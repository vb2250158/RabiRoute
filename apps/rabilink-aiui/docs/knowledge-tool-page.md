# AIUI 知识工具页面接线

[English](knowledge-tool-page_en.md) | 简体中文

状态：页面方法与主页面实际接线已实现，本机知识、配置、模型代际和运行归属回归通过；本机 AIX 测试包已构建并解析核验，最新集成回归按验收矩阵记录；尚未正式安装或真机验收。HUD 只显示至多 22 字符的独立工具状态，点击同时刷新设备配置和知识目录；详细结果保留为页面纯文本数据，不注入模型。

手机设备 profile 仅通过启用 `id: "rabi-knowledge"` 的 MCP 引用选择此受控服务。它不是授权：目录还必须由真实设备凭据请求，并返回可用角色。用户需明确说“使用知识角色 <ID>”，ID 必须在目录中；即使只有一个角色也不自动选择。未选择时不向模型声明知识工具。

应用回执仅在当前模型已注册只读工具、作用域/角色/目录仍匹配且所有启用服务均为 `rabi-knowledge` 时确认；未知服务或等待重建仍报告未就绪。界面明确“模型与只读知识工具已应用；写入未启用”，不把只读可用解释为写入授权。

主页面接线顺序：

1. 引入并展开 `knowledgeToolPageMethods`；HUD 使用有界显示副本，原始结果不直接铺满页面。用户明确说“读出工具结果”或“下一条工具结果”后才在回复区分段显示并朗读，详见[结果阅读](knowledge-result-view.md)。
2. 设备配置应用后和用户手动刷新时调用 `refreshKnowledgeTools()`；不新增轮询。语音处理优先检查 `selectKnowledgeRoleFromSpeech(text)`，命中后不再作为普通对话发送。
3. 新一轮标 busy 之前调用 `applyPendingKnowledgeTools()`。角色或目录变更只影响下一轮，不打断当前推理。
4. 创建模型前 `const knowledge = await prepareKnowledgeTools()`，将 `knowledge.tools` 追加到模型 options.tools。监听器闭包捕获 `knowledge.runtime`，调用 `handleKnowledgeToolCall(event, knowledge.runtime)`；不能改用可能属于下一模型的全局 runtime。
5. 释放模型同时 `cleanupKnowledgeRuntime()`；取消播报调用 `cancelKnowledgePresentation()`。这些操作不声称撤销已发出的 PC 请求。归属变更调用 `invalidateKnowledgeTools()`。

账本使用独立 wx 键，仅保留设备凭据指纹作用域、递增模型会话编号及当前会话最多 128 个调用记录。发送前保存，重复调用不会再次发出；不保存原始凭据。结果以文本与固定摘要呈现，不执行工具内容，也不把结果伪装成宿主支持的模型续轮。首版仅广告只读工具，近期记忆 touch 和写工具不开放。
