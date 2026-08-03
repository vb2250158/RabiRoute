<!-- docs-language-switch -->
<div align="center">
<a href="./maintainer-security-gates_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# PR 安全门禁

> 状态：现行维护指南。门禁定义在 `.github/workflows/pull-request-security.yml`。

面向 `main` 的 Pull Request 会运行三条彼此独立的安全检查：

| 检查 | 阻断条件 | 边界 |
| --- | --- | --- |
| Secret scan (Gitleaks) | 提交历史中出现疑似秘钥 | 命中后先轮换真实凭据；只从最新文件删除并不能撤销泄露 |
| Production dependency audit | `npm audit --omit=dev --audit-level=high` 发现生产依赖的 High / Critical 漏洞 | 不把开发依赖告警混入发布阻断，也不自动执行 `npm audit fix` |
| SAST (CodeQL) | JavaScript / TypeScript 默认安全查询发现需阻断的问题 | 结果进入 GitHub Code Scanning；仍需人工检查鉴权、路径、进程、网络和 Agent 工具边界 |

工作流也支持维护者手动运行。三个 Job 互不依赖，因此可以一次看到完整失败面，而不是修完一项后才发现下一项。

## 工作流自身的信任边界

- 使用 `pull_request`，不使用会给外部贡献代码更高权限的 `pull_request_target`。
- 默认 `GITHUB_TOKEN` 只有 `contents: read`；只有 CodeQL Job 增加 `security-events: write` 和 `actions: read`。
- Checkout 不持久化凭据。
- 第三方和 GitHub Action 均固定到完整 commit SHA，避免可移动标签在未审查时改变执行代码。
- PR 内不安装依赖，也不运行仓库的构建、安装脚本或测试代码。依赖审计只读取 lockfile 并查询 npm advisory 服务。
- Gitleaks 的 PR 评论和报告 artifact 上传已关闭，减少额外写权限与敏感报告留存；失败摘要仍保留在本次 Job 日志中。

## 合并保护

工作流提交并在 GitHub 上成功运行后，在 `main` 的 branch protection 或 ruleset 中把以下检查设为必需：

- `Secret scan (Gitleaks)`
- `Production dependency audit`
- `SAST (CodeQL)`

仅存在工作流文件不等于禁止合并；必需检查由 GitHub 仓库设置负责。修改工作流、忽略规则或 Action SHA 时，应作为安全边界变更单独审阅。

## 处理失败

1. 先确认失败对应的提交和文件，不要把报告中的疑似值复制到 Issue、PR 评论或聊天。
2. 秘钥命中时先撤销或轮换凭据，再清理 Git 历史；隐藏日志不能恢复已经泄露的凭据。
3. 依赖审计失败时查看生产依赖链，选择受控升级并复核 lockfile；不要在 CI 中自动修复。
4. CodeQL 命中时从不可信输入追到特权操作，补修复和负向测试，再重新运行门禁。
5. 确认误报时记录最小范围、规则 ID、理由和复核人；不要使用宽泛路径排除。

这些门禁是发布前筛查，不替代人工审查、普通测试、构建、配置校验、安装包内容检查或已安装版本验收。
