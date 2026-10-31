<!-- docs-language-switch -->
<div align="center"><a href="./rabilink-mobile-owner-api_en.md">English</a> | 简体中文</div>
<!-- /docs-language-switch -->

# RabiLink 手机状态接口合同

本文面向 Manager 和远端客户端接入开发者。接口定义位于 `src/manager/rabiLinkMobileOperations.ts`，业务和持久化由 `src/manager/rabiLinkMobileOwner.ts` 拥有；同一份可执行定义同时安装路由和发布发现目录。

## 接口

| 操作 ID（前缀 `manager.rabilink.`） | 方法与路径 | 结果 |
| --- | --- | --- |
| `mobile.asr-settings.read` | `GET /api/rabilink/mobile/asr-settings` | 优先顺序、当前 ASR worker 和在线首选项 |
| `mobile.asr-settings.save` | `PATCH /api/rabilink/mobile/asr-settings` | 保存 `{priority: string[]}` 并按当前 worker 生成结果 |
| `mobile.device-status.read` | `GET /api/rabilink/mobile/device-status` | 最后上报状态及按接收时间计算的新鲜度 |
| `mobile.device-status.record` | `POST /api/rabilink/mobile/device-status` | 保存手机上报的电量和充电状态 |
| `mobile.proof.record` | `POST /api/rabilink/mobile/proof` | 保存带稳定 UUID 的上报记录 |
| `mobile.proofs.list` | `GET /api/rabilink/mobile/proofs?limit=20` | 最近记录，按时间倒序 |
| `devices.health-capabilities.read` | `GET /api/rabilink/devices/health-capabilities` | 可穿戴观察处理合同的声明 |

最后一项沿用原生业务函数，现纳入同一个可执行注册入口。声明本身不证明设备在线或真机流程已验收。

## 身份与数据归属

已鉴权且启用的连接默认可调用这些公开接口，无需另外绑定人格、计划或功能许可。准备阶段在解析正文前保留原连接 scope、来源设备和 Manager owner；每次等待归属或 worker 查询后，以及写入和返回前，重新核对原身份。配置缺失返回上下文不可用，鉴权失败和 owner PC 不一致分别返回独立错误。

ASR、状态、proof 和操作回执保存在原 PC 的 `RabiLinkOwnerStore`，按连接 scope 隔离。处理手机状态的请求还会确认应用仍归当前 PC；能力声明只需要原连接身份。Relay 和客户端不另存业务真源。接口不会启动 ASR worker、执行 Agent 提示词或操作真实设备。

## 写入与恢复

三个写接口要求 `Idempotency-Key`：1–128 个 ASCII 字母、数字、冒号、点、下划线或连字符。原生指纹为 `SHA256(JSON.stringify([action, body]))`。相同 key 和原始意图返回原回执，不同意图返回 409；未知字段虽不参与业务取值，仍参与指纹。每个 scope 最多保存 2048 个操作回执，满额拒绝新操作，不驱逐旧回执。

空 HTTP 正文沿用生产解码器的 `{}` 默认值；它与显式 JSON `null` 是不同意图。升级后空正文仍能用原 key 回放历史 `{}` 回执。

ASR 回放保留当次保存的优先顺序，worker 列表来自当前观察。状态回放保留原 `receivedAt`，动态重算 `ageMs`；超过 180000 毫秒标记陈旧。proof 回放保留原 UUID 和记录时间，不重复追加。结果不确定时保留原 scope、key 和正文再核对/回放；当前值缺失不能证明原请求没有执行。写入已开始后发生身份变化或异常时保留 `uncertain: true`。

## 损坏记录的隔离

持久化原文保留供恢复，读取或正常写入不会清理坏记录。proof 列表跳过格式错误的单条记录，并用 `invalidRecords` 返回数量；健康记录仍可查询和追加。损坏的当前手机状态仅使该状态的读取与新写入返回 `503 MOBILE_STATUS_RECORD_INVALID`，不影响 ASR 设置或 proof。

操作回执按原 `Idempotency-Key` 核对。能识别 key 的坏回执只阻断该 key；无法识别 key 的坏回执使新操作无法证明未执行，因而拒绝这类新写入。已有完整回执仍可用原 key 和原正文重放，其他健康读取继续可用。即使当前状态已损坏，原成功状态回执也能重放；回放不覆盖当前坏数据。不要换 key 绕过待恢复记录。

## 原生参数语义

ASR 最多接受 100 个不重复且当前具有 ASR 能力的 worker ID。电量使用 `batteryLevel ?? level`，沿用 `Number` 转换、0–100 范围和四舍五入；`charging` 必须是布尔值。有效 `observedAt` 规范化为 ISO 时间，否则使用接收时间。

proof 保留已有字段别名及 80/120/220 个 UTF-16 单元的截断规则，最多 50000 条。查询 `limit` 保留 `Number` 转换、无效/0 默认 20、夹到 1–100 和原生小数 `slice` 语义。写接口沿用无应用层字节上限的 JSON 解码；合同不额外收紧原生宽松字段。

## 验证范围

源码测试覆盖真实临时文件保存和 owner 重建、回执重放及冲突、scope 隔离、容量、分页、等待期间身份撤销和取消，以及经真实 LAN Agent 身份入口的成功状态上报与撤销后禁止追加 proof。测试上报数据为合成数据，不构成手机、眼镜、麦克风或 ASR 真机验收。完整目标及剩余范围见[目标架构](./api-contract-discovery-target-architecture.md)。
