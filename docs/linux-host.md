<!-- docs-language-switch -->
<div align="center">
<a href="./linux-host_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# Linux Host：源码启动与运行边界

> 状态：新增 Linux 最小 Host 实现。本文描述当前源码合同，不把构建、本机测试或浏览器可打开当作真实 Relay、双设备投递或长期运行验收。

Linux Host 管理本机 Manager 的启动、当前地址、重启和退出；界面使用已有 RibiWebGUI。Windows Host、托盘、Qt 窗口、系统截图与全局快捷键不属于这条 Linux 路径。Linux Host 启动成功也不意味着 Codex/ChatGPT Desktop、NapCat、语音模型或其他处理端已经可用；各集成仍需自己的宿主、依赖和验收。

## 1. 准备与首次启动

需要 Linux、Node.js 20+、npm，以及 util-linux 提供的 `flock`（位于 `/usr/bin/flock` 或 `/bin/flock`）。构建需访问依赖源，依赖安装可能执行仓库与依赖的安装脚本。不要以 root 运行日常实例。

在仓库根目录运行：

```bash
bash Start-RabiRoute-FromSource.sh
```

脚本每次执行 `npm ci`、`npm run build`，再启动 Linux Host；它不会安装 systemd 服务、登录启动项或 Windows/Qt 桌面。已有本机依赖且无需重新构建时使用：

```bash
npm run start:linux
npm run status:linux -- --json
```

默认在后台运行，输出当前状态、WebGUI 地址与日志位置。打开本次输出的 URL；不要保存某一次端口为永久地址。也可运行：

```bash
node scripts/linux-host.mjs --command open
```

有 `DISPLAY` 或 `WAYLAND_DISPLAY` 时，`open` 调用 `xdg-open`；无图形会话时只打印状态和 URL。远端服务器的 `127.0.0.1` 属于服务器本身，不能直接在另一台电脑上打开。Host 固定使用回环监听，不自动开放公网入口。

普通首次启动会建立本机运行配置及设备身份；这是应用的正常本机初始化，不代表已连接某个 Relay。首次准备资料、检查页面而不启用集成，可使用下面的只读模式。

## 2. 命令与运行模式

```bash
node scripts/linux-host.mjs --command start
node scripts/linux-host.mjs --command status --json
node scripts/linux-host.mjs --command open
node scripts/linux-host.mjs --command restart --json
node scripts/linux-host.mjs --command quit --json
npm run stop:linux
```

- `start` 是默认命令；已有同用户 Host 时返回现有状态，不启动第二个实例，也不改变已有实例的参数。
- `status` 查询活跃 Host；没有可用控制连接或校验失败时退出失败，不从日志或旧文件伪造在线状态。
- `restart` 由 Host 停止旧 Manager 并创建新的运行代。Manager 地址及两项运行身份都需重新发现。
- `quit`（兼容别名 `stop`）请求退出 Host；“Shutdown accepted”仅表示已受理，进程清理随后完成。
- `--json` 输出便于脚本读取的状态；`--foreground` 不转入后台，适合终端排障或外部服务管理器。
- `--read-only` 禁止 Manager 配置写入、自动集成和对端隧道连接，并自动关闭 Route 自动启动。缺少隧道密钥时只使用内存身份，不新建持久隧道密钥。Host 的日志、运行租约与控制描述文件仍需写盘，因此不是完全无磁盘写入的模式。
- `--no-autostart` 关闭 Route 自动启动和配置事件 watcher，但仍允许配置写入；它不是只读或外部连接隔离模式。
- `--state-root` 必须是绝对路径；省略时使用仓库根目录。`--package-root` 也必须是绝对路径，通常无需手动设置。

只读前台检查：

```bash
npm run start:linux -- --foreground --read-only
```

分离软件与本机状态：

```bash
npm run start:linux -- --state-root "$HOME/.local/share/rabiroute"
```

这些启动选项只在创建 Host 时生效。只读、关闭自动启动或软件/状态目录参数与正在运行的 Host 冲突时会拒绝复用。改变模式、状态目录或运行构建前，先正常退出已有 Host，确认退出后再启动；`restart` 继续使用现有 Host 的启动参数。不同工作目录、仓库副本和状态目录不创建额外的同用户 Host 槽位。

## 3. 当前地址与健康核对

Host 从自己启动的 Manager 读取 `RABIROUTE_MANAGER_READY:` 结构化输出，核对进程、`applicationGenerationId` 和非空 `managerInstanceId`，再读取该次 `baseUrl` 的 `/meta`。正常准入要求身份一致，且 `health.live=true`、`health.requiredReady=true`、`health.state` 为 `healthy` 或 `degraded`。单个未配置集成不必阻止控制台正常使用。

`status --json` 提供 `managerBaseUrl`、`applicationGenerationId`、`managerInstanceId`、`hostInstanceId`、运行状态、只读/自动启动选项及日志路径。自动化使用完整 `managerBaseUrl`，调用业务接口前重新核对 `/meta` 的两项身份和所需能力；身份变化后重新发现，不重放结果未知的写请求。不得扫描端口、读旧锁文件猜地址、直接启动或结束受管 Manager。

## 4. 单实例、安全与退出

- Host 和 Linux Manager 分别持有 util-linux `flock` 的内核文件描述符租约。短暂的 `flock` 工具退出后，父进程仍持有已加锁的文件描述符；进程退出或关闭该描述符才释放租约。
- 租约在固定的 `/tmp/rabiroute-process-leases-<uid>/` 下，目录只允许当前用户访问。锁 inode 保持稳定，旁边的 owner JSON 仅作诊断，不能作为活跃进程的证明。不要删除锁文件来“解锁”，不要绕过权限检查。
- Manager 在支持 Unix socket 的环境同时保留旧版租约，防止迁移期间旧构建成为第二个写入者；仅在系统拒绝 AF_UNIX 且旧 socket 不存在时，使用强制保留的 `flock` 路径。
- Host 控制端点使用本机动态 TCP 回环地址。权限为 `0600` 的控制描述文件含本次随机控制 token；命令必须通过活跃连接并校验 Host 身份，重启/退出还校验当前运行代。不要分享、提交或复制控制描述文件及其 token，也不要将它用于 Relay 配置。
- `SIGINT`、`SIGTERM` 和 `quit` 进入正常退出：请求 Manager 关闭，对 Manager 进程组发送 `SIGTERM`，超时后升级为 `SIGKILL`。
- Host 与 Manager 的 Node IPC 连接断开时，Manager 请求正常退出。它不等同于内核对子孙进程的完整收容：被强杀、卡死或脱离进程组的进程仍需要外部监督边界。
- 如部署要求强制回收整个应用进程树，可自行配置 systemd，使用 `--foreground`、明确的绝对路径和 `KillMode=control-group`。这是可选的运维配置，不由启动脚本安装或启用。

Manager 在就绪后意外退出时，Host 以有界退避重启；15 分钟内累计五次运行代失败后进入 `faulted`，需要排查后显式 `restart`。首次启动失败也会报告 `faulted`，不会无限尝试。

## 5. RabiLink：使用已有配置入口

Linux 使用现有 WebGUI 的 RabiLink 配置，不新增 Linux 专用认证方案：

1. 在正常、可写模式打开当前 WebGUI，进入 RabiLink 配置。
2. 核对可信的 Relay 服务器地址。只使用你已确认运营方和目的的地址，不从日志或未知页面猜测。
3. 手动填写该 Relay 应用的可复用应用令牌，启用“连接服务器”，再保存。真实令牌只进入本机受管配置，不写进命令示例、公开 issue、截图或仓库。
4. 分别确认服务器连接、目标设备在线、实际服务就绪与一次明确授权的业务操作。页面可打开或服务器连接成功不能代替业务验收。

保存是持久配置，后续正常启动可恢复连接。填写前应明确：同一应用已鉴权设备默认可使用本机实际提供的服务，包括语音、人格、资源、Manager 管理及知识读写；设备身份、应用隔离、固定公钥和服务就绪仍单独检查。只读模式不能完成这项配置。详见[跨电脑通用连接](rabilink-peer-tunnel.md)和[知识运行合同](rabilink-knowledge-runtime.md)。

## 6. 数据、日志与排障

- 默认状态位于仓库根目录；使用独立状态根时，`data/` 与 `logs/` 位于该根下。日志为 `<stateRoot>/logs/linux-host/host.log`。
- 仓库默认忽略 `data/`、`logs/` 等运行目录；独立状态根应放在仓库外。提交前仍须核对未跟踪和已跟踪文件，忽略规则不会取消已有 Git 跟踪。
- 状态可能含私有配置、身份密钥和业务资料；限制本机目录访问，分享日志前脱敏。不要复制另一台电脑的设备身份来完成新机配置。
- `flock` 缺失：安装发行版的 util-linux 后重试。租约/描述文件权限校验失败：先核查目录所有者、符号链接及权限，不放宽校验或删除活跃锁。
- 构建缺失：运行 `npm ci` 与 `npm run build`。`faulted` 或启动超时：查看 Host 日志，修复依赖或配置，再显式重启。
- 页面打不开：重新运行状态命令，使用当前返回地址；不要尝试历史端口。桌面浏览器无法自动打开时手动打开该地址。

维护验证入口：

```bash
npm run test:linux-host
node --test scripts/dynamic-manager-active-truth.test.mjs
npm run build
```

这些命令需在当前改动后实际执行并记录结果，本文不预先声明通过。真实 Relay 连接、跨设备投递、断线恢复、目标平台依赖与长期运行仍须在相应环境单独验收。
