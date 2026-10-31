[English](persona-skill-api-contracts_en.md) | 简体中文

# 人格 Skill API 的可执行合同

Skill 列表、正文和完整 ZIP 下载使用同一组 executable definitions 参与 HTTP 分发与远端发现。读取与打包仍由原有交互读取 worker 执行，不执行 Skill 内的脚本。

| 操作 ID 后缀 | 方法 | 人格下路径 | 路径前缀 |
| --- | --- | --- | --- |
| `list` | GET | `/:roleId/skills` | `/api/roles` 与 `/roles` |
| `detail` | GET | `/:roleId/skills/:skillId` | `/api/roles` 与 `/roles` |
| `download` | GET | `/:roleId/skills/:skillId/download` | `/api/roles` 与 `/roles` |

共 6 个具体路由，完整操作 ID 使用 `manager.personas.skills.` 前缀；`/roles` ID 增加 `.alias`。原 `knowledge`、`knowledge-alias` 派生 ID 保留为别名。已鉴权空节点也可读取其他人格的公开 Skill，不需要 Route、人格绑定或额外功能许可。

## 原生 ZIP 与 lease

下载保留可移植路径校验、元数据 ID 选择、冲突与来源变动检查，以及全部原 ZIP 限制：单文件 16 MiB、原始总量 64 MiB、4096 项、深度 32、ZIP 68 MiB。拒绝链接、危险名称、重复 ID 和覆盖已有输出；不能将正文读取成功当作完整目录下载成功。

每次下载保留一个私有临时目录，原 admission 最多允许 4 个并发 lease，包含生成、慢传输与未确认退出的 worker。传输默认 30 秒；ZIP 仍经 O_NOFOLLOW 打开，检查普通文件、nlink=1 与长度，返回原 Content-Length、文件名、SHA-256 和 ETag。

字节流每帧最多 64 KiB。正常结束、断开、超时或取消都会关闭并等待原文件流，再移除私有目录、释放 admission；尚未开始消费的 iterator 也由显式 cancel 清理。客户端收到最后一段 Content-Length 字节不等于服务端已经完成目录删除，应以实际 lease 释放为准。

`termination_unconfirmed` 保留原 worker pool 的隔离 slot 和私有目录，直到原 `onWorkerReleased` 回调确认退出才清理。清理失败仍占用 admission，并沿用原错误日志回调，避免不断创建孤立产物。

每个请求使用当前人格目录；在等待 worker、打开文件后及流帧之间复核原连接、目录与 Manager 身份。切换目录后的请求不能暴露旧 ZIP。下载不接受 query 参数。通用解码器对畸形 percent 编码返回 400；已有远端入口路径 guard 仍按原合同拒绝危险路径，且不会解析人格或创建临时目录。

## 验证与范围

隔离测试覆盖全部 6 个路由、真实空节点鉴权、原生 catalog/正文/ZIP 字节与哈希、真实 worker 和 CLI `--agent-type` + 完整 `--id` 下载、全部 archive 边界、断开和慢传输、未消费流取消、根目录与代际切换、未确认退出隔离和清理失败保留 lease。测试只使用临时 Skill 数据，不执行真实脚本或 Agent prompt；不代表安装版或物理设备验收。

其他人格接口仍由各自 owner 迁移；全部完成前保留对应旧 prefix 分发。
