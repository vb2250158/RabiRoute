# 电脑接入提示词

[English](rabilink-pc-pairing_en.md) | 简体中文

状态：实验集成。一次性接入、恢复与撤销已通过匹配测试和本机隔离验证；服务器部署此版本后提供接入入口。目标云端的访问与持续运行能力仍按实际环境验收，任务运行时间由平台决定。

## 三步接入

1. 登录公网 RabiLink 控制台 `/manage`，选中要加入的应用，点击 **复制接入提示词**。
2. 把完整提示词粘贴到目标电脑的私密 Agent 任务。Agent 检查环境，安装或沿用独立 RabiPC，下载并校验接入程序，兑换一次性接入码，自动保存私有配置并通过原 Host 启动连接。
3. 回到控制台刷新设备列表，确认该电脑在线，再验证一次同应用内设备发现或已授权的只读访问。

普通接入只有“复制接入提示词”一个入口。提示词已经绑定当前应用，不需要手填应用 token、再选认证方式或二次批准。一次性接入码三十分钟有效，只能成功接入一台电脑；完成后长期凭据由该电脑生成并保存，Relay 只接收摘要。

该方式参照[远端 Agent 接入](lan-rabi-agent-bootstrap.md)的操作流程。两者的授权归属不同：远端 Agent 接入本机 Manager 的节点；RabiPC 接入公网 Relay 的应用。它们不共用管理密钥、节点身份或后台执行器。

接入授予现有应用访问合同中的权限：该电脑可使用同应用内设备开放的管理与知识读写服务。只把提示词发给准备接入的目标电脑。接入码不要放进公开仓库、群聊、截图或日志。提示词与服务端摘要均不包含现有应用主 token。

## 目标 Agent 如何完成接入

接入程序需要 Node.js 20+，实例已有独立 `rabiGuid`，运行根目录下已有 `data/Config.json`。没有实例时，Agent 先按当前平台安装与初始化文档配置 Host；不复制另一台电脑的身份，不直接启动第二个 Manager。Linux 安装与生命周期见 [Linux Host](linux-host.md)。

控制台提示词包含两个固定下载地址及签发时的 SHA-256 和字节数：

- `/api/rabilink/pc-pairings/client/rabilink-pair-pc.mjs`
- `/api/rabilink/pc-pairings/client/rabilink-pc-pairing.mjs`

只下载当前 Relay 的同源 HTTPS 文件，拒绝跨源重定向，完整核对提示词中的摘要与字节数后再运行。摘要在已登录的控制台取得；它提供内容核对，不是独立的软件签名。运行命令不含凭据：

```bash
node /absolute/private/install/rabilink-pair-pc.mjs \
  --relay https://relay.example.com \
  --state-root /absolute/private/rabiroute-runtime \
  --name "Cloud PC" --ticket-stdin
```

由 Agent 通过子进程标准输入提供接入码；程序不接受明文接入码命令参数，拒绝会回显的交互终端输入。运行配置须位于仓库外，或经 Git 确认忽略且未跟踪。

程序先在该实例私有 `data/pc-pairing-request.json` 保存稳定请求身份、接入码及恢复凭据，再请求服务器。服务器在一次持久化写入中兑换接入码并授权本机专属凭据。程序保存原配置备份、检查并发变更、写入并完整回读 `data/Config.json`，保留其他配置；成功后清除请求记录中的一次性接入码。备份和恢复文件可能含凭据，不发送或提交。

通过原 Host 启动或重启。例如 Linux：

```bash
node scripts/linux-host.mjs --command restart \
  --state-root /absolute/private/rabiroute-runtime --json
```

安装成功、兑换成功、配置保存、设备上线和实际访问分别验证。目标 Agent 最终报告名称、身份、是否在线、只读验证结果及持续运行能力；临时云端环境不能常驻时明确说明。

## 中断与断开连接

- 请求断线或进程中断后，重新运行同一命令，沿用原请求记录。程序先读取原回执，已经兑换成功的接入码不会再次创建身份或授权。
- 接入码到期且尚未兑换时重新复制提示词；新接入码沿用尚未提交成功的本机请求。已连接实例直接验证现有配置，不重复接入。
- 设备列表的 **断开连接** 撤销该电脑凭据，并立即关闭对应事件流和中转连接；另一台电脑不受影响。需要重新接入时，复制新提示词并在原命令追加 `--new-request`。仍已授权的请求不能用此参数重复登记。
- 应用停用、删除或主 token 轮换会让该应用的电脑凭据失效。该情况仍要重新签发接入码。
- 配置被 Git 跟踪、运行文件未忽略、身份变化或并发修改时拒绝覆盖。强制终止遗留 `pc-pairing.lock` 后，先确认原进程已经退出再删除锁并恢复。

## 开发合同与兼容

账号控制台签发接口：`POST /manage/api/apps/:appId/pc-pairing-tickets`。浏览器生成随机接入码，只提交稳定 UUID 与摘要。签发须账号登录、JSON、`x-rabilink-pairing-write: 1` 及同源检查；使用相同 UUID 与摘要恢复原签发，不重复制造授权。

电脑兑换接口：`POST /api/rabilink/pc-pairings`，接入码只通过 `Authorization: Bearer` 请求头传入；请求体包含本机身份和随机长期凭据摘要。兑换绑定签发账号及应用，只允许原请求精确重试。私有证明可读取 `POST /api/rabilink/pc-pairings/:id/receipt`；查询字符串不能提供接入授权。撤销为 `DELETE /manage/api/apps/:appId/pc-credentials/:id`。

签发与兑换状态使用现有应用存储，不设后台扫描或等待审批进程。接入码有到期时间、容量限制与兑换速率限制；授权固定到本机 ID、GUID，不能冒充另一台 PC。专属凭据 `rbw_...` 仅在程序内部进入现有 `X-RabiLink-Token` 请求头，服务器保存摘要。

旧手机、AIUI 和开发集成的应用 token 协议仍按已发布客户端合同兼容。旧操作集中于独立的 `/manage?integration=1`；日常控制台不显示 token 或眼镜 SN 接入选项。本次不宣称完成这些客户端迁移。对应客户端发布并确认迁移后，再移除兼容入口。

## 发布

沿用 [Relay 部署流程](rabilink-relay-server.md)。`scripts/rabilink-relay-runtime-files.json` 是运行文件清单；测试、完整构建和发布包范围检查通过后，获得明确授权再发布公网。

`-RuntimeOnly` 只更新 Relay 运行代码，保留远端 WebGUI、OpenAPI、Caddy 和账号、应用、队列数据；`-PrepareOnly` 在本机准备发布包，不连接服务器。公网更新会重启 Relay，连接短暂重连，原管理登录会话需要重新登录。远端运行代码先留备份，失败按原部署流程恢复。
