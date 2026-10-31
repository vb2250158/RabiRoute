[English](webgui-static-api-contracts_en.md) | 简体中文

# WebGUI 静态资源合同与原生文件流

状态：原生 owner、控制面与 core 插件的源码接线已合入，旧静态分支已删除；静态与 final-fallback 匹配测试 15/15 通过。统一编译、安装版与真实远端验收待完成，全局覆盖仍为 not-proven。本文面向 Manager 维护者，不能用这两份资源集合合同推算全局 API 覆盖数量。

`src/manager/webguiStaticOperations.ts` 返回两个可执行资源集合；`nativeWebguiStaticOwner.ts` 拥有实际文件句柄、完整性校验、背压与关闭。每个内容 hash 或文件名不单独生成业务 operation。

| 合同 | 模板 | 分发要求 |
| --- | --- | --- |
| `manager.webgui-static.release` | `/_rabiroute/web/:resource`，最终原始后缀 | 普通原生 HTTP 注册；GET/HEAD 读文件，其它方法保留 405 |
| `manager.webgui-static.distribution` | `/:resource`，可为空的最终原始后缀 | 仅最终静态 fallback 阶段，在业务 API、Host 私有协议和 API 404 判定之后执行 |

两者使用 `method:"*"`、`httpProxy` 和原生 response metadata/stream。distribution 显式声明 `httpProxy.dispatch:"final-fallback"`，沿正式 `registerHttpProxies()` 注册；registry 在普通操作、upgrade 与已知路径 405 判定之后执行它，并将 phase 投影到目录和 OpenAPI。它不是接管任意私有路径的业务 Schema，不能去掉 phase 后放宽普通 API 跨 owner 重叠检查。相交的第二份最终 fallback 会被拒绝。

## 原行为与资源优先级

| 请求 | 保留的结果 |
| --- | --- |
| GET `/assets/<单层 ASCII 文件名>` | 先读 package 的 `assets/`；存在时 200，PNG/SVG 使用原媒体类型，无额外 cache-control。HEAD 跳过此优先层 |
| GET/HEAD `/index.html` 或无扩展名路径 | 有活动 Web release 时读取该 revision 的 `web/index.html`，注入 release 属性并重写 assets URL；200、HTML、no-store 与 revision header |
| dist 中存在的文件 | 200，原扩展名映射；index 为 no-store，hash 文件 immutable，其它 no-cache |
| dist 中不存在的无扩展名路径 | 使用 dist index 作为 SPA shell |
| 缺失 dist index 或有扩展名文件 | 原有 503 文本提示；普通 API 路径仍返回 API 404 |
| 已验证的 `/_rabiroute/web/<sha256>/<web 或 docs 路径>` | 200、原媒体类型、immutable、nosniff、revision header；HEAD 无正文 |
| 补丁路径无效 / 编码错误 / 文件缺失或 hash 错误 | 分别保留 404 / 400 / 404；活动 shell 完整性失败为 503 |

dist 的原生最终 fallback 也接受其它 HTTP 方法，此语义保留。package assets 优先层仅 GET；活动 release shell 优先层仅 GET/HEAD。补丁错误响应使用不含本机路径的通用说明，避免文件系统错误披露私有目录。

原链未实现 Range、If-None-Match、If-Modified-Since、gzip/br 或 CSP：这些请求仍得到完整 200，不新增 206/304、ETag、Last-Modified、Content-Encoding 或 CSP。合同迁移不暗中添加另一套缓存/压缩策略。

原入口的公共静态例外与 WebGUI/Agent 连接鉴权继续由 ingress 拥有。公开目录不是额外授权表。Host 发布、reconcile 和其它私有协议不进入这两个 owner，也不改成公开接口。

## 文件与生命周期

- dist、package assets 与候选目录分别固定真实根；解码一次，拒绝 NUL、越界路径和逃逸的链接。每次异步步骤之后复核连接身份，读写前后复核真实根和文件身份。
- 补丁 revision、manifest 及后端兼容性仍来自 `WebPatchService`。静态 owner 不另存活动指针、发布状态或 manifest 缓存。所选文件在同一句柄上流式核对 SHA-256，再回到偏移 0 发送。
- 文件发送每块最多 64 KiB，背压时只预取有限块；HTML 替换使用 UTF-8 decoder 和 64 字符边界窗口，不积累整份响应。
- 取消、deadline、撤权、资源消失、换根和 registration retirement 都停止 pipeline；handler 在 `FileHandle.close()` 完成后才结束。活动文件数可通过 `activeFileCount()` 核对。
- 初始 manifest 校验继续沿用发布 owner 的既有校验和容量限制。并行请求不生成新的发布副作用。

## 已合入的源码接线

1. owner 已直接使用正式 `WebPatchService.staticManifest(revision): Promise<Readonly<WebPatchManifest>>`。它等待初始化、核对关闭/故障状态、复用 `compatible()`，并返回 detached clone；没有 private 访问、类型绕过或新增 manifest 缓存。
2. `controlPlaneRoutes.ts` 已创建 `NativeWebguiStaticOwner`，传入 `packageRoot`、`webuiDistPath`、`isControlPath`，以及绑定原服务的 `{ candidates, status, staticManifest }`。constructor 只消费这三个补丁服务成员。
3. core 插件已通过受跟踪的正式 `registerHttpProxies([...definitions.resources, definitions.fallback])` 注册两个集合，保留工厂的 final-fallback descriptor。同一活动目录、代际发布和 retirement 由 registry 拥有；原 private 处理器保持先执行，owner 的 API/private 排除先于静态字节发送。
4. `controlPlaneRoutes.ts` 的五个旧 helper 已删除：`contentTypeFor`、`webuiCacheControl`、`staticWebuiResponse`、`htmlResponse`、`assetResponse`。请求尾部的 package asset、旧 GET/HEAD shell 和最终 HTML 分支也已删除；原 API 边界与 ingress 鉴权保持在控制面链路中。
5. `webPatchRoutes.ts` 的 `WEB_PATCH_PREFIX` 静态块及仅服务该块的媒体类型 helper/import 已删除；状态/回执和 Host-private 发布/reconcile 由公共核心服务 owner 处理。
6. `WebPatchService.document()` / `read()` 旧整体正文入口已删除，静态文件与 shell 改写只走新 owner；模块资源仍保留其原生用途。

以上为当前源码接线状态。开发者索引及文档页面分组由索引 owner 核对；统一编译后仍须确认双语页可搜索、根 HTML 引用实际 revision、补丁资源和 docs 字节可读，且旧入口未被运行引用。统一编译、安装版与真实远端验收完成前，不标记全局迁移完成。

## 专属验证

```powershell
node --import tsx --test --test-concurrency=1 src/manager/webguiStaticOperations.test.ts
```

专属测试使用临时真实文件、真实 HTTP、实际 WebPatchService 导入/发布与正式 `staticManifest()`，并通过 `ManagerPluginRouteRegistry.registerHttpProxies()` 绑定原生 owner，覆盖公开读取、资源优先级、HEAD、Range/conditional 的原行为、媒体/cache、编码/越界、目录 junction 逃逸、根/文件消失、撤权、取消、deadline、退役与文件句柄关闭，以及跨 UTF-8/块边界的 HTML 替换、旧 revision 资源。Windows 当前无法创建普通文件符号链接，相关路径改用实际目录 junction 验证；没有把缺失权限写成通过。

13 项静态 owner 专测包含不同 owner 的业务 API 优先、原生 405、Host 私有处理器保留、重复最终 fallback 拒绝、目录/OpenAPI 的 phase 投影。与正式 final-fallback 的 2 项测试合跑，共 15/15 通过。根 HTML、实际 revision 资源及 docs 字节的 compiled 验收入口已准备；统一编译与该入口的实际执行、安装版和真实远端下载仍待根会话验收。
