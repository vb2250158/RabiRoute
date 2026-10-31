简体中文 | [English](./plugin-publication-lifecycle_en.md)

# 插件 publication 生命周期

状态：内核与正式 SDK 已实现，使用隔离 fixture 验证。各插件迁移、统一构建与运行验收由对应插件和发布 owner 完成。该接口不改变应用 generation 或连接权限。

同步 publication 适用于 `in_process` 执行。`isolated` RPC 当前没有同步跨进程提交协议，不能用该回调承诺 Manager 原子指针切换；该模式的调用应明确拒绝为不支持。声明式插件只注册贡献，不执行 publication 回调。

`in_process` 是可信本机代码的执行边界。业务处理、资源获取/释放和 publication 回调完整执行其同步栈，不用固定墙钟期限强制打断事务或跳过 `finally`。异步操作仍受原期限和取消信号控制，实际资源结束前保持归属并等待释放；超时不能冒充未提交或已清理。纯结果计算的保护不扩展成原业务事务抢占。需要隔离失控或不受信任代码时使用现有 `isolated` 子进程执行器；本合同不承诺可信进程内无限循环可安全中断。

## 正式接口

通过 `@rabiroute/plugin-sdk` 导出的类型与 `activate(context)` 使用：

```ts
type PluginPublicationContext = Readonly<{
  signal: AbortSignal;
  previousRetirement: Promise<void>;
}>;
type PluginPublication = Readonly<{
  publish(): void;
  rollback(): void;
  afterPublish?(context: PluginPublicationContext): void | Promise<void>;
  retire?(): void | Promise<void>;
}>;
context.publication.add(publication, label?);
```

首次激活或没有旧 activation 时，`previousRetirement` 是已完成的 Promise。替换时，它只对应相同 `instanceId` 的旧 activation，等待其 scope 的所有 disposer，包括请求/stream 的实际 owner drain。它不是整个旧 generation 的屏障，也不改变 HTTP、stream 或业务操作自身的完成定义。

## 宿主调用来源围栏

每次 `GenerationRuntime.switch(candidates, options)` 可以传入同步 `GenerationSwitchOptions.beforePublish?: () => void`，例如 `beforePublish: () => invocation.assertCurrent()`。该回调在全部候选异步准备、effects 提交和最终就绪校验之后，首次 publication 指针修改之前执行，位于同一 rollback/cleanup 事务内。来源撤销或身份变化时抛错，候选清理，旧服务/贡献图保持原值，`afterPublish` 不执行。未变化的 switch 也执行该围栏。

围栏只用于核对原调用来源和身份是否仍有效，不是新增逐功能 grant。它必须同步、只读；返回 Promise 会被明确拒绝，不能用异步检查冒充发布前围栏。调用方负责传入本次 invocation 的真实校验函数，内核不会从角色、计划或功能目录推导额外权限。

## 提交与失败

1. `activate` 准备候选服务、贡献和资源。不得覆盖活跃全局指针、写持久业务状态、暂停旧 job 或停止旧 supervisor。
2. 现有 `effects.add` 在候选准备阶段提交，用于能够撤销的注册与资源；此时当前图仍指向旧 activation。路由注册由 activation 身份隔离。它不是发布后工作入口。
3. 服务、贡献和就绪检查通过后，内核同步执行所有候选的 `publish`，随后立即切换活跃服务/贡献图；中间没有 `await` 或宿主发布观察回调。`publish` 仅做可逆、同步的指针切换，不做 I/O、不启动工作、不读取新图调用业务，也不返回 Promise。
4. 某个 `publish` 或后续暂存 `retire` 的注册抛错时，内核按逆序对所有已尝试回调调用 `rollback`，包括抛错的 `publish` 自身。失败组件、共享 Web 实现组及真实依赖者被撤回，无关候选仍可发布。已确认的旧 owner 可以继续服务；回滚未确认时撤回相关入口并保留清理围栏。全局发布围栏失败才取消整个发布尝试。已暂存的 `retire` 保持无效，不会误执行。`rollback` 只撤销本次变更，必须能处理部分写入；恢复失败以聚合错误报告，不声称成功恢复。
5. 所有 activation 的可失败注册都准备成功后，内核用不调用插件代码的同步 finalizer 一起确认发布，再切换活跃图并通知宿主。直到整批确认前，先准备成功的 activation 仍可 rollback。此后 `retire` 才具备执行资格，不再调用 `rollback`。
6. 内核开始旧 scope 退役并调用新 activation 的 `afterPublish`。独占 worker 必须先 `await previousRetirement`，再检查 `signal`，然后启动新 worker。无需独占资源的启动可与旧请求 drain 并行。未变化的 activation 不重复调用 publication 回调。
7. 旧 scope 先 abort，再按 effect 逆序清理。超时或清理错误会使 `previousRetirement` reject；超时不是 join 成功。插件必须实际 await 自有 worker/请求的结束，不能只发送 abort 就报告退役。
8. `afterPublish` 的 Promise 由内核等待和观察；失败进入 `runtime_failed`，撤下该 activation 及其必需依赖消费者，触发宿主 `onRuntimeFailure` 并清理新资源。已经发生的持久写入或外部动作不会回滚，也不会恢复已开始退役的旧图。`switch()` 返回当前失败后的 generation。

失败候选从未注册 `retire`；在候选准备阶段已取得的私有资源应使用 `effects.adopt` 收回。正常发布后的替换、关闭或 runtime failure 都通过同一 effects scope 调用 `retire`，先触发 `lifecycle.signal`。重复 dispose 等待同一清理 Promise，不提前声称已完成。

退役超时后，内核仍保留未确认结束的旧 owner。即使失败的新 activation 已被撤下，后续重试的 `previousRetirement` 也不能绕过它。原 disposer 后续真实完成且成功后，新的重试才可通过屏障；原 disposer 抛错且无法证明完成时，屏障继续拒绝，不能仅因耗时已过而恢复独占启动。

运行时关闭也检查这些已移出活跃图的未确认 owner；活跃实例为空不代表关闭完成。仍有未确认清理时，`GenerationRuntime.dispose()` 返回带 `shutdown` 诊断的失败；若关闭前已真实清理成功，则不再阻塞关闭。重复关闭调用返回同一个 Promise，保留首次关闭的失败结果，不因已设置关闭标记而改报成功。

## owner 与异步启动

`rollback` 和 `retire` 是不同动作：前者恢复尚未发布的尝试，后者释放曾经发布的 activation。旧 `retire` 不能无条件清空新全局指针、停止新 shared runtime 或恢复持久 job 状态。保留实际资源对象和 activation 身份，按 owner 比较后释放。

```ts
let previousOwner;
let ownedWorker;
context.publication.add({
  publish() {
    previousOwner = bridge.current; // 在提交时捕获，不在 prepare 时捕获
    bridge.current = service;
  },
  rollback() {
    if (bridge.current === service) bridge.current = previousOwner;
  },
  async afterPublish({ previousRetirement, signal }) {
    await previousRetirement;
    signal.throwIfAborted();
    ownedWorker = await service.startWorker(signal);
  },
  async retire() {
    await ownedWorker?.stopAndJoin();
    if (bridge.current === service) bridge.current = undefined;
  }
}, "service owner");
```

示例中的 `bridge` 是宿主已有稳定桥接对象，`service` 与 `ownedWorker` 属于当前 activation。若 `startWorker` 部分成功后抛错，插件仍须保存已取得的资源供 `retire` 或 `effects.adopt` 清理。异步回调必须自行结束、响应取消并等待后台工作；不允许脱离 scope 的未观察任务。

`createPluginTestHarness()` 覆盖单个插件的 publication 顺序和清理；跨 revision 原子性、失败保留旧图、真实请求/stream drain 使用 `GenerationRuntime` fixture 验证。同步回调中的第三方代码可主动观察中间状态，所以不得在其中调用外部观察器或重入业务；此合同不是 JavaScript 沙箱。
