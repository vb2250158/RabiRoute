---
name: rabiroute-nas-windows-package
description: 将 NAS 工作区中的 RabiRoute 构建并安装为 Windows 本机可搜索、可双击、带托盘的完整运行包，同时让每台电脑保留独立路由和运行日志，并共享 NAS 上的人格、记忆与计划。用于共享源码与人格目录环境的首次安装、换机安装、第二台电脑部署、本机目录迁移、升级重打包或排查本机包与 NAS 数据边界。
---

# RabiRoute NAS Windows 本机包

把版本化程序和机器运行态放在本机，把所有人格的事实源留在 NAS：

```text
<InstallRoot>
  RabiRouteHost.exe                 稳定 bootstrap，唯一进程入口
  current.json                      当前发布指针
  versions/<releaseId>/             经 manifest 验证的不可变程序包
    RabiRouteHost.Core.dll + dist + WebGUI + node_modules + node.exe
    desktop-runtime（仅由 Host 启动）
  data/route/<本机路由> + logs       跨版本保留的本机状态

NAS RabiRoute/data/roles
  <RoleId> 与其他所有角色
  persona + skills + prompts + plans + memory
```

## 固定边界

- NAS 源码参数：`<SourceRoot>`；其他电脑可通过 `-SourceRoot` 指定其映射路径或 UNC 路径。
- 本机安装参数：`<InstallRoot>`。
- 共享根参数（完整 UNC 路径）：`<SharedRoot>`。
- 用 UNC 路径保存共享位置，不依赖各电脑的盘符映射。
- 所有人格始终通过 NAS `data/roles` 整体共享；安装时不得询问“选择哪些人格”。
- route 是本机入口配置，不决定共享哪些人格。已有本机 route 时直接保留并继续安装，不得把 route 选择设为阻塞问题。
- 只有需要从 NAS 源码首次导入 route 配置时才使用 `-RouteNames`；没有 route 也允许先完成程序安装，再由用户通过 WebGUI 配置。
- 不要把同一 NapCat、FenneNote 或 heartbeat 消费入口在两台电脑重复启用。
- 整个 `data/roles` 都由 NAS 共享，不只共享 `<RoleId>`。
- 多条 route 可以使用相同 `agentRoleId`；这是人格共享，不是 route 共享。
- heartbeat 主动智能通常只放在一台电脑，防止重复主动消息。
- 不复制 NAS 的 `data/roles`、消息日志、token、录音或历史运行数据到安装包。
- 允许把本机已绑定桌宠的不可变动作包同步到 `data/cache/desktop-pet-roles/`；它只是可重建运行缓存，不包含 persona、计划、记忆或消息，不能反向写回 NAS，也不能成为动作包真源。
- 不提交生成的 EXE、本机安装目录或私有 route 配置。
- 根目录 `RabiRouteHost.exe` 只负责校验 `current.json` 与发布 manifest，并在同一进程加载当前 `RabiRouteHost.Core.dll`；它是唯一应用生命周期所有者，也是唯一允许的登录自启动入口。所有应用子进程都属于同一 Host generation，不能拥有第二个启动入口或监督器。
- `current.json` 只指向 `versions/<releaseId>`；版本目录发布后不可原地修改。程序资源从当前版本目录读取，`data/`、`logs/`、settings 与运行状态只从稳定安装根读取。
- Manager 默认请求操作系统分配回环端口。端口不是身份，不得缓存、扫描或猜测；Manager READY 把 `applicationGenerationId + managerInstanceId + managerBaseUrl` 发布给 Host，调用方只从 `RabiRouteHost.exe --command status --json` 取得当前 URL，并以 `GET /meta` 核对 generation、instance、PID 与 URL。
- NAS 只保存源码与共享事实源。先把源码物化到 task-only 本机目录，再执行 `npm ci`、build、desktop/Host runtime、release payload、ZIP 与 Setup；日志和运行态也只能落在本机磁盘。
- Portable 包只允许解压到新建的空目录；目标非空立即停止，不把新版本叠加到旧目录。

## 安装流程

1. 阅读 `README.md` 与 `docs/windows-launcher-and-packaging.md`，检查 NAS 真源状态和用户已有修改。
2. 把要发布的源码完整物化到 task-only 本机目录；拒绝 reparse point、`data/` 私有运行资料、日志、token、录音和历史消息进入构建或 payload。
3. 在本机源码目录运行 `npm.cmd ci`、`npm.cmd test`、`npm.cmd run build`、`npm.cmd run check:config`。
4. 在同一本机源码目录运行唯一 Windows release 脚本，生成 portable ZIP 与 Setup：

```powershell
& ".\scripts\build-windows-release.ps1" `
  -OutputRoot "$env:LOCALAPPDATA\RabiRoute\build\windows-release-final" `
  -IncludeSpeech
```

5. 计算 ZIP/Setup 的字节数与 SHA256；审计 payload 中私有状态目录和 reparse point 均为 0，并核对 `release-manifest.json` 的 `appId`、`releaseId`、`payloadSha256`、每个文件的大小与 SHA256。
6. 安装前记录当前 `current.json` 与版本目录作为精确回滚点。Setup 先把候选包放进同盘 task-only staging，完成 manifest、边界与隔离 smoke；候选未通过时不得停止当前版本或改 pointer。
7. 只调用旧安装根的 `RabiRouteHost.exe --command status --json`；若有活动代，使用返回的 generation 执行 fenced quit，并同时检查 client ExitCode、Host ResultCode 与整代自然退出。任一证据不成立都 fail-closed。
8. Setup 将已验证候选原子移入新的 `versions/<releaseId>`，再用临时文件与原子替换切换 `current.json`。新版本启动或身份核验失败时恢复旧 pointer，保留旧版本和全部用户状态。
9. 需要登录自启动时显式选择 `autostart`。安装器将选择写入稳定 settings 真源，并只创建指向 `{app}\RabiRouteHost.exe` 的入口；两者必须一致。

示例：

```powershell
& "$env:LOCALAPPDATA\RabiRoute\build\windows-release-final\RabiRoute-<version>-windows-x64-setup.exe" `
  /VERYSILENT /SUPPRESSMSGBOXES /TASKS="autostart"
```

任何兼容安装入口都只能 fail-closed 地转交上述 release + Setup 流程，不能复制或覆盖安装根中的程序文件。

## 安装脚本行为

release 与 Setup 必须：

- 保持根 bootstrap 稳定，把编译后的 Host core、后端、WebGUI、Tray runtime 和本机 Node runtime 放入一个新的不可变版本目录。
- 把 RabiSpeech 程序、Windows host 和 `.deps` 安装到本机；依赖按 `requirements.txt` 哈希增量复用，避免每次升级重复复制约数 GB 的本地模型运行依赖。
- 在 task-only 本机 staging 执行 production-only `npm ci`，形成没有外部 package junction 的候选 payload；manifest 枚举必须覆盖真实发布文件且拒绝重复路径。
- 未传 `-RouteNames` 时保留目标目录的全部既有 route，并继续安装。
- 传入 `-RouteNames` 时仅导入所选 route 的 `adapterConfig.json`，不复制历史日志与备份。
- 将 `rolesDir` 指向 NAS 的 `data/roles`。
- 从本机 `data/desktop/settings.json` 读取已绑定桌宠，只增量同步对应 `packId` 到本机缓存；同一包的 `pet-pack.json` 哈希未变时保留现有缓存，避免每次升级重拷 PNG 序列。
- 将相对 `codexCwd` 和 NapCat `workingDir` 解析成 NAS UNC 绝对路径。
- 写本机 `data/manager.json`，其中 route 在本机、roles 在 NAS。
- 在开始菜单与可选 Startup 创建只指向根 `RabiRouteHost.exe` 的 `.lnk`；应用子进程不创建快捷方式、Run 项或计划任务。
- 安装/卸载前只通过 Host 控制管道退出完整应用代，并检查进程 ExitCode 与 Host ResultCode；任一非零都中止 pointer 切换或删除。
- pointer 切换、settings 与快捷方式更新都必须原子或可恢复；不能就地覆盖当前版本，也不能在失败后留下半套入口。

## 验证

安装后验证：

1. `<InstallRoot>\RabiRouteHost.exe --command status --json` 返回活动 generation、Manager/Tray 身份、Job 成员与动态 `managerBaseUrl`；禁止自行拼端口。
2. 对该 `managerBaseUrl` 请求 `/meta`，核对 `applicationGenerationId`、`managerInstanceId`、PID 和 URL 与 Host 状态完全一致。
3. Host 直接拥有同代 Manager 与 Tray；Job 成员与 Tray READY 绑定和 Host 状态一致，应用子进程没有其他生命周期所有者。
4. `/api/gateways` 中保留这台电脑原有 routes；全新无 route 安装也属于合法状态。
5. 目标 route 的 `agentRoleId` 正确，`rolesDir` 是 NAS UNC 路径。
6. FenneNote/NapCat/heartbeat 只在预期电脑启用；NapCat 是外部依赖，不进入 Host Job，也不因安装、回滚或 fenced quit 被停止。
7. 登录自启动若启用，唯一入口的目标必须精确等于 `<InstallRoot>\RabiRouteHost.exe`。
8. `current.json` 指向的 releaseId、版本 manifest 与运行中 Host/core 一致；旧版本仍可回滚，版本目录未被就地改写。
9. NAS 暂时不可用时应明确报共享人格不可达，不得静默生成新的本地人格副本。

汇报时只说明 route、adapter、进程和路径边界，不打印 token、QQ 号、私聊内容或完整配置。
