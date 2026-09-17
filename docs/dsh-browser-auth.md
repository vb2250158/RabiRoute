<!-- docs-language-switch -->
[English](dsh-browser-auth_en.md) | 简体中文
<!-- /docs-language-switch -->

# DSH Web 会话桥认证

状态：已完成受管部署与正式双向投递验收。认证本身不代表任务已接收；按下述回执分层核验。

2026-09-14 验证：认证与协议组合测试 11/11 通过，完整构建通过；Host Developer 候选 0.3.1-b51d2326b858 激活后必需能力及计划存储恢复就绪。正式线程桥完成精确读取、创建及同会话续投，返回 delivered / dsh_session_owner；接收方正式回复 DSH_AUTH_DELIVERY_OK，Manager 回复请求回读为 responded。未验证真实图片与模型切换；计划绑定写入仍取决于调用端支持强 ETag 和幂等请求头，不能把消息验收当作绑定验收。

## 唯一执行与认证路径

RabiRoute 仍只通过当前 DSH Web owner 的会话接口访问任务；不启动第二 Runtime，不修改 DSH 认证、不从凭据库取得签名密钥或自行生成 Cookie。任务模型、工具、权限、会话和执行结果仍由 DSH 拥有；计划和投递回执由 Manager 拥有。

当前 DSH Web 使用启动登录 URL 在根路径交换 Cookie。旧的无认证桥会得到 HTTP 401。仅改端口不能恢复认证或旧版 RPC 合同。

## 在 WebGUI 连接（开发中，尚未部署验收）

在本机 RabiRoute 控制台的 DSH 设置中使用“连接 DSH”：

1. 启动 DSH，复制它提供的当前登录链接。链接包含访问凭据，不要发到聊天或共享文档。
2. 粘贴到“DSH 登录链接”，点击“连接 DSH”。RabiRoute 验证登录和只读会话接口后，加密保存授权并自动填入不含凭据的地址。无需查找日志或手改 JSON。
3. 点击原有扫描按钮选择会话，再保存路线。连接或移除授权都不创建、删除或替换会话绑定。
4. 已有日志配置可点击“验证并保存现有连接”迁移；旧日志不可用时直接提供当前登录链接。

授权只保存在当前电脑的 `stateRoot/data/dsh-connections/`，不属于人格同步数据。Windows 使用当前用户 DPAPI；其他平台使用本机受限权限密钥加密。DSH 目前授予的是整个 Web owner 的访问权限，不支持仅投递或单会话 scope。移除授权只停止 RabiRoute 使用，不会撤销其他客户端的登录。

同地址、同签名配置的正常 DSH 重启可沿用未过期授权。换 hostname/端口、授权过期或 DSH 更换签名配置时重新连接；不扫描端口或自动切换到另一个实例。远端/Relay 页面不能配置本机授权，应到运行 RabiRoute 的电脑操作。跨电脑分别连接各自的 DSH，通过远端 Agent 功能协作，不共享 Cookie。

### 接口与安全边界

- `GET /api/agent-adapters/dsh/connections`：返回 `ok`、`revision`、`endpoints`，仅含干净地址、状态、时间；`saved` 不代表在线。
- `GET /api/agent-adapters/dsh/connection?baseUrl=<origin>`：返回单项元数据及全局配置 revision，不扫描会话。
- `POST /api/agent-adapters/dsh/connection`：JSON `{launchUrl, expectedRevision}`，或显式迁移 `{baseUrl, expectedRevision}`。先严格同 origin 交换，再验证只读 `session/list`；成功返回 `connection` 和新 revision。
- `DELETE /api/agent-adapters/dsh/connection`：JSON `{baseUrl, expectedRevision}`，保存断开标记，阻止旧日志配置自动恢复授权。
- 写请求仅接受本机同源浏览器：必须有匹配 Origin，拒绝 LAN、转发头、跨站与 Relay；请求体上限 16 KiB。冲突返回 409，重新读取后由用户决定是否提交，客户端不自动重放。
- 认证只接受本机回环根路径和单一 token，不跟随重定向，凭据不进入普通配置、API 响应、错误或日志。登录与验证分别有十秒超时；任务 RPC 仍保持不自动重放的边界。

2026-09-17 开发验证：认证、会话桥和界面客户端匹配测试通过；包含真实 Windows DPAPI 加密保存、同地址读取、401 不重放、移除/过期不恢复旧日志、版本冲突和 Relay/跨站拒绝。前后端类型检查及隔离完整 `npm run build` 通过，动态 Manager 合同 5/5 通过。受管候选已成功启动，并通过运行接口验证元数据读取、缺少 Origin 时拒绝写入，以及真实 DSH 旧授权迁移与加密保存。随后被另一发布版本替换，因此尚无最终稳定运行验收；真实浏览器和第二台电脑验收仍待完成，不能视为完整上线。

### 旧日志兼容的退出条件

为避免升级立即中断已有安装，仅对从未建立保护存储记录的旧端点保留现有日志认证。唯一迁移入口是 WebGUI“验证并保存现有连接”，或重新粘贴当前登录链接；一旦保存授权、过期或移除，业务 RPC 不再使用该端点的旧日志。移除后必须重新提供登录链接。配置中的所有端点完成迁移后可删除旧 `dsh-auth.json`；新安装不需要创建它。授权即时保存，不受路线表单取消影响。断开阻止尚未派发的请求，但不能撤回已经交给 DSH 的任务。

## 旧版本本机配置（兼容入口）

在 Host 的稳定 `stateRoot/data/dsh-auth.json` 配置端点和该 DSH owner 的启动日志路径。可用进程变量 `RABI_DSH_AUTH_FILE` 显式指定配置文件；不需要修改用户级环境或 DSH 启动方式。示例中的路径由运维替换为已核验的本机值：

```json
{
  "endpoints": [
    {
      "baseUrl": "http://127.0.0.1:3000",
      "launchLogPath": "/absolute/path/to/owner-stdout.log"
    }
  ]
}
```

配置不含 Token 或 Cookie，不要提交真实机器路径。日志必须来自目标 DSH 的现有启动器，包含当前进程输出的 `dsh web:` 登录 URL。此模式只支持明确的回环端点；远程认证不在本次范围。不扫描磁盘、浏览器或其它日志来寻找凭据。

桥最多读取日志尾部 256 KiB，严格选择同 origin、根路径、单一 token 的最后启动 URL。禁止跟随认证及 RPC 重定向；只接受根路径 303 和一个受支持的 HttpOnly Cookie。Cookie 仅在内存短时缓存并合并并发交换；配置路径或端点改变不复用旧缓存。错误不输出登录 URL、Cookie 或日志正文。

401 会清除对应缓存，但不自动重放该次 RPC。超时或断线的写入结果可能未知，先查原任务/投递回执，不另建或盲目重发。仅默认认证文件不存在时保留无认证请求能力，以支持无需此认证的受控目标；显式指定文件缺失或已有配置中缺少目标映射均在 RPC 前拒绝，不静默降级。缓存不超过 Cookie 的 Max-Age/Expires 或本地五分钟刷新上限，拒绝删除和过期 Cookie。

## 验证与部署

- 隔离测试覆盖同 origin 选择、无跨地址凭据发送、401 不重放、RPC 重定向不跟随、现有会话身份和工作区边界。
- 真实验证先只读会话目录：认证成功、RPC 成功与精确会话存在分别检查，不打印全量历史或凭据。
- 再用正式 Manager 会话桥读取精确 ID、验证来源身份，最后对授权目标验证投递及回复。
- 桥不在当前源码热补丁模块目录中。匹配测试和完整构建通过后生成不可变 Developer 候选，经 Host 受管整代切换；不得覆盖安装版 dist 或重启 DSH。部署前保留他人改动并核对实际候选范围。

没有真实投递回执时，接入仍为 experimental，不以单次 HTTP 200 宣称全部可用。
