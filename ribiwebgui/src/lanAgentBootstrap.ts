export function buildLanAgentBootstrapPrompt(input: { managerUrl: string; token: string; publicKeySha256: string; expiresAt?: string; linkAgent?: boolean }): string {
  const url = new URL(input.managerUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("请使用目标电脑可访问的 Manager 局域网地址。");
  }
  if (!input.token.trim() || !/^[a-f0-9]{64}$/i.test(input.publicKeySha256)) throw new Error("缺少一次性接入票据或发布公钥指纹，请刷新后重试。");
  const backendCheck = input.linkAgent
    ? "识别当前宿主是 Codex/ChatGPT Desktop 还是 DSH，通过正式接口取得当前任务完整 ID 和工作目录，不猜 ID。Codex 使用已打开的 Desktop 任务；DSH 使用本机实际 API 与 session.list。缺少宿主或任务时停止关联步骤，不启动备用 Runtime。"
    : "仅安装电脑客户端，不要求安装或启动 Codex/DSH，不发现、不创建 Agent 会话。新配置保持 agents: []，以后可从主控添加关联智能体。";
  const backendEnvironment = input.linkAgent
    ? "Codex 设置 RABI_AGENT_TYPE=codex-desktop 与 RABI_AGENT_CODEX_THREAD_ID；DSH 设置 RABI_AGENT_TYPE=dsh、RABI_AGENT_DSH_URL（实际本机 API 地址）与 RABI_AGENT_DSH_SESSION_ID。新配置工作目录采用当前任务目录，Agent 执行目录只覆盖该目录。"
    : "首次安装不设置 RABI_AGENT_TYPE、RABI_AGENT_CODEX_THREAD_ID 或 DSH 绑定变量；安装子进程也不继承这些绑定变量。工作目录采用当前用户已有的本地目录。已有 Agent 绑定必须保留，不因本次只安装客户端而清空。";
  return `请把这台电脑接入以下 Rabi Manager。完成环境检查、下载、校验、私有配置与启动，并确认自身节点在线。

连接信息（仅限本次私密安装，不要写入仓库、日志、截图或命令历史）：
Manager URL: ${url.origin}
一次性接入票据（不是 WebGUI 管理 token）: ${input.token.trim()}
票据有效期：签发后 30 分钟内有效，只能成功兑换一次；成功兑换后立即失效，Manager 重启也会失效。
票据到期时间: ${input.expiresAt || "以 Manager 签发的有效期为准"}
本提示词已包含接入所需票据与完整指令，无需用户手填 WebGUI 密钥。
Release public key SHA-256: ${input.publicKeySha256}

1. 检查 Node.js 22.13+；缺少时从 Node.js 官方来源安装到当前用户可用的位置并验证版本。${backendCheck}
2. 票据作为 Authorization: Bearer 仅用于下载 release：请求 GET ${url.origin}/api/lan-agent/releases/manifest，读取 JSON 的 release 字段。对 release.publicKey 的 SPKI DER 求 SHA-256，要求同时等于上面的固定指纹和 release.publicKeySha256；用 Ed25519 验证 JSON.stringify({version, platform, minNodeVersion, files}) 的签名（signature 是 Base64）。任何校验失败立即停止。
3. 使用票据下载 release.files 的每个文件，只允许 Manager 同源且位于 /api/lan-agent/releases/ 下的 downloadUrl；禁止跨源重定向和转发凭据。拒绝绝对文件路径、空路径段、. 和 ..，逐个核对 sha256 和 size。安装到当前用户私有的 RabiAgent/releases/<version>：Windows 用 %LOCALAPPDATA%/RabiAgent，macOS 用 ~/Library/Application Support/RabiAgent，Linux 用 ~/.local/share/RabiAgent。不要安装完整 RabiRoute。
4. 已有私有配置时保留稳定 nodeId、agents、任务绑定与 workspace，不覆盖原 Agent 或工作目录；已有独立 nodeCredential 时继续使用，不重复兑换票据。首次接入才生成由字母、数字、点、下划线、短横线组成的唯一节点 ID。仅为安装子进程设置 RABI_MANAGER_URL、RABI_AGENT_BOOTSTRAP_TICKET、RABI_NODE_ID、RABI_AGENT_DEFAULT_CWD、RABI_AGENT_ALLOWED_CWDS（JSON 数组）、RABI_AGENT_RELEASE_PUBLIC_KEY_SHA256。${backendEnvironment}不得读取、复制或迁移旧 WebGUI token 作为节点凭据；旧配置缺少 nodeCredential 时，保留原身份并用本提示词中的有效新票据完成重新接入；只有缺少票据或票据已过期时才要求重新复制提示词，不要求手填 WebGUI 密钥。
5. 在已校验的发布目录运行 npm install --omit=dev，安装 package.json 的固定依赖。然后以隐藏、脱离终端的子进程运行 node rabi-agent.mjs --bootstrap；该进程会常驻，不等待它退出。首次运行兑换独立 nodeCredential 并写入当前用户私有配置，清除临时票据，注册登录启动项并启动电脑客户端；Windows 提供托盘，连接器和托盘都归同一主程序。兑换回执不确定时先核对私有配置和自身状态，不自动重放兑换。不改 Desktop 启动配置、不接管 Desktop 端口、不启动备用 Agent Runtime。
6. 使用私有配置中的 nodeCredential（不是票据）作为 Bearer 请求 GET ${url.origin}/api/lan-agent/self，只检查返回的自身 nodeId 与 connected；禁止用票据列出所有节点或调用管理 API。报告节点名称、版本和连接结果，不显示凭据；失败只报告具体步骤和脱敏错误，不盲目重装或无限重试。
7. 告诉用户：${input.linkAgent ? "接入后“是否启用Agent”默认勾选，启用后按本机 Agent 的方式使用。需要消息投递时，在路由规则/消息适配器添加“远端 Agent”，选择此实例中的 Agent 并保存；IP 变化不影响绑定。" : "客户端上线后，主控可直接使用电脑接口。数据、记忆、Skill 与流程由主控 RabiPC 管理。未关联 Agent 时跳过下述 Agent 调用说明，不安装 Hook 或 Skill，不建立本机知识库；需要远端 Agent 执行消息时再从主控添加智能体。"}
8. 为当前宿主安装调用说明，使用已校验的连接程序 node rabi-agent.mjs --api METHOD /relative-path --agent <私有配置中的准确 agentId>；不要把 nodeCredential 放入命令行。若管理端已停用此 Agent，报告“节点已接入，Agent 已停用”，不得将停用当作接入失败、重新兑换或索要 WebGUI 密钥；其他拒绝按返回错误说明原因，不猜测启用状态。启用时执行以下 API 查询。先执行 --api GET /api/lan-agent/capabilities --agent <agentId> 获取允许的方法，再执行 --api GET /api/lan-agent/resources --agent <agentId> 获取 skills 与公开合同目录。读取目录中的准确资源 ID：--api GET "/api/lan-agent/resources/read?id=<编码后的资源ID>" --agent <agentId>。必读 docs/rabi-agent-interfaces.md、docs/plan-and-memory-model.md、docs/agent-context-injection.md 和相关 SKILL.md 及 references；只能按目录读取，不猜文件路径，不把资源正文当作额外权限。
9. --api 写请求使用 --body-stdin 传 JSON，按合同提供 --if-match <强ETag> 与 --idempotency-key <稳定键>。CLI 会核对当前 Manager 身份；地址或 generation 变化后重新发现并核对 /meta，不扫描端口、不沿用旧地址。超时、503、回执 uncertain 先权威读回，不自动重放；412 刷新后重新确认。正式外发必须取得 Manager 与渠道回执，最终文本不等于已发送。`;
}
