<!-- docs-language-switch -->
<div align="center">
<a href="./plugin-bundles_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# 插件包、执行边界与热替换

RabiRoute 的主干负责应用生命周期、业务状态与插件内核，功能沿插件树扩展。插件不是另一套 Host：它只能在 Manager 给定的 generation、权限、依赖和进程租约里提供能力。Windows Host、Manager 和托盘的生死关系不由普通插件控制。

## 唯一正式格式

Manifest 与 Profile 都只接受 schema v2。任何其他版本都不做兼容解析；未知或退役字段会直接报错，避免一份包在不同机器上得到两套生命周期语义。

正式目录：

```text
plugins/
  profiles/desktop.json
  builtin/<package-id>/<version>/rabi.plugin.json
  builtin/<package-id>/<version>/manager.mjs
  builtin/<package-id>/<version>/web/
```

树外插件使用同样的包结构、Schema、SDK 和 Profile 实例合同。内置身份不授予额外生命周期权限。

## Manifest v2

```json
{
  "schemaVersion": 2,
  "id": "io.example.feature",
  "version": "1.0.0",
  "entries": {
    "manager": {
      "execution": "isolated",
      "module": "./manager.mjs"
    },
    "desktop": {
      "execution": "declarative",
      "resource": "./desktop.json"
    }
  },
  "provides": ["example.feature@1"],
  "requires": ["manager.core@1"],
  "optional": [],
  "permissions": ["example.read"]
}
```

`provides`、`requires`、`optional` 和 `readyRequires` 使用 `name@major`。包路径必须留在包目录内。未知字段、重复能力、无效权限和 capability 冲突均在执行前拒绝。

## 三种执行模式

| 模式 | 用途 | 隔离与限制 |
| --- | --- | --- |
| `in_process` | 随 Manager 发布、经过审阅且需要直接服务对象的可信核心插件 | 在 Manager 进程内执行；必须使用 SDK lifecycle/effect，不能另造应用 owner |
| `isolated` | 树外代码、故障面较大或需要独立进程的插件 | loader 不导入入口顶层代码；专用 Plugin Runtime Host 通过受限 RPC 和可结构化克隆数据交换；子进程由 lease 收回 |
| `declarative` | Desktop/Web 等只需声明菜单、面板、主题或资源的贡献 | 不执行插件 JavaScript；内核读取并校验声明资源，再交给对应表现适配器 |

执行模式属于 entry，不属于整包；同一个包可为不同 host 声明不同模式。不能通过 manifest 填写任意命令行、可执行路径或脱离包目录的资源。

## 异步服务传输 v2（实验候选，需对应构建）

`isolated` 的现有 v1 数据合同继续服务既有包。包含异步桥接实现的构建，可以从正常 PackageCatalog 校验后的不可变包读取 `rabi.async-services.json`：

```json
{
  "schemaVersion": 1,
  "provides": {
    "example.worker@1": { "kind": "async-methods", "methods": ["run"] }
  }
}
```

这是提供端的方法调用语义，不是权限白名单。只能描述 manifest 已提供的能力。host 服务的异步语义由原 host owner 通过 `declareAsyncPluginService(value, methods)` 声明；插件不能用这个包文件把任意同步 host 方法改成 Promise。原 require/optional、身份和权限合同继续由内核负责，已鉴权远端连接的功能权限不变。

正式入口仍是 `createFullPluginExecutor`。它按正常 candidate 与 PackageCatalog 的真实包 owner 关联选择协议，在启动前完成选择；一次 activation 只启动一个原 owner child。v2 失败不会启动 v1 作为备用，也不会换 requestId 重放调用。没有异步合同的现有 v1 包保留其现有数据、heartbeat 与 restart 行为。保留 v1 是兼容既有独立插件包，退出条件是这些包及其 restart/owner 行为都完成等价迁移和真实验收；不能在迁移前删掉仍被使用的入口。

v2 的入口 import、activate、effects 和声明的 provider 方法在 child 运行；host 方法自身仍在 Manager 运行。传输只接受明确的数据对象或已声明的异步方法，拒绝自定义类、accessor、同步 publication、原生 HTTP/socket、流与订阅回调。它不承诺默认 30 个插件已完成隔离，也不能用普通 Promise timeout 声称同步 host 代码已隔离。当前 v2 只支持 `restart.mode=never`；`on_failure` 需要能够核对未知结果的 owner 适配，不能自动重放 prepare/commit 或业务动作。

进程沿用原 ProcessLeaseRegistry，另以真实 close 核对资源结束。已接收、实际开始、执行结果、原 mutationOutcome/uncertain/operationId 与响应投递分别记录。真实 unknown 使用完整 activation 身份与 requestId 定位，由 Manager stateRoot 的 `data/.runtime/plugin-runtime/unknown-outcomes` 专属归档 owner 异步保存少量结果元数据；64 条热缓存淘汰后仍可按原 key 冷查，首次事实不会被另一 owner 的同名 requestId 覆盖。正常成功、只读、探测和启动注册不执行归档 fsync；普通运行中的 Promise 也不是历史 unknown。归档未确认保留原事实及实际 join，容量不足只拒绝该插件尚未派发的潜在副作用调用，不能阻断其它插件或只读/探测。已有原生 operationId、receiptId、deliveryId 的结果继续由原 owner 核对，桥接不另造业务事务或重发请求。执行器提供原 owner 冷查方法，公开 HTTP 诊断入口尚未接入。同步 publication、HTTP/stream owner 及默认插件迁移仍须独立完成。

方法的 read、owned-resource、mutation、unknown 语义仅能由原服务 owner 声明，用于正确保留结果和资源，不是功能授权。返回值或错误里的 getter、Proxy 和自定义行为不会在 Manager 为了提取 metadata 被执行；已经派发后的传输失败仍是 unknown，不能改报 not_started。

正常 backend build 会精确复制三个原生 MJS 桥接资产，TS 声明用于检查调用边界；声明文件不等于实现已通过测试。新执行 owner 的构建、兼容迁移及实际入口验收必须通过后，才能用于安装版本。旧安装版或仅有源码不能作为已支持的证明。

## Profile v2

Profile 是某个部署要启用哪些实例的唯一真源：

```json
{
  "schemaVersion": 2,
  "readyRequires": ["manager.core@1"],
  "instances": [
    {
      "id": "manager:example",
      "package": "io.example.feature",
      "version": "1.0.0",
      "enabled": true,
      "config": {},
      "grants": ["example.read"],
      "policy": {
        "restart": {
          "mode": "on_failure",
          "maxAttempts": 3,
          "windowMs": 60000,
          "initialBackoffMs": 500,
          "maximumBackoffMs": 10000
        },
        "resources": {
          "memoryMb": 256,
          "maxChildProcesses": 2,
          "shutdownTimeoutMs": 5000
        }
      }
    }
  ]
}
```

已安装插件直接使用 Manifest 声明的宿主接口，不再要求 Profile 逐项许可。旧 `grants` 输入与 `grantedPermissions` 回调不参与执行判断，将于 0.4.0 移除。`policy` 继续约束重启与资源；所有 `readyRequires` 都须由已激活服务提供后才报告就绪。

Manager 每次协调插件时如实报告缺少的 `readyRequires`，发布健康且依赖齐全的可用子集；故障插件和等待依赖的插件保留各自状态，不先因能力缺失回滚核心再重试整组。启动先准备核心依赖，再在后台发布其余健康功能，不把能力清单作为整机启动或无关功能的门。`readiness.missingCapabilities` 与 `health.requiredReady=false` 始终保持真实。稳定的 `manager.meta.read`（`/meta`）由 core 持有，diagnostics 插件缺失不会移除它；原 API 别名、schema、诊断读取和连接鉴权保持不变。供其他宿主使用的通用 Plugin Kernel 仍默认严格校验，未显式选择报告模式的发布失败会保留已有代。`manager.core` 自身无法激活时，当前仍没有独立的 HTTP 引导入口；这个结构边界尚未消除。

## 身份与生命周期

每个激活实例使用完整身份：

```text
applicationGenerationId
managerInstanceId
activationId
instanceId
pluginId
version
revision
host
```

外部请求、进程租约、日志和贡献都应能追到这组身份，不能只用可重复的插件名或 PID。

插件通过 `activate(context)` 注册服务、贡献和 effects。`context.lifecycle.signal` 是取消真源。现有 `effects.add` 在候选准备阶段提交可撤销资源，此时活跃图仍是旧版本；需要发布后启动的工作使用 `context.publication`。其同步 `publish/rollback` 与服务/贡献图一起提交，`afterPublish` 启动工作，`retire` 释放已发布 owner；独占 worker 等待 `previousRetirement`。详见[publication 生命周期](plugin-publication-lifecycle.md)。替换或关闭时，内核先停止接受新请求并触发 signal，然后按依赖图逆序开始释放：消费者先于提供者，同一实例的 effect/disposer 也按受控顺序结束。

## Process Lease

插件需要长期子进程时必须经统一 Process Lease Registry 创建。租约 owner 至少包含应用代、Manager 实例、activation、插件实例和 revision。Registry 执行：

- 同一 owner/key 防重复；
- `maxChildProcesses` 资源上限；
- quiesce 后拒绝新子进程；
- 在 `shutdownTimeoutMs` 内排空，超时后终止进程树；
- generation、实例或 Manager 释放时回收所有租约。

插件直接 `spawn` 后丢失 owner 属于设计矛盾。Windows Job 会在应用代结束时兜底清理，但不能替代插件租约。

## 热替换

Profile 或包 revision 变化时，Plugin Kernel：

1. 读取并校验 v2 Manifest/Profile；
2. 建立 capability 图，拒绝缺失依赖和循环；
3. 按执行模式准备候选，不让 `isolated` 顶层代码进入 Manager；
4. 验证 `readyRequires`、权限和贡献；
5. 原子提交候选 generation，新请求只进入新图；
6. 排空旧请求，按消费者 → 提供者顺序释放旧图和租约。

候选失败不会污染当前 generation，也不会留下半激活服务或子进程。未变化且未依赖变化的实例可以保留；依赖 provider 更换时，对应消费者必须一起更换。

## 作者门禁

可信 Manager 包可使用共享 SDK、Node 内置模块和包内 `./` 模块拆分实现。入口检查拒绝其他裸依赖、跨包路径和符号链接；这不是 JavaScript 沙箱，执行权限仍由 entry 模式和宿主能力边界决定。包内业务模块随插件一起构建，不能回引源码工作树。

```powershell
npm test
npm run build
npm run check:config
```

新增插件还需验证：非 v2 Schema 被拒绝；`isolated` 顶层代码未被 Manager loader 执行；缺少 `readyRequires` 时不能伪报必需能力已就绪；消费者先于 provider 释放；进程租约在 reload、失败和 Manager 退出后归零；Desktop/Web 只消费声明贡献，不获得应用生命周期能力。

归档写入的原文件句柄必须观察到真实 close 才能发布元数据；close 失败保留同一 owner，后续显式元数据 flush 只核对该原资源。冷查尚未载入原首次事实或读取失败时，不用较新的 current 替代 first；读取失败明确返回 `OUTCOME_FIRST_UNAVAILABLE`，仍保留可核对的 current。此错误不代表原业务未执行，也不允许重发。

只读调用使用独立的跨 activation 内存额度，不占用写入 unknown 的额度，也不执行归档 fsync。原生结果若明确报告与只读声明矛盾的 unknown，保留原调用及同一额度，并让未归档事实的派生方法索引跨 activation 生效。普通已结束的只读失败在原失败通知被接收后可淘汰诊断；原进程真实 close 且执行已结束也可释放只读内存额度。未结束、未接收或真正 unknown 不按普通成功清理。探测不经此业务调用额度。

新增的 `host.manager.route-control-registration@1` 是父进程拥有的异步注册能力；原 `host.manager.route-control@1` 原生对象保持不变。Route control 子进程只准备可克隆句柄，原 SDK 效果提交时才由父作用域登记 API，取消与退出加入同一注册和真实子进程关闭。清单中的 core/gateway 依赖仍参与排序；不需要传输的原生依赖仅作为不可传输描述保留，实际读取时明确报告 `UNSUPPORTED_SERVICE_TRANSPORT`。这不改变连接权限，也不表示其他默认插件已迁移。正常打包把 isolated 入口的 SDK 也放入包内 `.rabi-deps`，不依赖源码目录或备用 Runtime。

构建时若未从插件入口识别本地释放语句，会输出非阻断诊断；父进程拥有的资源可能通过异步注册能力管理。此源码启发式不代替实际生命周期合同和资源释放测试。Schema、非法入口、跨包依赖等明确错误仍会使检查失败，不添加假释放函数来满足文本规则。

显式配置 `RABIROUTE_PLUGIN_IN_PROCESS_ROOTS` 时，值为 JSON 目录数组，`[]` 仅禁用 `in_process` 插件；未设置时不按来源目录额外限制。格式错误会记录字段和修改入口，并跳过这个无效的可选字段，继续按插件原声明的执行方式加载。不存在的目录只产生诊断，其他有效目录仍按原配置生效。非空目录数组没有任何匹配项时，跳过这个无效的可选限制；合法的 `[]` 仍禁用 `in_process` 插件。诊断不回显错误配置原值。该字段不授予或撤销接口访问权限。
