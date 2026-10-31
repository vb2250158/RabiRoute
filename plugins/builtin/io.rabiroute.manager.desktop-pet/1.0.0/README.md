简体中文 | <a href="./README_en.md">English</a>

# io.rabiroute.manager.desktop-pet

内置 Manager 插件复用原角色资源、桌面设置、目录工作进程与动作回执，提供 `manager.desktop-pet@1`。不在 Manager 内启动替代桌宠运行时。

`DesktopPetOwner` 与 `createDesktopPetOperations` 从同一可执行合同安装 12 个公共 HTTP 操作。以下路径均以 `/api/desktop-pet/roles/:roleId` 开头，操作 ID 均以 `manager.desktop-pet.` 开头：

| 后缀 | 方法与路径后缀 | 结果 |
| --- | --- | --- |
| `binding.read` | GET 空后缀 | 原角色绑定及默认值 |
| `binding.patch` | PATCH 空后缀 | 合并绑定并保存 |
| `binding.put` | PUT 空后缀 | 保留原合并语义 |
| `dialogue.read` | GET `/dialogue` | 角色对话文本 |
| `transcripts.append` | POST `/transcripts` | 保存匹配角色、voice 和 tts 类型的播放文本 |
| `packs.list` | GET `/packs` | 原目录；`scope=runtime` 只查运行缓存 |
| `packs.import` | POST `/packs/import` | 导入 GIF、PNG 或 ZIP 原始字节并同步运行缓存 |
| `packs.cache` | POST `/packs/:packId/cache` | 将校验过的共享包提升到不可覆盖的运行缓存 |
| `assets.read` | GET `/packs/:packId/assets/:assetPath` | 原始 GIF/PNG 字节 |
| `motion.submit` | POST `/motion` | 接收移动请求并返回原动作回执 |
| `motion.receipt` | GET `/motion/:requestId` | 查询本 Manager generation 的动作回执 |
| `motion.runtime` | POST `/motion/runtime` | 原渲染端领取任务或凭 claim token 回报动作 |

静态资源保持原相对路径、realpath 边界、缓存优先与共享源回退，只返回有限的 GIF/PNG 文件，不做 JSON/base64 封装，也没有新增 SSE 或 WebSocket。资源上限为 64 MiB；绑定和字幕 JSON 为 64 KiB，动作 JSON 为 8 KiB，原始导入为 128 MiB。原归档展开、条目数、脚本与路径规则仍由原导入器校验。

设置写入经过原共享归一化与审计；资源导入、缓存提升和字幕身份仍由原拥有者处理。已鉴权远端沿用同一公共合同及用户明确禁用项，不增加逐角色或本机来源许可。动作提交要求 `Idempotency-Key=requestId`，重复身份必须保持原内容；回执不泄露渲染端 token。运行端回报仍要求原 claim token，成功还需到达位置与目标匹配，不能用 HTTP 202 或 running 当作完成。

目录读取继续使用原 Manager 工作进程。HTTP 超时与真实工作进程释放分开追踪；插件退役先停止接入，等待已接入操作（包括仍在读取 body 的请求），再等待原工作进程释放。断开连接不使原文件动作被遗忘或自动重放。动作回执仍属于原设置对象与 Manager generation，遵循原容量、超时与一小时终态保留规则，不是跨重启持久回执。

隔离测试只证明文件、合同、回执与资源行为；没有启动真实桌宠，也不等于桌面移动、画面、语音或真机验收通过。
