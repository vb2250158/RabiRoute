---
name: audit-rabiroute-public-docs
description: 审计并修复 RabiRoute 公共文档在本机、远端 RabiLink WebGUI 和仓库浏览三种入口中的可用性。用于新增或修改 API、报告或下载文档，处理远端链接 404，补可复制的 TTS/ASR 示例，检查中英双语同步，或发布前核对源码与部署产物一致性。
---

# 审计 RabiRoute 公共文档

把“文档里写了”验收到“目标读者从实际入口可以照做并得到结果”。同时检查本机 WebGUI、带 `/manage/<account>/<RabiGUID>/` 前缀的远端 WebGUI，以及仓库 Markdown。

## 工作流

1. 读取受影响功能的实现、OpenAPI/Schema、双语文档和 WebGUI 入口；不要从旧页面文案反推当前契约。
2. 先运行基线审计：

   ```powershell
   node skills/audit-rabiroute-public-docs/scripts/audit-public-docs.mjs
   ```

   需要判断公网是否仍在运行旧文档时，再运行只读部署检查：

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File `
     skills\audit-rabiroute-public-docs\scripts\Test-RabiLinkDocumentationRuntime.ps1
   ```

   它只读取本机构建、SSH 远端文件、计划任务和公共健康，不上传、不覆盖、不重启。`DeploymentNeeded=true` 表示本地已准备好但线上仍旧；它不是失败。

3. 把内容按读者意图拆开：完成一件事写成 how-to；端点、字段和错误写成 reference；原理和边界写成 explanation。需要详细判断时读取 [references/quality-checklist.md](references/quality-checklist.md)。
4. 在真正拥有问题的层修复：静态文件 404 修 Relay；错误的根路径修前端；缺调用路径修用户指南；契约变化同步 OpenAPI 和开发文档。
5. 为新公开能力同时补中文与英文页，并把新页加入 `ProjectDocsPage.vue` 的顺序和分组。
6. 运行审计、相关单元测试、`npm run webgui:build` 和 `npm run check:config`。最后从本机与真实远端入口各走一次关键路径。

## 三种入口契约

- 本机控制面根路径通常是 `http://127.0.0.1:8790/`。在公共概览中把回环地址写成代码，不做成让远端读者误点的链接。
- 远端 WebGUI 根路径是 `/manage/<account>/<RabiGUID>/`。运行时报告、图片和下载资源必须使用相对 URL，并由 Relay 在同一前缀下安全地提供。
- 仓库 Markdown 的相对链接必须从当前文件位置计算。不要假设浏览器的 `<base>` 与 GitHub 的文件目录相同。
- `/api/*` 与 `/assets/*` 是否重写由 Relay 实现决定；新增静态前缀时必须同时补服务器处理和回归测试。

## API how-to 最低内容

每条远端 API 指南至少包含：

- 本机与公网 Base URL 的区别；
- 前置开关、目标 PC 选择和在线要求；
- 安全的 token 占位符与请求头；
- 一条可复制的发现/健康检查；
- 一条完整成功调用，以及输出文件或响应示例；
- 常见 `401`、`409`、`502`、`504` 的含义与恢复动作；
- 不能远端执行的高风险能力，例如麦克风控制、安装模型或加载代码；
- 明确的成功判据，而不是只列端点名称。

命令示例要标明 shell。不要在同一个代码块里混写 Bash 与 PowerShell 语法。占位符统一用 `<RABILINK_APP_TOKEN>`、`<RELAY_ORIGIN>` 这类可搜索形式，并说明如何替换。

## 报告与生成产物

- 报告真源放在源码目录，构建复制到 WebGUI 静态产物；不要直接维护被忽略的 `dist/`。
- 前端链接使用相对地址，例如 `reports/example.html`，使 `<base>` 能绑定本机或远端前缀。
- Relay 只暴露明确允许的静态目录，并使用安全子路径解析阻止目录穿越。
- 报告必须写明目标机器、采样时间和结果适用范围，不能伪装成当前客户端的实时状态。

## 验收证据

交付时记录：

- 审计脚本的零错误输出；
- 中英页都能在 `/#/docs` 搜索和打开；
- 远端报告 URL 返回 `200` 和正确 `Content-Type`；
- TTS 生成非空音频，ASR 返回预期格式；
- 无真实 token、账号、私有域名、消息或本机绝对路径进入公开文件。

如果没有真实公网环境，明确标为“本地契约已验证，公网待验收”，不要把构建通过写成公网可用。
