<a href="./dsh-cordis-runtime-analysis_en.md">English</a> | 简体中文

# DSH 如何使用 Cordis：运行时、界面与隔离分析

> 状态：实现调查基线为本地 DSH `528c682e06`、`dsh@0.1.1-rc.1`；远端 `master` 已前进，本文未审计后续提交。
>
> 主要读者：RabiRoute 维护者、插件运行时设计者与 WebGUI/Desktop 扩展开发者。

## 直接回答

DSH 没有把所有插件放进独立进程。

- profile 中安装的普通插件由 Cordis Loader 通过 Node ESM 载入当前进程，属于受信任代码。
- Cordis 的 `isolate` 隔离服务实例的解析命名空间，不隔离进程、内存、文件系统或网络。
- 模型临时生成的 Host 插件运行在同进程 `node:vm` 中，并只拿到受限 `ctx`；DSH 源码明确说明这只能约束协作代码，不构成安全封闭。
- 模型临时生成的浏览器插件在当前页面通过 `new Function` 执行，使用参数遮蔽和 `ctx` 代理限制常用途径；带浏览器部分的运行需要页面中的人确认。
- DSH 的操作系统沙箱用于 Agent 启动的 Bash、PowerShell 等子进程，不是普通 Cordis 插件的统一执行边界。
- Worker Thread 只用于 Workflow 等特定 Provider，不是 Loader 对第三方插件的默认隔离方式。

因此，RabiRoute 设计中的“高风险或不可信插件进入独立进程”是额外的安全设计，不是对 DSH 当前实现的照搬。

## 调查快照

本地调查副本固定在 [DeepSeek Harness `528c682e06`](https://github.com/deepseek-ai/deepseek-harness/tree/528c682e061696f5a160f363f236ecbf53cbd006)，对应 `dsh@0.1.1-rc.1`。2026-08-21 复核时，远端 `master` 已前进至 `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`。本文所有源码判断和行号仍只适用于本地 `528c682e06`，没有把远端新提交视为已审计实现。

本地基线还包含：
- DSH vendored [`@deepseek-ai/cordis` 4.0.0-rc.7](https://github.com/deepseek-ai/deepseek-harness/blob/528c682e061696f5a160f363f236ecbf53cbd006/vendor/README.md#manifest)；
- DSH vendored [`@deepseek-ai/cordis-plugin-loader` 1.0.0-rc.5](https://github.com/deepseek-ai/deepseek-harness/blob/528c682e061696f5a160f363f236ecbf53cbd006/vendor/README.md#manifest)；
- [Cordis 组合性论文 v8](https://github.com/cordiverse/paper/blob/948a07b369c62adb3b12e102458be5c18dfb69b9/paper.pdf)。

DSH 没有直接消费公开 npm 上游包。它把 Cordis、Loader、Include、Group、HMR、Timer 等源码固定在 `vendor/`，改名到 `@deepseek-ai`，并维护本地修改清单。

## DSH 的六类执行环境

| 代码类型 | 运行位置 | Cordis 的作用 | 当前隔离强度 |
|---|---|---|---|
| 内置与 profile npm 插件 | DSH Node 主进程 | Loader、服务注入、Fiber、effect、HMR | 受信任，同进程 |
| Agent preset 插件 | Node 主进程中的 preset standing mount | 每个 preset 挂载一次；Agent 通过 scope 父链共享 | 服务作用域隔离，同进程 |
| Web 客户端插件 | 当前浏览器页面 | 浏览器 Cordis Context、Loader、UI slots | 受信任，同页面 |
| 模型生成的 Host 动态插件 | Node 主进程的 `node:vm` realm | 动态 Fiber、受限 Context façade | 协作式限制，不是安全封闭 |
| 模型生成的浏览器动态插件 | 当前页面的 `new Function` closure | 动态浏览器 Fiber、受限 Context façade | 协作式限制，需要页面确认 |
| Bash/PowerShell/Workflow 工作 | 子进程或特定 Worker Thread | Cordis 选择 Provider 并持有生命周期 | 特定能力隔离，不是通用插件隔离 |

这个区分很重要。DSH 的“所有内容都是插件”描述组合方式；每类代码是否可信、在哪里执行、能访问什么，由宿主和具体 Provider 另行决定。

## 1. DSH 固定并修改 Cordis

DSH 把框架层作为产品源码的一部分管理，而不是普通依赖：

1. 固定上游提交和版本；
2. 把包名改到 `@deepseek-ai`；
3. 记录每项本地修改；
4. 让所有 DSH 包通过 workspace peer dependency 使用同一份 Cordis；
5. 更新上游时重新复制源码、重放补丁并运行全套测试。

本地修改不只是命名。当前清单还包含 Loader 失败回滚、Include 更新串行化、Windows 持久化重试、延迟配置求值、HMR 缓存回滚和启动诊断等行为修正。

RabiRoute 不需要在第一阶段复制这种维护成本。更合适的起点是精确锁定上游版本，把 Cordis API 收口在 `src/runtime/`，只有上游行为确实阻塞时再维护最小补丁。

## 2. profile、bundle 与 patch 组成期望状态

DSH 启动时不由入口文件逐个创建业务模块。它从空列表开始，按顺序应用配置层：

```text
空插件树
  ↓
profile 声明的 bundle patches
  ↓
profile/cordis.patch.yml
  ↓
$DSH_HOME/cordis.patch.yml
  ↓
命令行 --patch overlays
  ↓
最终 Loader entry tree
```

每一行至少有：

```yaml
- id: webserver
  name: '@deepseek-ai/dsh-host-webserver'
  inject: [webStartup]
  config:
    host: !!js ctx.webStartup.host ?? '127.0.0.1'
    port: !!js ctx.webStartup.port ?? 3080
```

- `id` 是实例身份，patch 通过它替换或禁用一行；
- `name` 是插件模块身份；
- `inject` 增加当前实例需要的服务；
- `config` 是插件配置；
- `isolate` 改变指定服务的解析 realm；
- `disabled` 控制是否挂载。

patch 替换目标行的完整 `config`，不是深合并。DSH 可以用 `dsh --profile <name> --dump-config` 输出实际启动树，减少“配置文件看起来正确，但最终组合不同”的问题。

## 3. Loader 负责导入、实例身份和局部更新

Cordis Loader 把配置行变成 `Entry`：

1. 根据 `name` 解析模块；
2. 通过 Node 内部 ESM Loader 或普通 `import()` 载入模块；
3. 规范化导出，创建 Cordis Fiber；
4. 把 Entry ID、配置和 Fiber 关联；
5. 更新时只处理发生变化的 Entry；
6. 新配置失败时撤销新 Entry，并恢复旧配置。

普通树外插件通过 `dsh plugin --profile <name> add <package>` 安装。这个命令把参数转交给 profile 目录中的 pnpm。插件包在自己的 `package.json` 声明 bundle patch，启动时仍作为普通 ESM 进入 DSH 主进程。

这套机制解决的是安装、解析、组合、重载和撤销，不提供恶意代码隔离。

## 4. `inject` 让服务依赖决定生命周期

DSH 插件通过 Cordis Context 发布服务，例如：

- `ctx.sessions`；
- `ctx.tools`；
- `ctx.agents`；
- `ctx.llm`；
- `ctx.sandbox`；
- `ctx.slots`。

消费者在插件静态声明或配置行中写 `inject`。Cordis 根据服务是否存在决定 Fiber 状态：

```text
缺少依赖 → PENDING
依赖齐全 → LOADING → ACTIVE
Provider 消失或被替换 → 消费者卸载/等待
依赖重新满足 → 消费者重新激活
```

因此，bundle 文件中的行顺序主要服务于阅读，不承担启动顺序。真正的启动关系来自服务依赖图。

DSH 将可替换能力称为 seam。一个完整 seam 通常包含：

1. Service Definition：稳定接口；
2. Service Provider：具体实现；
3. Consumer：使用该能力的工具或业务插件。

例如文件系统、子进程和沙箱可以替换 Provider，而 Bash、PTY、LSP 等消费者继续使用同一服务接口。

## 5. Fiber 持有可撤销副作用

每次 `ctx.plugin()` 创建一个 Fiber。插件注册的服务、事件监听、定时器、UI slot、工具和其他资源都应挂在这个 Fiber 上。

常见入口包括：

```ts
ctx.effect(() => disposer)
ctx.on(event, listener)
ctx.provide(name, service)
ctx.plugin(childPlugin)
```

Fiber 停止时按生命周期撤销这些资源。Fiber 顶层登记的多个 effect disposer 会按登记逆序取出，再由 `Promise.all(...)` 启动并等待，因此异步清理可以并发。单个 `ctx.effect()` 内返回的多个 disposer 也按登记逆序处理，但通过 Promise 链串行执行。存在先后依赖的业务停用仍应放进一个关键 effect/disposer。

DSH 还要求启动失败时释放已经挂载的部分 Context，避免终端模式、端口、监听器或 UI 注册残留。这正是 RabiRoute 最值得先学习的部分：先让每个 Adapter 的监听器、端口、定时器、watcher 和子进程拥有统一 disposer，再讨论动态安装。

## 6. Cordis `isolate` 是服务 realm

DSH 的 `isolate` 会为指定服务 key 生成不同的 Symbol：

```yaml
isolate:
  tools: agent-a
  systemPrompt: agent-a
```

同一 label 的 Provider 和 Consumer 会解析到同一个服务实例；不同 label 可以在同一 Node 进程中同时拥有同名服务。

服务 realm 还带有明确所有权：每个服务实现由注册它的 Fiber 持有，同一 realm 不允许重复 Provider，只有服务拥有者 Fiber 可以修改该服务值。DSH 的 Agent preset 会检查 preset 子树是否把服务发布到 root realm；preset 服务必须位于 `isolate` realm，或明确移到宿主组合层。RabiRoute 也应拒绝插件作用域服务意外成为宿主全局服务。

它适合：

- 每个 Agent 拥有不同工具表；
- 每个会话拥有不同提示词或 Provider；
- 同一进程内并存多份同名服务；
- Provider 替换时只通知实际依赖者。

它不限制代码访问 `process`、Node 内置模块、文件系统、网络或其他内存对象。命名中的 `isolate` 容易被误解，RabiRoute 文档和 API 应把它称为“服务 realm”或“服务作用域”，不要把它展示成安全等级。

## 7. 配置重载和代码 HMR 是两条路径

DSH 把两类变化分开：

### 配置变化

Include 监听 `cordis.patch.yml`，重新计算 Entry 列表，再通过事务式 `update()` 创建、更新和移除实例。应用失败时恢复旧 Entry 列表。

### 代码变化

HMR 找到受影响模块和依赖者，备份 ESM/CJS 缓存，清除缓存后重新导入。若新模块加载或激活失败，它恢复缓存并重新挂载旧插件。

配置变更由 Loader Entry transaction 处理：Entry 更新销毁旧 Fiber、启动新 Fiber，并在失败时恢复旧插件。源码 HMR 是另一条路径，负责备份和恢复 ESM/CJS cache。两条路径只共享 Fiber 销毁与重新挂载语义，不是同一个更新机制。

DSH 为这两条路径补了串行化、失败聚合、异步写入排空和启动审计。RabiRoute 第一阶段只需要配置驱动的停用、启用和重建；源码 HMR 可以等生命周期测试成熟后再考虑。

## 8. Agent preset 是每个 preset 的 standing mount

DSH 把宿主级能力和每个 Agent 的能力分开：

- 宿主树拥有会话、持久化、模型路由、设置、凭据、沙箱、审批和跨会话注册表；
- 每个 preset 的 `cordis.yml` 在进程中只挂载一次，形成 standing mount；
- 使用同一 preset 的多个 Agent 通过 scope 父链加入该 standing mount；
- 插件实例、工具注册、提示词片段和 projection unit 只存在一份，插件内部再按 Session/Agent key 隔离状态；
- preset 文件变化会为当前及后续 Agent 创建新 generation，已经加入旧 generation 的 Agent 继续使用旧挂载。

当前 DSH 留有明确 TODO：旧 generation 尚未在最后一个 Agent 离开后自动回收。RabiRoute 可以学习这种共享组合与作用域父链，但不能把它误写成“每会话独立挂载和卸载”。Route、事件记录、投递证据和 Outbox 仍由 Manager/Gateway 的稳定模块拥有。

## 9. DSH 的 Web UI 本身也是插件树

DSH 没有把 Web UI 当成固定页面集合：

```text
Node Host
  ├─ 扫描启用的 dsh.client 包
  ├─ 解析每个包的 ./client 导出
  ├─ 生成并提供浏览器模块图
  └─ 提供 /plugins/<id>/client.js

Browser
  ├─ 建立 ClientModuleSystem
  ├─ 创建浏览器 Cordis Context + Loader
  ├─ 挂载每个客户端插件 Fiber
  └─ 通过 ctx.slots.register() 贡献界面
```

UI 插件通过 slot 注册组件，也可以声明子 slot、store 和业务注入。slot 声明消失时，依赖它的贡献会撤销；插件卸载时，组件、子 slot、store 和样式沿同一生命周期退出。

这比“后端返回一份菜单 JSON”更完整：DSH 在浏览器里运行第二棵 Cordis 插件树。

RabiRoute 可以分两步采用：

1. 先由 Manager Contribution Catalog 提供声明式导航、设置、状态卡片、命令、菜单和主题；
2. 合同稳定后，WebGUI 建立客户端 Extension Host，加载可信代码插件。

Desktop 当前是 Python/Qt，不需要为了形式统一移植 Cordis。它可以消费同一 Contribution Catalog，并在需要代码扩展时使用独立进程协议。

## 10. DSH 的模型动态插件是另一套受控入口

DSH 还允许 Agent 检查当前 Cordis Runtime，并定义临时动态包。这和 profile npm 插件不同。

### Host 部分

- 代码先做语法预检查；
- 使用 `node:vm` 创建新 realm；
- `require`、`fetch`、Node 定时器等常用入口被替换为提示错误；
- 插件拿到只读 Context façade，只能使用生命周期方法和自己声明的服务；
- 返回的插件仍挂载为 Cordis Fiber，可以停止和撤销。

DSH 源码同时注明：Host realm 的辅助函数仍可能成为逃逸路径，因此该 VM 只让协作代码更可检查、更容易撤销，不构成安全封闭。同步超时也只限制同步阶段，异步代码可以越过该时间限制。

### 浏览器部分

- Host 先保存并预检查代码；
- 页面中的人批准带浏览器部分的运行请求；
- 浏览器用 `new Function` 把代码作为 async function body 执行；
- `process`、`Buffer` 设为 `undefined`，常用全局入口通过参数遮蔽给出提示；
- 插件只拿到受限 Client Context façade；
- 插件卸载后，slot、主题和样式由 Fiber 清理。

这些措施减少误用，并提供清楚的撤销路径。代码仍运行在当前 Host 进程或浏览器页面，不能按对抗恶意代码的安全沙箱理解。

## 11. DSH 的操作系统沙箱保护的是工具子进程

`ctx.sandbox` 将 Bash、PowerShell 等调用包装成受文件策略约束的 argv。当前本机 Provider 包含：

- Linux bwrap/Landlock；
- macOS Seatbelt；
- Windows ACL restricted-token runner。

该 sandbox 主要约束文件效果。网络和进程可见性不在同一模式词汇中，Provider 还会报告 `full` 或 `partial` enforcement。

它保护 Agent 启动的命令，不会自动包住通过 Loader 导入的普通 Cordis 插件。第三方 npm 插件仍在主进程内执行。

## DSH 值得学习的设计

### 一棵配置树就是产品组装

模型、工具、会话、持久化、Web Host 和 UI 都使用相同 Entry/Fiber 语言。新增能力通常增加包和配置行，不需要在中心入口补一组类型判断。

### 服务图同时控制依赖和重启范围

依赖缺失、Provider 替换和服务 realm 变化都会转换为明确 Fiber 状态。局部变化只影响真实依赖者。

### UI 与后端采用相同生命周期语义

Host 服务和浏览器组件都能被挂载、等待依赖、撤销和重新激活。插件卸载不会只删后端注册而留下页面入口。

### 配置、实际状态和诊断分开

配置表示希望挂载的 Entry；Loader/Fiber 表示实际状态；插件清单和启动审计解释失败阶段与缺失服务。

### 动态能力先经过受控 façade

DSH 即使在同进程执行模型动态代码，也没有把真实 Context 整体交给它，而是限制服务、生命周期方法和跨端调用方式。

## 不应直接复制的部分

### 不先 vendoring 整个 Cordis

DSH 已为 vendored 框架维护多项行为补丁。RabiRoute 当前规模不需要立即承担同步、重放补丁和发布私有框架包的成本。

### 不把 `isolate` 当安全功能

它解决同名服务并存和依赖图分区，不解决恶意代码。

### 不先实现源码 HMR

HMR 涉及 ESM/CJS 缓存、依赖闭包、失败恢复和异步资源排空。生命周期未完整时，热更新会放大残留资源问题。

### 不直接复制模型动态代码执行

DSH 的 `node:vm` 和浏览器 closure 针对协作式模型代码，并明确保留安全缺口。RabiRoute 如果允许未知来源代码，应使用独立进程、最小 RPC 能力和可终止的资源限制。

### 不让插件拥有业务事实

Cordis 适合组合能力和生命周期。RabiRoute 的 Route、事件记录、投递证据、审批、Outbox 和回传结果仍需要唯一所有者。

## RabiRoute 应采用的分层

| 信任级别 | 代码来源 | 建议执行方式 |
|---|---|---|
| `builtin` | 仓库内置、随版本测试 | Manager/Gateway 进程内 Cordis 插件 |
| `installed-trusted` | 用户显式安装并信任 | 进程内插件，记录来源、版本、哈希和权限 |
| `declarative` | 第三方清单和配置 | 不执行代码，由宿主渲染贡献项 |
| `isolated` | 未知、高风险或需要强资源限制 | 独立进程，版本化 RPC 和能力授权 |

第一实施阶段只需要 `builtin` 和 `declarative`。`installed-trusted` 在插件合同稳定后开放；`isolated` 在确有树外代码需求时实现。

## 对现有重构方案的修正

- 保留 Cordis 组合内核、Rabi 业务适配层和多宿主扩展协议。
- Gateway 性能采样与上报已迁入 Gateway 根 Context 下的 Fiber；根 Context 销毁时通过 effect disposer 撤销 reporter 资源，不再由根 Context 外的独立生命周期入口持有。
- Manager definition 使用 `provides`、`requires` 和 `optional` 建立能力图。依赖 revision 递归包含直接和传递 Provider，上游变化会沿能力链重启真实消费者；`PluginCatalog.refreshDeclaration()` 在重载时刷新 manifest 与 `missingCapabilities`，支持 `active -> waiting_dependency -> active`，对应 DSH“配置、实际状态和诊断分开”的做法。
- Manager 退出和启动失败回收显式串行执行 `managerPluginRuntime.unmount() -> managerSharedResourcesRuntime.unmount() -> managerCordisRoot.dispose()`。这是针对 Cordis 同层 disposer 并发语义增加的宿主顺序，不依赖 Fiber 同层销毁顺序。
- 把 DSH 作为组合与生命周期参考，不把其普通插件加载方式当作安全范例。
- 生产 Manager 业务路由已使用稳定 `routeId` 与真实 `exact/prefix` 声明；Registry 拒绝重复 ID 和相交静态路径。
- WebGUI 长期可以像 DSH 一样拥有客户端插件树；当前先用可信 command/renderer 注册表消费声明式 Contribution Catalog。合同绑定 `pluginId + instanceId`，跨插件目录引用失败关闭。
- Desktop 通过同一贡献协议和冻结 Registry 扩展 lifecycle、panel action、菜单、快捷键、设置与状态；`manager:desktop` 设置区负责系统划词、系统截图、剪贴板贴图快捷键和登录启动设置。
- 可信 Python entry point 在 Desktop 进程内执行并接收完整 Registry；owner-scoped registrar、权限模型和更强进程隔离属于后续 Extension Host。
- RabiLink 第二次 `stop()` 可以取消停止期间排队的重启；配置 watcher 与 Rabi 身份配置 PATCH 都等待异步 Relay 同步。
- 文档中“独立进程或更强隔离”标记为 RabiRoute 的安全选择，不再描述为 DSH 的现有做法。

当前实现见[RabiRoute 插件平台目标架构](manager-plugin-implementation-hot-swap.md)，原则摘要见[从 DSH 学习的插件化设计理念](dsh-plugin-architecture-lessons.md)。

## 主要证据路径

- [DSH 架构](https://github.com/deepseek-ai/deepseek-harness/blob/528c682e061696f5a160f363f236ecbf53cbd006/docs/architecture.md)
- [DSH Cordis 入门](https://github.com/deepseek-ai/deepseek-harness/blob/528c682e061696f5a160f363f236ecbf53cbd006/docs/cordis-primer.md)
- [profile 与插件安装](https://github.com/deepseek-ai/deepseek-harness/blob/528c682e061696f5a160f363f236ecbf53cbd006/apps/cli/reference/README.md)
- [vendored Cordis 版本和本地修改](https://github.com/deepseek-ai/deepseek-harness/blob/528c682e061696f5a160f363f236ecbf53cbd006/vendor/README.md)
- [Loader Entry 导入与更新](https://github.com/deepseek-ai/deepseek-harness/blob/528c682e061696f5a160f363f236ecbf53cbd006/vendor/loader/src/config/entry.ts)
- [服务 realm 的 `isolate` 实现](https://github.com/deepseek-ai/deepseek-harness/blob/528c682e061696f5a160f363f236ecbf53cbd006/vendor/loader/src/config/isolate.ts)
- [Web 客户端 Cordis 启动](https://github.com/deepseek-ai/deepseek-harness/blob/528c682e061696f5a160f363f236ecbf53cbd006/packages/client/web/README.md)
- [UI Slot 生命周期](https://github.com/deepseek-ai/deepseek-harness/blob/528c682e061696f5a160f363f236ecbf53cbd006/packages/client/ui-slots/README.md)
- [动态 Host 插件 VM 与非封闭说明](https://github.com/deepseek-ai/deepseek-harness/blob/528c682e061696f5a160f363f236ecbf53cbd006/packages/extensions/cordis-host-runner/src/sandbox.ts)
- [动态 Host Context façade](https://github.com/deepseek-ai/deepseek-harness/blob/528c682e061696f5a160f363f236ecbf53cbd006/packages/extensions/cordis-host-runner/src/guard.ts)
- [动态浏览器插件求值](https://github.com/deepseek-ai/deepseek-harness/blob/528c682e061696f5a160f363f236ecbf53cbd006/packages/extensions/cordis-client-runner/src/client/evaluator.ts)
- [DSH 进程沙箱](https://github.com/deepseek-ai/deepseek-harness/blob/528c682e061696f5a160f363f236ecbf53cbd006/docs/subsystems/sandbox.md)
