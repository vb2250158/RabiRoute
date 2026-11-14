[English](tool-wait-probe_en.md) | 简体中文

# 官方模型工具等待插话诊断

此探针只用于开发验收，不可作为眼镜安装包或生产后端。它在临时目录构建真实 Rabi 页面，再注入一个隔离工具适配器；普通打包入口从不加载探针。模型仍通过官方宿主 `LanguageModel` 创建，使用真实共享会话、动作解析、输入记录和排队流程。

## 验证范围

第一次请求让模型发现接口并调用 `/fixture/slow`。适配器挂起其回执，随后将两条固定转写送入页面 `handleTranscriptionResult`：一道算术题和一个 `/fixture/next` 查询。第一条应在等待期间回答；第二条应延后。随后放行原回执，等待原任务完成，再由第二条输入的独立轮处理后续查询。

诊断核对两条输入状态、原任务尚在等待、全局前缀、两份独立回执、两个接口各一次及后续接口执行时原任务已结束。转写、工具结果和记录存储均为夹具，未覆盖麦克风、扬声器、持久化、真实 HTTP 或后端工作。

## 运行

```powershell
node scripts/Test-AiuiToolWaitProbe.mjs
node scripts/Build-AiuiToolWaitProbe.mjs C:\Users\<user>\Downloads\candidate-tool-wait-probe.aix
```

构建器要求绝对路径和 `-tool-wait-probe.aix` 后缀；已有目标拒绝覆盖。通过 Studio 新建智能体菜单导入 AIX，选择该本地草稿，进入模拟调试并运行，触发语音唤醒。输入：

> 请先查可用接口，再查询 /fixture/slow 的结果；拿到结果后告诉我回执编号。

脚本随后自动注入两条测试转写。日志 `ToolWaitProbe result` 必须显示 `passed:true`，不能仅凭 HUD 文字判断通过。页面隐藏时清理探针计时器，未知结果不冒充成功。

## 2026-11-06 实测

- 0.7.1 真实模型完成算术插话与原任务，但第二条输入为 unconfirmed。诊断增强包确认原因为 `defer-text`：模型的 defer 附带文字，不是请求或输入 ID 不符。
- 0.7.2 将有界说明纳入 defer 合同并丢弃其展示内容。真实模型重新完成整个流程，`answered` 与 `deferred` 均发生在原工具等待中；原任务与新任务结果正确，两接口各一次，日志 `passed:true`。
- 通过的诊断包为 `rabilink-aiui-1.0.39-defer-fix-tool-wait-probe.aix`，SHA-256 `78e78af89963649fe1cd8d64493bbc7b9e5ac25156a9afe363e50dd5bf273ba4`，126453 字节，VERSION `e434a2b0-166b-4481-afb9-ed1535077a7e`。只导入 Studio 本地草稿，未云端保存或安装。
- 本机证据：`studio-tool-wait-defer-text-20261106.png`、`studio-tool-wait-passed-20261106.png`。Web host 仍缺少 `speech.synthesize`；未证明声音、声学打断或实机效果。

正式候选与此诊断包分开，选择包时以[当前交付状态](aiui-voice-current.md#当前交付与验收状态)为准。
