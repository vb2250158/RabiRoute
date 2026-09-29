# 知识桥部署闭包

[English](knowledge-runtime-packaging_en.md) | 简体中文

当前为发布脚本修复与本机保护测试，不是正式安装或线上部署证据。

编译后的 `dist/manager/rabiLinkKnowledgeRuntime.js` 保留 `../../packages/rabi-knowledge-contract/schema.mjs` 导入，实际解析到安装根的 `packages/rabi-knowledge-contract/schema.mjs`，不是 `dist/packages`。TypeScript 编译不会复制该文件。Windows release 将这个唯一运行文件列入必需文件复制清单，源缺失时失败；不依赖 Git 跟踪状态，也不泛复制 packages。官方 MCP SDK 是根生产依赖，payload 通过锁定的 `npm ci --omit=dev --ignore-scripts` 安装。

Relay 部署使用 `scripts/rabilink-relay-runtime-files.json` 作为运行模块清单，包含入口及其递归静态相对依赖。该清单同时驱动本机暂存、远端备份和解包后缺失检查；模块缺失时在复制运行文件前拒绝继续。备份保留 `lib/` 层级。远端复制原本已递归复制整个暂存包，并非只复制备份清单。

运行 `node --test scripts/runtime-package-closure.test.mjs` 校验清单覆盖当前所有静态相对导入，以及 Windows schema/SDK 安装合同。新增或动态导入运行依赖时必须更新清单及保护测试。此测试不代替完整发布包隔离启动、安装目录模块导入、真实 Host 健康或设备验收。

Windows release 的一般 `Copy-TrackedTree` 仍只收录已跟踪文件；新建脚本未提交时不会自动进入该通用清单。明确必需例外包含知识 schema、发布清单校验 helper，以及按上述 Relay 运行清单逐项加入的模块，避免只复制已跟踪入口却漏掉新依赖。设备 profile HTTP、知识操作回执、手机知识授权三个专题的中英六份合同也逐项列为必需文档，不递归纳入未审核的链接目标；完整文档索引仍查项目源码。无 Git 本机快照可使用经审核导出的 `-TrackedFilesManifest` 路径与哈希清单；它不证明来源授权，也不扩大为复制所有未跟踪文件或运行数据。
