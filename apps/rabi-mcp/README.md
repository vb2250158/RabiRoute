# Rabi 知识 MCP

[English](README_en.md) | 简体中文

状态：实验实现，尚未安装发布或完成真实 Agent、手机与眼镜验收。

本应用通过官方 MCP SDK 的 stdio 或受控 Streamable HTTP 协议提供 RabiPC 计划与记忆工具，不运行推理、不持有业务数据、不启动远端 Agent。MCP 宿主启动 `node knowledge-mcp.mjs`，每次业务调用通过本机 Host 重新发现 Manager 并校验身份，不使用固定 Manager 端口。

## 配置

在 MCP 宿主的环境变量中设置：

- `RABIROUTE_HOST_EXE`：可选，本机 Host 可执行文件；默认检查标准安装位置，缺失时查询正在运行的 Host 路径并核验当前身份。
- `RABI_MCP_ALLOWED_ROLES`：可选 JSON 字符串数组，例如 `["example"]`；未设置不限制角色，显式 `[]` 禁用全部角色，设置名单时只允许其中的角色。
- `RABI_MCP_ALLOW_WRITES`：默认 `true`；只有显式 `false` 才关闭写入及会更新阅读时间的近期详情。

默认提供知识搜索、计划列表/详情/状态目录、记忆列表/详情，以及计划和近期记忆创建/更新。显式关闭写入后隐藏写操作和会更新阅读时间的近期详情。限制错误会指出具体配置和修改入口。更新必须携带原样强 ETag，写入必须携带预先保存的稳定幂等键。近期详情依当前 Manager 的 touch 回执校验；只读 Manager 无该回执时不确认成功。

不提供删除、归档写入、沉淀执行、附件、任务绑定或任意 HTTP 请求。超时、503、身份切换或不完整回执要求权威读回，不自动重放。412 后重新读取并确认意图，再使用新键与新 ETag。

## 受控 HTTP 接入

设置 `RABI_MCP_TRANSPORT=http`，并通过启动环境提供至少 32 字符的随机 `RABI_MCP_HTTP_TOKEN`。`RABI_MCP_HTTP_PORT` 默认 `0`（系统分配），进程以不含密钥的结构化 `READY` 输出实际地址。服务默认监听 `127.0.0.1`，可通过 `RABI_MCP_HTTP_HOST` 显式修改监听地址。业务调用仍须 Bearer 鉴权；Cookie 和 Host 别名不会额外拒绝已鉴权请求。`RABI_MCP_ALLOWED_ORIGINS` 是可选 JSON 数组，未设置不限制 Origin，显式名单（含 `*` 或 `null`）按配置生效；支持浏览器 OPTIONS 预检。`RABI_MCP_HTTP_MAX_BODY_BYTES` 可调整正文预算，默认 65536 字节，超限响应指出该配置；不要把 Token 放入 URL、日志或公开配置。

这是标准 MCP Streamable HTTP，不是任意 REST 转发。眼镜不能直接访问 PC 回环地址，仍需受认证的 PC/Relay 连接和设备授权；监听地址、可选角色/Origin 限制及写入开关由用户在启动配置中设置。当前 HTTP 模块通过官方 SDK 客户端测试；此前 stdio 产物不包含后续 HTTP 改动，须重新打包。

## 独立本机打包

在包含本应用、`apps/rabi-agent/lib/` 共享传输源码和 `packages/rabi-knowledge-contract/` 共享合同的完整源码快照中执行。保留仓库相对目录结构；共享 schema 会内联进产物并记录在源码输入哈希清单中：

```sh
npm ci
node scripts/build.mjs --output <新的绝对目录>
```

输出目录必须不存在，父目录须已存在；支持可访问的本机、NAS/UNC 与映射盘路径；不覆盖既有产物。Windows 直接通过 Node 运行 npm CLI，不使用会丢失 UNC 工作目录的 cmd。脚本内联相对源码依赖，SDK 保持外部依赖并按独立锁文件执行生产 `npm ci --ignore-scripts`，输出入口、双语说明、依赖及 `artifact-manifest.json` 文件哈希清单。失败保留未完成目录供检查，不自动删除。产物仅支持本机 Host；未执行的 LAN 分支保留动态 `bonjour-service` 引用，不提供远端模式。产物未纳入 Windows 安装流程，也不代表已安装。

## 开发和打包边界

源码中的三个传输桥引用 `../rabi-agent` 的唯一传输实现。从包含共享依赖的完整源码快照运行；独立产物必须内联这些相对依赖或显式暂存受控文件，不能只复制本目录。本应用和 PC 根运行时分别使用固定版本 SDK；不向 `rabi-agent` 加入 SDK，也不改变远端 Agent 更新依赖。构建与依赖安装使用用户指定且可访问的目录。

当前已有模块、真实 HTTP 假 Manager、官方 SDK 内存与真实 stdio 子进程测试；真实 Host 下入口初始化和只读工具目录已验证，未读写真实知识数据。测试成功不是宿主已经注册工具，也不代表手机可直接配置 MCP。手机 Relay 管理需要选择目标电脑；外部 Agent 的工具加载和权限仍由该宿主拥有。

超时由 WebGUI 的 `mcp.*` 设置管理。MCP 启动环境可传 `RABIROUTE_TIMEOUT_OVERRIDES` 快照供首次 Host 发现使用，随后从验证身份的 `/meta` 刷新。Host 发现与知识 HTTP 请求下次操作生效；MCP HTTP 请求接收、收头与连接保活在下次启动服务生效。未覆盖保留原默认值。
