<!-- docs-language-switch -->
<div align="center">
<a href="./README_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# Archive

这里只保留没有运行时依赖、且尚有独立迁移价值的非 Codex 归档材料。`archive/` 不参与 TypeScript 构建，也不能作为新代码的依赖来源。

旧 Codex Desktop IPC、独立 app-server 多 Runtime 和共享 4510 Runtime 实现已从工作树删除；需要追溯时使用 Git 历史。当前真实消息链路只保留 `RabiRoute -> Codex Desktop IPC -> Desktop task owner`，实现见 `../src/codexDesktopBridge.ts` 与 `../src/codexRuntime.ts`。
