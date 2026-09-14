<!-- docs-language-switch -->
[English](dsh-browser-auth_en.md) | 简体中文
<!-- /docs-language-switch -->

# DSH Web 会话桥认证

状态：已完成受管部署与正式双向投递验收。认证本身不代表任务已接收；按下述回执分层核验。

2026-09-14 验证：认证与协议组合测试 11/11 通过，完整构建通过；Host Developer 候选 0.3.1-b51d2326b858 激活后必需能力及计划存储恢复就绪。正式线程桥完成精确读取、创建及同会话续投，返回 delivered / dsh_session_owner；接收方正式回复 DSH_AUTH_DELIVERY_OK，Manager 回复请求回读为 responded。未验证真实图片与模型切换；计划绑定写入仍取决于调用端支持强 ETag 和幂等请求头，不能把消息验收当作绑定验收。

## 唯一执行与认证路径

RabiRoute 仍只通过当前 DSH Web owner 的会话接口访问任务；不启动第二 Runtime，不修改 DSH 认证、不从凭据库取得签名密钥或自行生成 Cookie。任务模型、工具、权限、会话和执行结果仍由 DSH 拥有；计划和投递回执由 Manager 拥有。

当前 DSH Web 使用启动登录 URL 在根路径交换 Cookie。旧的无认证桥会得到 HTTP 401。仅改端口不能恢复认证或旧版 RPC 合同。

## 本机配置

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
