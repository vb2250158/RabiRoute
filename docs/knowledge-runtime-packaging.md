# 知识运行模块部署闭包

[English](knowledge-runtime-packaging_en.md) | 简体中文

本页描述 0.3.22 的发布布局和闭包检查。发布脚本与保护测试通过，不等于正式安装、Host 健康或真实设备业务验收。

## PC 安装包与开发候选

知识工具的稳定实现位于 `packages/rabi-knowledge-contract/{schema,tools,receipt}.mjs`。Manager 的 `rabiLinkKnowledgeDirect` 直接调用既有 Manager 知识 API，共用工具映射和回执校验，不启动外部 MCP 服务，不需要知识 URL 或密钥。编译后的 `dist/manager/` 导入解析到安装根的 `packages/rabi-knowledge-contract/`；TypeScript 不会复制这些文件。

Windows release 将三个共享模块与 `apps/rabi-mcp/lib/{knowledge-tools,knowledge-receipt}.mjs` 薄包装逐项列为必需文件，源缺失时失败。独立 MCP 应用也使用同一实现，包装不能遗留旧的重复工具逻辑。根生产依赖按锁定的 `npm ci --omit=dev --ignore-scripts` 安装；依赖安装本身不代表启动了 MCP 服务。

开发候选脚本同样验证并覆盖这五个文件。基包已经包含独立 MCP 时替换旧包装；基包没有该应用时，共享文件与包装仍构成可导入闭包，但不会凭空新增调用入口。基包保持不变，缺失源文件在暂存前失败。

## Relay 部署与旧布局迁移

`scripts/rabilink-relay-runtime-files.json` 是仓库相对路径清单，覆盖入口及其递归静态相对依赖。当前包含 `scripts/` 下的运行模块、`scripts/lib/` 辅助模块，以及上述三个共享契约模块。知识鉴权入口为 `scripts/rabilink-knowledge-access.mjs`；旧 grant 和 grant UI 模块已退役。

清单驱动暂存、备份与解包后缺失检查。暂存包保留 `scripts/`、`scripts/lib/`、`packages/rabi-knowledge-contract/` 层级，入口为 `node scripts/rabilink-relay-server.mjs`，不能再压平到根目录。部署脚本先备份旧平面清单和已知历史文件，再迁移到新布局并删除已备份的旧平面入口及 grant 模块，留下迁移记录；不删除配置或业务数据。远端仍递归复制整个已审核暂存包。

## 文件来源与验证

Windows release 的通用 `Copy-TrackedTree` 只复制已跟踪文件；知识五模块、发布清单校验 helper 和审核过的 Relay 清单模块有明确必需例外。无 Git 快照可使用 `-TrackedFilesManifest` 的路径与哈希清单；仅允许这组稳定共享模块，不能因此任意纳入 packages、未跟踪文件或运行数据，也不能用哈希验证替代来源授权。

设备 profile HTTP、知识操作回执、旧手机知识页面迁移三组中英合同是必需文档。链接目标不递归复制，完整索引见源码。

运行 `node --test scripts/runtime-package-closure.test.mjs scripts/developer-channel.test.mjs scripts/windows-release-optional-speech.test.mjs` 检查静态导入闭包、候选实际包装导入、基包保护、缺失源拒绝与发布路径限制。访问 Manager 的脚本另运行 `node --test scripts/dynamic-manager-active-truth.test.mjs`。新增或动态运行依赖必须同步清单和检查。完整发布包启动、安装目录实际导入、受管 Host 健康和双设备业务验收各自需要证据。
