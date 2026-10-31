[English](persona-companion-api-contracts_en.md) | 简体中文

# 角色陪伴接口合同

状态：8 个公开接口已迁移到可执行操作注册；原生 owner 和隔离 HTTP 回归覆盖不代表桌面采集、真实 Agent 投递或语音效果已经验收。

`createPersonaCompanionOperations` 注册 `GET /api/roles/:roleId/companion`、`GET .../last`、`GET .../frame`，以及 `POST .../start`、`.../command`、`.../observation`、`.../review`、`.../reply`。原来没有 `/roles` 别名，本次不新增。JPEG 回读沿用当前 review 的过期和会话版本检查。

`CompanionActivity` 仍唯一拥有活动、帧缓冲、观察序列、讨论、原 Agent/TTS 回调及摘要。启动保留 requestId 与完整输入指纹；命令保留完整 sessionId 和 revision，回复保留 reviewId 与去重。切换、暂停、停止及 20 秒采集失活租约沿用原行为。桌面继续意图保存在原 `CompanionContinuationStore`，暂停、停止清除，恢复与切换模式更新。状态和摘要保存失败需要回读原会话，不能自动重发真实投递。

准备阶段先固定原连接、角色目录、Manager 身份与服务对象；JSON 控制仍要求对象、`application/json` 和最多 3 MiB。内部命令与持久化队列进入、异步角色上下文返回、投递和语音前重新核对原 owner。已开始的原生调用会等待真实终态；连接取消不会被解释成工作已取消。已写入的摘要或已尝试投递不回滚，失败可标记 `uncertain`。窗口分类缓存按当前目录区分，排队保存固定原路径，不随配置切换写到新角色目录。

接线回调必须接收并沿自身异步步骤传递可选的 `assertCurrent`：角色上下文、ASR、转写读取、投递、语音及摘要回调在各次等待后、下一次真实执行前复核。原摘要、窗口分类和继续意图使用同一个原子写辅助函数，在文件写入与替换前再次复核；播放转写保存将调用方断言与原采集会话围栏组合。

已鉴权并启用的远端连接默认可调用全部上述公开接口；Route 和角色配置用于目标和执行正确性，不是额外功能许可。本机入口继续验证原本的来源与只读配置。真正回答、采集、播放、持久化仍由原执行端完成。使用和现场限制见[桌宠陪伴模式](companion-mode.md)。
