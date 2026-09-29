# Rabi 知识 MCP

[English](README_en.md) | 简体中文

状态：实验实现，尚未安装发布或完成真实 Agent、手机与眼镜验收。

本应用通过官方 MCP SDK 的 stdio 或受控 Streamable HTTP 协议提供 RabiPC 计划与记忆工具，不运行推理、不持有业务数据、不启动远端 Agent。MCP 宿主启动 `node knowledge-mcp.mjs`，每次业务调用通过本机 Host 重新发现 Manager 并校验身份，不使用固定 Manager 端口。

## 配置

在 MCP 宿主的环境变量中设置：

- `RABIROUTE_HOST_EXE`：可选，本机 Host 可执行文件；默认当前用户标准安装位置。
- `RABI_MCP_ALLOWED_ROLES`：必填 JSON 字符串数组，例如 `["example"]`；工具参数不能扩展授权。
- `RABI_MCP_ALLOW_WRITES`：默认 `false`，显式 `true` 才开放写入及会更新阅读时间的近期详情。

默认提供知识搜索、计划列表/详情/状态目录、记忆列表和沉淀详情。写入开启后提供计划和近期记忆创建/更新。更新必须携带原样强 ETag，写入必须携带预先保存的稳定幂等键。近期详情依当前 Manager 的 touch 回执校验；只读 Manager 无该回执时不确认成功。

不提供删除、归档写入、沉淀执行、附件、任务绑定或任意 HTTP 请求。超时、503、身份切换或不完整回执要求权威读回，不自动重放。412 后重新读取并确认意图，再使用新键与新 ETag。

## 受控 HTTP 接入

设置 `RABI_MCP_TRANSPORT=http`，并通过启动环境提供至少 32 字符的随机 `RABI_MCP_HTTP_TOKEN`。`RABI_MCP_HTTP_PORT` 默认 `0`（系统分配），进程以不含密钥的结构化 `READY` 输出实际地址。服务固定监听本机回环，只接受带 Bearer 的 `/mcp` POST，拒绝 Cookie、未授权 Origin 和超过 64 KiB 的正文。CLI 不开放浏览器 Origin，供受控机器客户端使用；不要把 Token 放入 URL、日志或公开配置。

这是标准 MCP Streamable HTTP，不是任意 REST 转发。眼镜不能直接访问 PC 回环地址，仍需受认证的 PC/Relay 连接和设备授权；不得为图方便改成公网监听。角色白名单与写入开关仍由启动配置固定。当前 HTTP 模块通过官方 SDK 客户端测试；此前 stdio 产物不包含后续 HTTP 改动，须重新打包。

## 独立本机打包

在包含本应用、`apps/rabi-agent/lib/` 共享传输源码和 `packages/rabi-knowledge-contract/` 共享合同的完整本机快照中执行。保留仓库相对目录结构；共享 schema 会内联进产物并记录在源码输入哈希清单中：

```sh
npm ci
node scripts/build.mjs --output <新的绝对本机目录>
```

输出目录必须不存在，父目录须已存在；拒绝 NAS/UNC、映射网络盘和覆盖既有产物。脚本内联相对源码依赖，SDK 保持外部依赖并按独立锁文件执行生产 `npm ci --ignore-scripts`，输出入口、双语说明、依赖及 `artifact-manifest.json` 文件哈希清单。失败保留未完成目录供检查，不自动删除。产物仅支持本机 Host；未执行的 LAN 分支保留动态 `bonjour-service` 引用，不提供远端模式。产物未纳入 Windows 安装流程，也不代表已安装。

## 开发和打包边界

源码中的三个传输桥引用 `../rabi-agent` 的唯一传输实现。只能从完整本机构建快照运行源码；独立产物必须内联这些相对依赖或显式暂存受控文件，不能只复制本目录。本应用和 PC 根运行时分别使用固定版本 SDK；不向 `rabi-agent` 加入 SDK，也不改变远端 Agent 更新依赖。构建与依赖安装须在本机磁盘进行。

当前已有模块、真实 HTTP 假 Manager、官方 SDK 内存与真实 stdio 子进程测试；真实 Host 下入口初始化和只读工具目录已验证，未读写真实知识数据。测试成功不是宿主已经注册工具，也不代表手机可直接配置 MCP。手机 Relay 管理需要选择目标电脑；外部 Agent 的工具加载和权限仍由该宿主拥有。
