# 公共技术文档质量清单

## 信息类型

- **How-to**：从读者目标出发，给出前置条件、步骤、成功判据和恢复动作。
- **Reference**：稳定列出 Base URL、鉴权、端点、字段、响应和错误，不夹带漫长操作叙事。
- **Explanation**：解释为什么有本机/远端两条链、权限边界和架构取舍。
- **Tutorial**：只在需要教学式首次体验时使用，不拿它替代日常任务指南。

RabiRoute 的用户手册优先提供 how-to，再链接到 OpenAPI 或插件参考。不要让用户从端点表自行拼出远端调用流程。

## 可复制示例

- 在代码块上方标明 PowerShell、Bash、HTTP 或 JSON。
- 示例包含完整 URL 或先定义一次明确的 Base URL。
- 用一致、醒目的占位符；同一占位符在正文和命令里完全一致。
- 请求体使用真实支持的字段和值，输出文件扩展名与 `response_format` 一致。
- 给出最小成功响应或文件检查方法。
- 对二进制响应使用 `--output`，避免音频污染终端。
- 不展示真实 token、账号、RabiGUID、内网地址或用户数据。

## 远端与部署

- 本机、远端 WebGUI、公共 API 和仓库页面是四个不同导航上下文。
- 相对静态 URL 要在 `<base>` 下测试；仓库链接要从 Markdown 文件目录测试。
- 反向代理或子路径部署必须保留 scheme、host、base path 和 API prefix。
- 源码、构建产物、线上版本至少记录两个版本证据，避免把旧 `dist/` 当成当前源代码。
- 公开 Relay 发布前用只读运行时检查确认监督任务、回滚快照和当前哈希；不要仅凭 `/health` 正常推断静态文档也是新版本。
- 每个运行时资源前缀都要有服务端 allowlist、路径穿越测试、鉴权测试和 `Content-Type` 验证。

## API 安全

- 说明 token 类型和取得位置，但不要把 token 放入 URL query 或提交到文件。
- 区分应用 token 与设备 token；权限不足要在调用前说明。
- 明确列出没有进入公网 allowlist 的操作。
- 错误表必须给出读者可采取的恢复动作。
- 对上传大小、超时、模型冷启动和 PC 离线给出边界。

## 双语和导航

- 新增 `docs/user-guide/<name>.md` 时同步 `<name>_en.md`。
- 两个语言版本的能力、限制、代码路径和状态码保持一致。
- 把页面加入 `ProjectDocsPage.vue` 的 `pageOrder` 和正确分组。
- 更新用户指南索引、开发文档索引和功能地图中的入口。

## 采用的公开依据

- [Diátaxis：按 tutorial、how-to、reference、explanation 分离读者需求](https://diataxis.fr/)
- [Google Developer Documentation Style Guide：代码示例](https://developers.google.com/style/code-samples)
- [Google Developer Documentation Style Guide：占位符](https://developers.google.com/style/placeholders)
- [Google Developer Documentation Style Guide：命令行语法](https://developers.google.com/style/code-syntax)
- [OpenAPI 3.0.3：Server Object](https://spec.openapis.org/oas/v3.0.3.html#server-object)

这些依据只定义通用写法；实际端点、错误和权限必须回到 RabiRoute 当前代码与 OpenAPI 核对。
