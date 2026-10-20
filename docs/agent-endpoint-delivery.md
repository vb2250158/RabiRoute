<!-- docs-language-switch -->
<div align="center">
<a href="./agent-endpoint-delivery_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# Agent 精确投递与正式回复

本文面向接入开发者，说明新版 Manager 的统一投递合同。源码夹具已覆盖持久化、身份撤销、无工作目录的设备来源和正式回复；实际安装包、跨电脑连接、眼镜唤醒及 ASR/TTS 仍需分别验收。软件已鉴权后的公共接口范围见 [连接与接口使用](connection-access.md)。

## 唯一执行路径

Agent 的 `send` 与 `reconcile_delivery` 进入 `createAgentEndpointDelivery` 和 PC 持有的 `AgentRequestStore`。来源和目标可以是本机宿主、受管远程实例或原生设备 Agent。适配层把已经准备好的消息交给指定 owner，并返回该 owner 的回执。

投递记录保存完整来源与目标身份、原始消息、`deliveryId`、`generation`、消息哈希、执行选项哈希和身份代次。会话 ID 是完整的不透明值，不截断、不通过名称替换。设备端还固定 owner PC、设备、会话和 owner epoch。

连接成功、消息入队、手机提交唤醒动作均不代表实际 owner 已接收。原生设备必须由已鉴权的原会话认领，才能生成对应回执。缺少实际驱动的处理端返回能力缺口，不启动备用 Runtime。

## 来源与执行目录

来源身份由受管连接和当前宿主记录核验。眼镜来源使用内部传入的签名连接身份；请求正文不能声明这份身份。身份在进入投递链时固定，异步读取和实际发送前重新检查原连接是否有效。原设备来源解析失败时，禁止改用正文中的其它来源。

本机转交请求使用进程内签发的 MAC 和一次性 nonce，绑定应用作用域、来源、当前代次、方法及实际 HTTP 路径。裸代理请求头和公开代次值不能声明设备身份；Relay 每次实际 HTTP 尝试重新签发，凭据不交给外部 worker。

来源不必有 `cwd`。眼镜使用乐奇配置的运行环境和模型，不接收电脑的工作目录、模型、推理力度或沙箱选项。

电脑目标需要执行目录时，目录必须是实际存在的绝对目录，并符合该具体 owner 的执行合同。配置中的工作区名单不再作为公共 API 或精确投递的授权名单；角色、消息路线绑定也不限定接口权限。目录校验用于执行上下文和防止误投，不决定用户能否调用公共接口。

## 正式回复与结果不确定

正式回复携带原 `requestId`，必须精确反转原来源与目标，包括 owner 身份、会话、Agent 类型及身份代次。返回设备的参数带 `instanceBinding` 和 `agentAdapter: "deviceAgent"`，不要求设备具有工作目录。

发送超时或回执缺失返回 `delivery_unconfirmed`。调用方应查询或协调原 `deliveryId`；`reconcile_delivery` 只读取原证据，不生成第二次投递。重启恢复沿用原记录，不能换会话、换凭据、换 owner 或重放已开始的消息。

原身份撤销、设备 owner epoch 改变、会话归档或回执哈希不一致时，原投递无法确认。重新绑定不是原投递的回执，必须保留其结果不确定状态。

跨电脑设备投递区分两种身份：`managerInstanceId` 是持有原投递记录的 Manager，设备 `instanceId` 是实际设备 owner PC。准备、发送、协调及回执确认时，异步取得双方当前身份凭证，并与原 endpoint 比对；刷新只能核验原身份，不能把新会话或新 epoch 写回原记录。

来源必须仍是已加载的原 owner；目标未加载时可以排队并等待唤醒。校验顺序为来源、目标、再检查来源，防止等待目标凭证时遗漏来源失活。同步授权检查也明确区分来源与目标，不用目标排队能力放宽来源要求。

`GET /api/agent/delivery-authority` 是已鉴权连接可读取的公共接口，不要求调用方绑定目标会话。它返回原记录的 ledger 身份、来源、目标、准备参数及哈希，不返回消息正文。原连接有效性与原记录身份仍须核验。实际执行端还必须核验发送连接确属该 ledger PC，并反查原记录；读取凭证本身不构成执行许可。

原记录明确为 `cancelled` 时，此接口返回 HTTP 200、`authorized: false` 及原身份与哈希。这只是原取消事实，不要求旧来源仍加载或旧 epoch 仍可执行，也不能授权发送。设备仅在与原运输记录逐项匹配后，将该运输记录标为结果未知并继续后续队列；原业务数据保留，不能记为已接收。未知记录、代次不符或当前读取连接失效仍拒绝。

实现入口：`src/manager/agentEndpointDelivery.ts`、`src/agentRequests/endpointDelivery.ts`、`src/agentRequests/ownerExecution.ts` 与 `src/manager/deviceAgentEndpointBridge.ts`。设备接入见 [原生设备 Agent](device-agent-adapter.md)。
