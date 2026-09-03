# 消息端授权与凭据合同

当消息端 `requiresAuth=true`，实现、改造和评审必须读取本页。目标是让用户从消息端卡片完成授权，同时让账号、Route、秘密凭据和 Manager 瞬时状态各自只有一个拥有者。

## 所有权

| 事实 | 唯一拥有者 | 可持久化内容 | 禁止做法 |
| --- | --- | --- | --- |
| 平台账号或连接实例 | 消息端账户库 | 系统生成的 `endpointAccountId`、类型、非敏感显示身份、`credentialId`、授权摘要 | 用 Route ID、昵称或数组位置充当账号身份 |
| token、secret、cookie、refresh token、密码 | 本机受保护凭据库 | 密文或操作系统托管秘密；业务层只取得按用途限权的读取结果 | 写入 Route JSON、公开配置、日志、URL、前端 snapshot 或错误文本 |
| 当前 Route 如何使用账号 | Route 配置 | `endpointAccountId`、启用状态、事件过滤、目标人格、外发策略 | 在每个 Route 复制账号秘密或独立刷新 token |
| 当前连接与授权挑战 | 当前 Manager generation 的授权控制器 | 内存中的连接、轮询、`authAttemptId`、挑战状态和超时 | generation 更换后继续接受旧挑战，或让 WebGUI 自己轮询平台秘密 API |
| 卡片显示状态 | Manager 返回的只读 snapshot | 非敏感账号身份、状态、下一动作、错误码、更新时间 | 根据是否填过字段推断已登录，或只显示空输入框 |

`endpointAccountId` 由系统生成并稳定保存。它标识本机消息端账户，不是平台显示名，也不是凭据本身。`credentialId` 只供授权控制器定位受保护秘密，不得成为下载路径、环境变量名或可跨接口读取秘密的能力。

## 授权能力

消息端定义声明实际支持的模式，不为了 UI 统一伪造不存在的登录方式：

```ts
type MessageAdapterAuthMode =
  | "credentials"
  | "qr_code"
  | "device_code"
  | "browser_oauth"
  | "external_dashboard"
  | "local_session";

type MessageAdapterAuthCapability = {
  requiresAuth: boolean;
  authModes: readonly MessageAdapterAuthMode[];
  credentialScope: "none" | "account" | "instance";
  canLogout: boolean;
  canRefreshAuth: boolean;
  supportsMultipleAccounts: boolean;
};
```

- `credentials`：卡片一次性收集 token/secret 等秘密并立即提交受保护凭据库；保存成功后清空表单。
- `qr_code` / `device_code`：Manager 生成有界挑战，卡片只显示二维码、用户码、过期时间和非敏感状态。
- `browser_oauth`：Manager 生成带 nonce/state 的授权 URL 并拥有回调；卡片发起浏览器流程并显示回调结果。
- `external_dashboard`：卡片打开官方管理页并持续读取可验证状态；不能因为页面可打开就报告已登录。
- `local_session`：复用受控本机登录态时必须能验证具体账号身份；“检测到进程”不等于已认证。

## 状态机

对 WebGUI 暴露离散状态，不混用 `null`、HTTP 可达或“字段非空”表示登录成功：

```ts
type MessageEndpointAuthState =
  | "not_configured"
  | "authorization_required"
  | "authorizing"
  | "challenge_required"
  | "connected"
  | "expired"
  | "failed"
  | "disabled";
```

授权 snapshot 至少包含：

```ts
type MessageEndpointAuthSnapshot = {
  endpointAccountId?: string;
  state: MessageEndpointAuthState;
  mode?: MessageAdapterAuthMode;
  accountLabel?: string;
  accountStableId?: string;
  authAttemptId?: string;
  challenge?: {
    kind: "qr_code" | "device_code" | "browser_oauth" | "external_dashboard";
    displayValue?: string;
    openUrl?: string;
    expiresAt?: string;
  };
  nextActions: readonly ("start" | "submit" | "open" | "cancel" | "refresh" | "reauthorize" | "logout")[];
  error?: { code: string; message: string; retryable: boolean };
  updatedAt: string;
  applicationGenerationId: string;
  managerInstanceId: string;
};
```

`connected` 只能来自平台身份或能力探测成功，不能来自秘密已保存、Dashboard 可达或进程存在。`expired` 保留账号身份和 Route 绑定，下一动作是重新授权；不得静默建立第二个账号。取消授权回到 `authorization_required` 或上一个稳定状态，不记录为平台失败。

## Manager API

按项目现有路由风格实现等价的 typed API：

```text
GET    /api/message/<type>/accounts
POST   /api/message/<type>/accounts
GET    /api/message/<type>/accounts/<endpointAccountId>/auth
POST   /api/message/<type>/accounts/<endpointAccountId>/auth/start
POST   /api/message/<type>/accounts/<endpointAccountId>/auth/challenge
POST   /api/message/<type>/accounts/<endpointAccountId>/auth/cancel
POST   /api/message/<type>/accounts/<endpointAccountId>/auth/refresh
DELETE /api/message/<type>/accounts/<endpointAccountId>/auth
```

路径是默认语义，不要求为迁移而机械重命名成熟 API；但以下合同必须一致：

- mutation 携带当前 `applicationGenerationId`、`managerInstanceId`、稳定幂等键和需要时的 `authAttemptId`。
- 旧 generation、旧 Manager instance、过期挑战、重复完成和账号不匹配全部失败关闭。
- secret 只允许在需要它的单次 mutation request body 中出现；服务端完成受保护存储后不回显。
- 状态、健康、日志和错误响应只返回非敏感摘要。
- 取消、刷新、退出是显式动作；超时负责释放轮询、临时回调和挑战资源。

## 卡片与插件边界

通用 Route 页面负责消息端目录、排序、展开、统一 chip、账号选择和 renderer 宿主。每种消息端通过插件/Web Bundle 贡献自己的卡片 renderer 或参数组件，负责平台特有控件和挑战表现。

```text
Route 页面
└─ MessageEndpointCardHost
   ├─ 通用账号选择与状态
   └─ type renderer
      ├─ QQ：快速/密码/二维码/新设备确认
      ├─ 微信：二维码与会话恢复
      ├─ OAuth 平台：浏览器授权与回调结果
      └─ 设备平台：实例地址、授权与设备健康
```

平台 renderer 只能调用 Manager typed API，不拥有凭据、不直接写 Route 文件、不自己决定 `connected`，也不在浏览器持久化 token。中央 Route 页面不得继续累积平台专属二维码轮询、错误解析和账号恢复逻辑。

卡片必须让用户完成：

1. 选择已有账号或创建新账号。
2. 看见依赖、授权状态与下一动作。
3. 发起并完成平台支持的授权方式。
4. 取消进行中的授权。
5. 处理过期、失败和重新授权。
6. 在平台允许时退出登录或删除本机授权。
7. 授权成功后配置当前 Route 的订阅与外发策略。

全局设置页可以提供账号总览和高级默认值，但消息端卡片不能只留一条“请到设置页/环境变量完成授权”的死路。

## 凭据与生命周期

- 优先复用项目现有的本机凭据服务；Windows 正式版应使用操作系统保护或等价的本机加密存储，并限制到当前应用/用户边界。
- 没有受保护凭据服务时，先实现该能力或将消息端保持为 `experimental` / `stub`。不得因赶进度把秘密写入普通配置、源码、示例或日志。
- 密码若只用于换取持久会话，交换完成后不保存密码；平台确实要求持续保存时，能力说明与 UI 必须明确，并仍进入受保护凭据库。
- Manager generation 更换时停止旧连接、轮询、回调和挑战；新代用持久账号和 `credentialId` 重建连接并重新验证平台身份。
- logout 先撤销或删除平台授权（平台支持时），再删除本机秘密并更新账号状态。部分失败时显示可恢复结果，不能先报告成功。
- 删除 Route 不删除共享账号；删除账号前列出引用它的 Route 并要求显式解除绑定。

## 验收

除消息收发测试外，认证消息端至少覆盖：

- 从消息端卡片开始，首次授权可完成，不要求用户手改环境变量或配置文件。
- 二维码/device code 过期、取消、重复提交和旧 `authAttemptId` 失败关闭。
- OAuth state/nonce、回调账号和 Manager generation 不匹配时拒绝完成。
- 秘密提交后不出现在 API response、Route/config、日志、诊断、错误、浏览器存储和构建产物中。
- 重启 Manager/Host 后账号身份与 Route 绑定仍在，连接重新验证；旧代挑战失效。
- token 过期进入 `expired`，重新授权复用同一个 `endpointAccountId`。
- 多 Route 显式选择同一账号时共享连接，不共享事件过滤、人格或外发策略。
- 退出登录后连接停止、秘密不可再用、Route 清楚显示授权缺失。
- 无真实账号或平台环境时保持 `experimental`，使用 fake provider 验证状态机与脱敏；不能把 mock 通过写成真实平台已验证。
