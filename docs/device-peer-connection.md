<!-- docs-language-switch -->
English: [device-peer-connection_en.md](device-peer-connection_en.md) | 简体中文
<!-- /docs-language-switch -->

# 手机代眼镜建立连接

本文面向接入开发者。手机可持有独立眼镜密钥，代眼镜使用通用 LAN → P2P → Relay 隧道。手机自身的应用连接仍使用手机身份；它不能通过正文或请求头声明眼镜身份。此合同的源码测试不等于实际手机、眼镜和平台已验收。

## 连接能力与验证范围

手机 `/session` 配对入口和已有租约继续可用；连接成功后沿用已有认证，不另加逐接口或逐功能许可，也不自动清除租约。只有用户在 WebGUI 或配置中明确禁用的能力才受限制。源码夹具已覆盖配对后的 HTTP、SSE、WebSocket 与续租，但不代表 QuickJS 平台能力或物理设备已经验收。手机 HTTP 正文累计最多 12 MiB，读取期限 60 秒，用于限制单次请求资源占用，不是功能权限。

## 授予与续租

使用眼镜设备凭据，通过 Relay 的通用 `POST /api/rabilink/device/api` 请求目标 PC 的 `POST /api/rabilink/peer/device-bootstrap`。Relay 只验证连接凭据和中转原始 HTTP；它不解析这个 PC 接口，也不保存角色或额外公钥授权库。

PC 接受的正文为 `{source,publicKey,target,expiresAt,nonce,signature}`。`source` 必须等于真实 Relay 设备身份，`target` 必须是接收请求的 PC。签名域为 `rabi-device-delegation-v1`，字段按 `source,publicKey,target,expiresAt,nonce` 顺序编码；签名与实际密钥持有证明由 PC 隧道运行时验证。

Relay 在首次鉴权接纳时记录 `authenticatedAt`，原队列、认领和重试沿用这个时间。PC 的内部 MAC 同时保护该时间、来源、作用域、应用代次、方法和实际路径。授权入口要求真实 `relay` 来源与原设备凭据身份；手机的普通 `peer` 来源、应用身份和裸代理请求头均不能授予眼镜身份。

`expiresAt` 是绝对时间，必须尚未到期且不超过原 `authenticatedAt + 45000`。排队晚到、相同操作重试或新签发本机 MAC 都不能延长这个期限。到期后必须再次使用实际眼镜设备凭据续租，不能只靠私钥签名自续租。

## 隧道身份与失效

手机使用独立眼镜 ID 和密钥完成实际加密握手。PC 只在当前设备授权、公钥持有证明、作用域和期限全部有效时承认该来源。手机可沿用应用的 Relay room 连接凭据；room 连接成功不等于获得眼镜身份。

手机本机 HTTP facade 只负责传输：保留原方法、路径和 query，支持固定长度或 chunked 上传、分段响应和二进制内容。WebSocket 转发实际目标的 `101` 与原始双向帧，不在手机生成第二次握手，也不在目标接受前向眼镜宣称升级成功。身份和目标选择由连接拥有者检查；facade 没有逐业务接口表。实际 socket、流和 WebSocket 夹具与手机安装、平台调用仍分别记录。

普通应用 bootstrap 不得注册保留的 `glasses-*` 设备身份，也不得覆盖设备授权或在设备授权失效后回退为普通应用授权。设备授权到期、应用切代或运行时停止时，在途读取、流传输和状态写入都重新核验原授权。PC 重启不能复活旧设备租约。

设备凭据撤销后，后续授予或续租失败；已授予的离线租约受原绝对期限限制。不能声称断网时能即时获知服务器刚发生的撤销。正式消息认领仍要求眼镜原会话和 owner epoch；连接授权不代替业务回执。

角色和工作区绑定不限定公共 API 范围。绑定只选择上下文和自动投递目标，详见 [连接与接口使用](connection-access.md) 和 [精确投递](agent-endpoint-delivery.md)。
