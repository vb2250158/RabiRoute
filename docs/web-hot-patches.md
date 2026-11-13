[English](web-hot-patches_en.md) | 简体中文

# 安装版 Web 热补丁

状态：实验能力。覆盖 WebGUI、静态资源、随页面编译的用户手册和独立 Web Bundle。兼容 Web 修改保持 Manager 的 PID、application generation 和实例身份不变。后端指纹、依赖锁或插件契约改变时，不能仅用 Web-only 发布，应按[源码热补丁](source-hot-patches.md)及状态迁移的实际支持矩阵选择路径；仅有具体不可迁移边界或首次安装缺失的运行能力时，才由 Host 受控切换。

## 页面与版本

- 每份候选按内容 hash 保存完整 Web 输出、文档和插件入口。根 HTML 的 `data-rabi-web-release` 与 `x-rabiroute-web-revision` 指向同一候选。
- 页面及其固定插件的 JS、CSS、字体、图片和延迟加载资源从 `/_rabiroute/web/<hash>/web/...` 读取；模块目录请求带 `webRelease=<hash>`。所选页面清单中同包同版本的插件使用该 Web revision；其它已加载插件保留其原生 revision 和入口，通过原插件资源读取路径访问。单个独立插件版本不会阻断整个模块列表，也不会冒用另一版的页面资源。
- 新打开或主动刷新的页面进入当前版本。已打开页面继续旧版，不强制刷新 Vue 实例，不重复提交表单，也不重新启动业务消费者。
- 根 HTML 不缓存；版本资源带 immutable 缓存策略。旧的 `/assets/...` 和无版本模块入口仅供升级前已经打开的页面使用，读取安装基线，不作为新页面的发布入口。退出条件是所有升级前页面关闭或刷新；新构建根 HTML 必须只引用版本化资源。
- 回滚仅改变后续页面选择；已提交的业务数据不会撤销。后台源码的兼容范围另见[源码热补丁](source-hot-patches.md)。

## 自动构建与激活

1. 首次安装由唯一发布 owner 构建并安装支持本能力的版本，后续按实际兼容性选择发布路径。操作前通过 `RabiRouteHost.exe --command status --json` 动态发现 `managerBaseUrl`，核对 `/meta` 的 `applicationGenerationId`、`managerInstanceId`、`health.live=true` 及 `health.state=healthy|degraded`；`health.requiredReady` 用于诊断声明能力，实际依赖由目标接口判断，不以无关能力缺失阻断操作。
2. 为 Host 配置受信任源码根 `RABIROUTE_HOT_PATCH_SOURCE_ROOT`；`RABIROUTE_HOT_PATCH_WATCH=0` 会关闭自动激活。不要指向其他任务正在清理的构建目录。
3. 只构建一次运行 `npm run webgui:build`；持续开发运行 `npm run webgui:watch`。后者监听 Web 源码、共享契约、资源及文档，串行运行类型检查和正式 Vite **生产构建**，不启动开发服务器。停止监听不关闭 Manager。
4. 构建器独占 `ribiwebgui/.web-patch-build.lock`。并发构建拒绝执行；进程异常终止留下锁时，核对记录 PID 已退出且无构建 owner 后再移除该锁，不能删除正在使用的锁。
5. 输入在构建期间变化、类型错误、缺资源、错误 hash 或不兼容后端都不会发布完成标记。监听模式在下一次有效输入变化后重新构建；不会无限重试同一失败输入。
6. 构建成功后写入 `dist/web-patches/<hash>`，最后原子替换 `dist/web-patches/latest.json`。Manager 只消费完整标记，校验后原子更新活动指针和操作回执。构建无需复制文件到安装目录。

后端兼容指纹包含编译后的 JS/MJS、非 Web JSON、`package.json` 和 `package-lock.json`。修改这些文件后，Web-only 发布拒绝执行；不得改指纹绕过门禁。

## 查询、手工发布与回滚

| 接口 | 合同 |
| --- | --- |
| `GET /api/web-patches` | 返回状态、当前/上一候选、revision、运行身份和容量限制；不写业务数据 |
| `GET /api/web-patches/operations/<operationId>` | 返回原回执；已提交为 200，服务就绪且未开始为 404，状态受阻或未就绪为 503/unknown |
| `POST /_rabiroute/host/web-patches` | 仅 loopback 和 Host 控制权限；发布已导入的候选，不接受网络源码或路径 |
| `POST /_rabiroute/host/web-patches/reconcile` | 同等权限；只核对已结束的本地持久化尝试，不重新执行发布或业务写入 |

正常运维通过 Host 转发，不读取或传播 Host token。先从当前状态取得身份、`revision` 和候选 hash，把完整请求保存到绝对路径。回滚时 `candidate` 使用状态的 `previous`；首次回滚后仍产生新的 revision：

```json
{
  "operationId": "web-release-operation-unique-id",
  "applicationGenerationId": "<current application generation>",
  "managerInstanceId": "<current Manager instance>",
  "pluginGenerationId": "<current plugin generation>",
  "candidate": "<64 lowercase hex characters>",
  "expectedRevision": 1
}
```

```powershell
& $hostExe --command web-patch --application-generation-id $generation --web-patch-request $requestPath --json
```

同一操作 ID 的载荷冻结；同键不同候选或 revision 被拒绝。Host 转发超时为未确认，先查原操作，不能换键重放。必要时保持原 `operationId`、更新为当前核实身份，通过 `web-patch-reconcile` 命令核对。结果 `committed` 返回已提交回执，`not_started` 才允许按原业务决定重试，`unknown` 继续冻结。状态文件损坏不会自动清空历史。

## 容量与维护

当前每份候选最多 8192 文件、128 MiB；可选导入只在当前后端指纹的有效 manifest 记录少于 64 时受理，每个后端基线最多 2048 个发布回执。安装基线是必要启动资源，不因历史配额满而拒绝构造，因此磁盘候选数可以超过 64；可选导入保留原等待基线就绪及串行提交次序。不同后端、未知或 manifest 无法验证的历史目录原样保留，不参与当前后端计数。计数只校验 manifest 的 hash 与 Schema，不重读既有 payload；导入源、复用目标及实际静态读取仍按原合同完整校验。内存仅缓存 8 份 manifest。

本版**不自动删除磁盘旧候选或历史回执**。当前后端达到容量后拒绝新增可选导入，既有版本的幂等导入和读取不受影响；历史候选不会自动归档，全局磁盘占用仍需单独治理。旧服务继续；这仍需运维容量治理，不能宣称无限连续热更新。离线归档前须冻结发布、保留全部状态/回执备份、确认旧页面退出及旧后端不再恢复；不能只按文件时间删除候选。没有完成这些条件就保持容量告警，不清数据。

## 验收

运行 `npm run test:web-patches`、Host 合同测试、`node --test scripts/dynamic-manager-active-truth.test.mjs` 和 `npm run build`。真实控制面验收还须验证：

- 更新前、中、后持续 HTTP 查询；旧页面延迟资源、用户手册和独立模块仍对应旧 hash。
- 一次修改自动进入新版，再用正式 Host 命令回滚；Manager 身份与后台进程保持不变。
- 编译/完整性/持久化失败继续旧服务，超时或客户端断开不产生重复业务效果；原操作仍可查。
- 新根 HTML 和实际下载字节匹配候选 hash；不得用源码测试、单次健康检查或开发服务器代替安装版证据。


## 独立插件 Web 资源包

需要新的 Web 共享运行时基础版时，先由统一发布流程更新 WebGUI。基础版只加载一份 Vue、Pinia、Vue Router、Vuetify 和现有界面状态；插件使用这些实际实例。此步骤不要求只因 Web runtime 改动就切换 Manager。已有全局 Web 补丁继续支持旧包。

针对单个插件，从同一冻结源码生成原生插件产物，再使用官方选包入口补齐 Web 资源：

```powershell
node scripts/build-plugin-packages.mjs --package <pluginId> --output-directory <candidateRoot>
node scripts/build-plugin-web-packages.mjs --package <pluginId> --output-directory <candidateRoot> --runtime-manifest <shellWebRoot>/assets/web-runtime.json
```

第二步使用原生构建回执并由原 finalizer 完成所选插件的证据，不重新打包整个宿主。产物 `web/module.json` 记录插件与后端配对、实际使用的共享导出、入口与静态 CSS、完整资源文件；JS、懒加载、图片、字体、Worker 和 WASM 随该插件版本保存在自身资源树。动态页 CSS 保持按需加载，文件 MIME 由资源包自身声明；新增资源格式无需修改宿主分发表。资源 URL 继续使用原插件 ID、revision 和相对路径，插件不再依赖宿主根目录的绝对 `/assets/...`。

新候选仅在激活前检查所需共享导出。缺少导出时显示该候选的兼容问题，保留仍有效的旧页面和其他插件；不会新增每次 API 调用的版本资格检查，也不因插件版本变化强制刷新所有页面。实际后端能力与请求合同仍由原 Manager / 插件 owner 执行。新资源包优先使用自身 revision，旧页面可继续读取原保留 revision；卸载时释放本模块的样式和注册。

构建回执只证明候选来源与资源闭包。正式启用仍使用插件原导入、同实例选版和回读流程，核对运行版本、资源、旧页/回退与目标行为；不能把候选构建当作已安装或视觉验收。
