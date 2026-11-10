# Rabi MCP

[English](README_en.md) | 简体中文

本应用通过官方 MCP SDK 的 stdio 或 Streamable HTTP 提供 Rabi 全部公开 operation 的分类、搜索、描述和调用。CLI 与 MCP 共用 operation SDK，业务通过当前 Manager 及原插件 owner 执行。MCP 宿主启动 `node knowledge-mcp.mjs`，本机 Host 发现负责当前地址和身份。

当前为本批源码实现，安装版采用和目标 Agent 工具加载随发布验收确认。完整合同与命令见 [CLI 与 MCP 统一接口](../../docs/unified-agent-api.md)。

## 默认工具

默认展示 `rabi_categories`、`rabi_list`、`rabi_search`、`rabi_describe`、`rabi_call` 和 `rabi_session` 六个工具。先按分类或关键词取得短摘要，再查看单项 input，最后调用原 operation。长结果 schema 按 result/full 读取。

`rabi_call` 的 `operation` 是稳定业务接口 ID，`input` 与 CLI 输入 JSON 相同。`requestId/idempotencyKey` 标识本次请求，`expectedRevision` 携带原强 ETag。HTTP、二进制和文件返回原状态与回执，流式调用返回原 `sessionId`，使用 `rabi_session` 读取、发送或关闭。

既有十个知识工具名称继续接受兼容调用，默认工具目录使用统一六动作。新增插件 operation 经当前目录发现，无需为每个业务接口新增 MCP 工具。

## 配置

在 MCP 宿主启动环境中配置。

- `RABIROUTE_HOST_EXE` 可选。本机 Host 路径未设置时，入口使用标准安装位置和当前运行 Host 发现。
- `RABI_MCP_ALLOWED_ROLES` 可选 JSON 字符串数组。未设置时支持全部角色，显式名单仅限制该配置范围。
- `RABI_MCP_ALLOW_WRITES` 默认 `true`。显式 `false` 按当前 operation effects 关闭状态变更调用，并报告具体配置。

目录用于发现。操作仍执行当前连接鉴权、资源语义、CAS 和幂等合同。未知写入保留原编号与载荷并查询原回执。

## 受控 HTTP 接入

设置 `RABI_MCP_TRANSPORT=http`，并通过启动环境提供至少 32 字符的随机 `RABI_MCP_HTTP_TOKEN`。`RABI_MCP_HTTP_PORT` 默认 `0`（系统分配），进程以不含密钥的结构化 `READY` 输出实际地址。服务默认监听 `127.0.0.1`，可通过 `RABI_MCP_HTTP_HOST` 显式修改监听地址。业务调用仍须 Bearer 鉴权；Cookie 和 Host 别名不会额外拒绝已鉴权请求。`RABI_MCP_ALLOWED_ORIGINS` 是可选 JSON 数组，未设置不限制 Origin，显式名单（含 `*` 或 `null`）按配置生效；支持浏览器 OPTIONS 预检。`RABI_MCP_HTTP_MAX_BODY_BYTES` 可调整正文预算，默认 65536 字节，超限响应指出该配置；不要把 Token 放入 URL、日志或公开配置。

Streamable HTTP 使用标准 MCP 协议。远端设备经现有已鉴权 PC/Relay 连接访问所选电脑，监听地址、角色/Origin 范围和写入开关由启动配置持有。目标宿主实际工具加载、连接与业务结果分别验收。

## 独立本机打包

在包含本应用、`apps/rabi-agent/lib/` 共享传输源码和 `packages/rabi-knowledge-contract/` 共享合同的完整源码快照中执行。保留仓库相对目录结构；共享 schema 会内联进产物并记录在源码输入哈希清单中：

```sh
npm ci
node scripts/build.mjs --output <新的绝对目录>
```

输出目录必须不存在，父目录须已存在；支持可访问的本机、NAS/UNC 与映射盘路径；不覆盖既有产物。Windows 直接通过 Node 运行 npm CLI，不使用会丢失 UNC 工作目录的 cmd。脚本内联相对源码依赖，SDK 保持外部依赖并按独立锁文件执行生产 `npm ci --ignore-scripts`，输出入口、双语说明、依赖及 `artifact-manifest.json` 文件哈希清单。失败保留未完成目录供检查，不自动删除。产物仅支持本机 Host；未执行的 LAN 分支保留动态 `bonjour-service` 引用，不提供远端模式。Windows 正式包源清单包含统一 CLI/MCP 入口与共享运行依赖，实际包字节和安装采用由对应发布验收确认。

## 开发和打包边界

源码中的三个传输桥引用 `../rabi-agent` 的唯一传输实现。从包含共享依赖的完整源码快照运行；独立产物必须内联这些相对依赖或显式暂存受控文件，不能只复制本目录。本应用和 PC 根运行时分别使用固定版本 SDK；不向 `rabi-agent` 加入 SDK，也不改变远端 Agent 更新依赖。构建与依赖安装使用用户指定且可访问的目录。

当前已有模块、真实 HTTP 假 Manager、官方 SDK 内存与真实 stdio 子进程测试；真实 Host 下入口初始化和只读工具目录已验证，未读写真实知识数据。测试成功不是宿主已经注册工具，也不代表手机可直接配置 MCP。手机 Relay 管理需要选择目标电脑；外部 Agent 的工具加载和权限仍由该宿主拥有。

请求超时由 WebGUI 的 `mcp.*` 设置管理。MCP 启动环境可传 `RABIROUTE_TIMEOUT_OVERRIDES` 快照供首次 Host 发现使用，随后从验证身份的 `/meta` 刷新。Host 发现与知识 HTTP 请求下次操作生效；MCP HTTP 请求接收、收头与连接保活在下次启动服务生效。未覆盖保留原默认值。
