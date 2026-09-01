<!-- docs-language-switch -->
<div align="center">
<a href="./manager-runtime-resilience_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# Manager 运行稳定性与故障证据

稳定性的根基是让每个状态只有一个 owner。Windows 应用由 RabiRoute Host 拥有；Manager 拥有业务状态和插件 generation；托盘只呈现 Manager DTO；插件进程必须持有 Manager 发出的租约。退役的并行守护与托盘自救不属于现行架构。

## 两层 generation

| 层级 | 身份 | owner | 失败边界 |
| --- | --- | --- | --- |
| Windows 应用 generation | `applicationGenerationId` | RabiRoute Host | Manager 或托盘异常退出时关闭整个 Windows Job，再有界重建整代 |
| Manager 插件 generation | Plugin Kernel generation/revision | Manager | 新图准备和校验失败时不提交；已提交旧图按依赖逆序排空和释放 |

应用 generation 先于插件 generation 存在。插件不能启动、关闭或替代 Host，也不能把应用生命周期能力注册成普通插件贡献。

## 启动就绪合同

Manager 让操作系统分配回环端口，完成配置、路由与 Profile 激活后，只有 Profile 的 `readyRequires` 全部可用才进入 ready。被 Host 托管时，Manager 向自己的标准输出写一条结构化 READY，至少包含：

```text
applicationGenerationId
managerInstanceId
pid
baseUrl
readyAt
```

Host 验证 generation、PID、Manager 实例和回环 URL，随后才启动托盘。端口打开不等于 ready，旧端点能响应也不等于当前 generation。

计划存储恢复不属于 application READY 门。Manager 端点与身份、完整必需插件集和 handler READY 建立后即可发布 READY，不等待 NAS 上的计划恢复。计划存储的读取/变更资格由可终止的 one-shot child 另行建立；状态为 `running` 或 `degraded` 时，计划变更失败关闭，`/health` 报告降级，Host 与 Tray 保持当前 application generation。

核心请求层直接提供 `/health`，不依赖可选 diagnostics 插件。它同时返回当前 `applicationGenerationId`、`managerInstanceId`、`managerBaseUrl` 和三项分层判断：`live` 表示 event loop 能响应，`requiredReady` 表示 Profile 的 `readyRequires` 仍完整，`businessReady` 表示计划存储资格和已启用的 Route 入口都已 ready。Host 只把身份不符、`live != true` 或 `requiredReady != true` 计入整代故障；计划存储资格降级会把 `businessReady` 置为 `false`，但不改写 application READY，也不触发整代重启。可选插件、外部 Route 或后台任务降级仍可见，同样不会触发无意义的整代重启。

`/meta` 复用同一份健康快照，并额外暴露插件 generation、Route 和后台任务诊断。同代客户端必须核对身份；Host 外的源码模式则以 Manager 标准输出返回的 URL 作为显式入口。

## 故障恢复

Manager 或托盘子程序异常退出时，Host 不做局部补丁式复活。它停止本代 Job，释放全部子进程，然后按有界退避启动新代。达到失败上限后熔断并保留日志，等待显式用户启动或重启命令。

插件 reload 在 Manager 内完成 prepare → validate → commit：

1. 解析 schema/profile v2，但不在 loader 阶段执行入口顶层代码；
2. 按依赖顺序准备候选实例，并验证权限、服务与 `readyRequires`；
3. 提交后把新请求切到新 generation；
4. 旧 generation 先停止消费者，再停止提供者；
5. `lifecycle.signal` 先中止，effect/disposer 和 process lease 随后收束；
6. 候选失败时保持上一已提交 generation，不留下半激活进程。

## 进程租约

Manager 或插件创建的长期子进程必须通过统一 Process Lease Registry。租约记录 generation、插件实例和用途，禁止插件绕过 Registry 产生无人拥有的后台进程。generation 释放、插件卸载和 Manager 退出都会收回相应租约；重复释放保持幂等。

Windows Job 是应用代的最后边界，process lease 是 Manager 内部的责任边界。两者相互补强，但不能互相替代。

## HTTP 502 与连接错误

HTTP 502 只说明当前请求的上游失败，不能单凭状态码断言 Manager 退出。排障时依次核对：

1. Host `--command status --json` 是否仍给出当前 generation；
2. `/health` 返回的 generation、Manager instance 与 URL 是否匹配，且 `live`、`requiredReady` 是否为 `true`；
3. Host、Manager、插件/Route 的对应日志是否记录子程序退出、reload 或上游错误；
4. 请求是否错误复用了上一代 URL；
5. 连接预算、并发读、文件句柄或远端 Relay 是否耗尽。

Manager 的本地服务先就绪，Relay、远端页面和非必要适配器在后台连接；远端不可用不能阻塞本机 READY。大文件、聚合与目录遍历不能占住核心请求路径，超时和 AbortSignal 必须传到真实 I/O。计划反馈恢复先从 feedback ledger 找候选，再在 Manager read worker 内以有界并发异步读取对应计划；不得回到同步遍历全部计划或逐候选同步 `getPlan()`。

## 证据位置

```text
%LOCALAPPDATA%\RabiRoute\diagnostics\host\host-YYYYMMDD.log
%LOCALAPPDATA%\RabiRoute\diagnostics\desktop\YYYY-MM-DD\desktop-*\
data/route/<configName>/logs/
```

Host 日志证明应用代和子进程变化；Desktop 证据包证明 Qt/Python 启停；Route 与插件日志证明业务处理。三者不能互相冒充。

## 验证

```powershell
npm test
npm run build
npm run check:config
powershell -ExecutionPolicy Bypass -File .\scripts\build-windows-host.ps1 -OutputRoot C:\RabiRouteBuild\host
```

实机验收必须再覆盖：动态端口冲突、重复启动、Manager/托盘分别崩溃、显式重启、用户退出、Host 被终止、插件 isolated 进程回收，以及退役生命周期 owner 不再存在。测试通过只能证明相应合同，不能替代安装包中的完整生命周期验收。
