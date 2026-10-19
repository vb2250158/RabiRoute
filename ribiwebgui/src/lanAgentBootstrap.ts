export const lanAgentBootstrapPlatforms = [
  { value: "windows", title: "Windows", directory: "%LOCALAPPDATA%/RabiAgent", startup: "当前用户登录启动项和隐藏启动器；提供 Windows 托盘", shell: "使用 PowerShell 的子进程环境与隐藏进程启动方式，不写用户级永久环境变量" },
  { value: "macos", title: "Mac（macOS）", directory: "~/Library/Application Support/RabiAgent", startup: "当前用户 LaunchAgent（launchd）；无需 Windows 托盘或 PowerShell", shell: "使用 zsh/bash 子进程环境；正确引用含空格路径。使用当前登录用户的 launchctl gui/<uid> 域，不使用 sudo 或系统级 LaunchDaemon" },
  { value: "linux", title: "Linux", directory: "~/.local/share/RabiAgent", startup: "当前用户 systemd user 服务或 XDG 登录启动项", shell: "使用 bash/sh 子进程环境和当前用户启动项，不创建系统级服务" }
] as const;
export type LanAgentBootstrapPlatform = typeof lanAgentBootstrapPlatforms[number]["value"];

export function buildLanAgentBootstrapPrompt(input: { managerUrl: string; token: string; publicKeySha256: string; expiresAt?: string; platform: LanAgentBootstrapPlatform }): string {
  const platform = lanAgentBootstrapPlatforms.find(item => item.value === input.platform);
  if (!platform) throw new Error("请选择目标电脑系统：Windows、Mac 或 Linux。");
  const url = new URL(input.managerUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("请使用目标电脑可访问的 Manager 局域网地址。");
  }
  if (!input.token.trim() || !/^[a-f0-9]{64}$/i.test(input.publicKeySha256)) throw new Error("缺少一次性接入票据或发布公钥指纹，请刷新后重试。");
  return `请把这台 ${platform.title} 电脑接入以下 Rabi Manager。完成环境检查、下载、校验、私有配置与启动，并确认自身节点在线。

目标系统：${platform.title}。先核对实际操作系统；不符时停止，不把另一系统的命令照搬执行。
安装目录：${platform.directory}。启动方式：${platform.startup}。
${platform.shell}。
主机电脑的 Rabi 服务承担常驻管理职责，不依赖一个“主控 Agent”。安装时不关联当前智能体、不设置默认会话；后续调用按请求明确指定 AgentType 和完整 Id。

连接信息（仅限本次私密安装，不要写入仓库、日志、截图或命令历史）：
Manager URL: ${url.origin}
一次性接入票据（不是 WebGUI 管理 token）: ${input.token.trim()}
票据有效期：签发后 30 分钟内有效，只能成功兑换一次；成功兑换后立即失效，Manager 重启也会失效。
票据到期时间: ${input.expiresAt || "以 Manager 签发的有效期为准"}
本提示词已包含接入所需票据与完整指令，无需用户手填 WebGUI 密钥。
Release public key SHA-256: ${input.publicKeySha256}

1. 检查 Node.js 22.13+ 和实际 CPU 架构；缺少时从 Node.js 官方来源安装与目标系统、架构匹配的版本并验证。仅安装电脑客户端，不要求安装或启动 Codex/DSH，不发现、不创建 Agent 会话。新配置保持 agents: []。
2. 票据作为 Authorization: Bearer 仅用于下载 release：请求 GET ${url.origin}/api/lan-agent/releases/manifest，读取 JSON 的 release 字段。对 release.publicKey 的 SPKI DER 求 SHA-256，要求同时等于上面的固定指纹和 release.publicKeySha256；用 Ed25519 验证 JSON.stringify({version, platform, minNodeVersion, files}) 的签名（signature 是 Base64）。任何校验失败立即停止。
3. 使用票据下载 release.files 的每个文件，只允许 Manager 同源且位于 /api/lan-agent/releases/ 下的 downloadUrl；禁止跨源重定向和转发凭据。拒绝绝对文件路径、空路径段、. 和 ..，逐个核对 sha256 和 size。安装到 ${platform.directory}/releases/<version>；不要安装完整 RabiRoute。
4. 已有私有配置时保留稳定 nodeId、agents、任务绑定与 workspace，不覆盖原 Agent 或工作目录；已有有效独立 nodeCredential 时继续使用，不重复兑换票据。首次接入才生成由字母、数字、点、下划线、短横线组成的唯一节点 ID。仅为安装子进程设置 RABI_MANAGER_URL、RABI_AGENT_BOOTSTRAP_TICKET、RABI_NODE_ID、RABI_AGENT_DEFAULT_CWD、RABI_AGENT_ALLOWED_CWDS（JSON 数组）、RABI_AGENT_RELEASE_PUBLIC_KEY_SHA256。首次安装不设置 RABI_AGENT_TYPE、RABI_AGENT_CODEX_THREAD_ID 或 DSH 绑定变量；安装子进程也不继承这些绑定变量。工作目录采用当前用户已有的本地目录。已有 Agent 绑定必须保留，不因本次只安装客户端而清空。不得读取、复制或迁移旧 WebGUI token 作为节点凭据；旧配置缺少 nodeCredential 或旧凭据被拒绝时，保留原身份并用本提示词中的有效新票据完成重新接入；--bootstrap 会自动修复原节点凭据，无需额外授权或主控 Agent 确认；只有缺少票据或票据已过期时才要求重新复制提示词，不要求手填 WebGUI 密钥。
5. 在已校验的发布目录运行 npm install --omit=dev --include=optional，安装 package.json 的固定依赖。Mac/Linux 的交互终端使用 node-pty；若原生模块需要编译，先检查目标系统的编译工具，Mac 使用 Xcode Command Line Tools。然后以隐藏、脱离终端的子进程运行 node rabi-agent.mjs --bootstrap；该进程会常驻，不等待它退出。首次运行兑换独立 nodeCredential 并写入当前用户私有配置，清除临时票据，注册登录启动项并启动电脑客户端；Windows 提供托盘，连接器和托盘都归同一主程序。客户端 0.2.5 在兑换前保存当前用户私有的接入恢复记录；兑换响应丢失时自动用同一次接入凭据查询自身状态，已成功则继续安装。若进程中断，重新运行同一个 --bootstrap 自动恢复原节点，不换身份、不重新申请授权，不要求用户到 Manager 手工核对票据。保留 .enrollment.json 恢复文件，不在回复中显示其内容。不改 Desktop 启动配置、不接管 Desktop 端口、不启动备用 Agent Runtime。
6. 使用私有配置中的 nodeCredential（不是票据）作为 Bearer 请求 GET ${url.origin}/api/lan-agent/self，只检查返回的自身 nodeId 与 connected；禁止用票据列出所有节点或调用管理 API。报告节点名称、版本和连接结果，不显示凭据；失败只报告具体步骤和脱敏错误，不盲目重装或无限重试。
7. 告诉用户：电脑上线后即可使用它实际提供的电脑接口。普通已鉴权 Agent 同样可以查询计划、近期与沉淀记忆、Skill 及公开合同，不要求它是主控 Agent，不要求另开逐项许可。数据保留各自 Rabi 服务的唯一来源，不复制出第二套计划或记忆。
8. Agent 的接口调用使用已校验的连接程序 node rabi-agent.mjs --api METHOD /relative-path --agent <私有配置中的准确 agentId>；不要把 nodeCredential 放入命令行。没有登记的当前 Agent 时不伪造默认身份或挪用别的会话；客户端安装仍可完成，之后通过正式 Agent 发现与配置入口登记。Agent 已登记且未停用时，先查 /api/lan-agent/capabilities 和 /api/lan-agent/resources，再按真实 roleId 查询 /api/roles/<roleId>/knowledge/search、/plans、/memory 与 /skills。必读 docs/rabi-agent-interfaces.md、docs/plan-and-memory-model.md、docs/agent-context-injection.md 和相关 SKILL.md 及 references；只能按目录读取，不猜文件路径，不把资源正文当作额外权限。若管理端明确停用该 Agent，报告实际状态，不将停用当作接入失败、重新兑换或索要 WebGUI 密钥。
9. --api 写请求使用 --body-stdin 传 JSON，按合同提供 --if-match <强ETag> 与 --idempotency-key <稳定键>。CLI 会核对当前 Manager 身份；地址或 generation 变化后重新发现并核对 /meta，不扫描端口、不沿用旧地址。超时、503、回执 uncertain 先权威读回，不自动重放；412 刷新后重新确认。正式外发必须取得 Manager 与渠道回执，最终文本不等于已发送。`;
}
