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
  return `请把这台 ${platform.title} 电脑接入以下 Rabi Manager；已有安装时先检查并复用，需要时升级或修复原节点，验证实际运行版本后删除被替代的旧程序与启动入口。

目标系统：${platform.title}。先核对实际操作系统；不符时停止，不把另一系统的命令照搬执行。
首次安装目录：${platform.directory}；已有安装以原私有配置和启动入口为准，不另建一套。启动方式：${platform.startup}。
${platform.shell}。
主机电脑的 Rabi 服务承担常驻管理职责，不依赖一个“主控 Agent”。安装时不关联当前智能体、不设置默认会话；后续调用按请求明确指定 AgentType 和完整 Id。

连接信息（仅限本次私密安装，不要写入仓库、日志、截图或命令历史）：
Manager URL: ${url.origin}
一次性接入票据（不是 WebGUI 管理 token）: ${input.token.trim()}
票据有效期：签发后 30 分钟内有效，只能成功兑换一次；成功兑换后立即失效，Manager 重启也会失效。
票据到期时间: ${input.expiresAt || "以 Manager 签发的有效期为准"}
本提示词已包含接入所需票据与完整指令，无需用户手填 WebGUI 密钥。
Release public key SHA-256: ${input.publicKeySha256}

1. 先盘点已有状态，再决定是否下载或兑换：只检查上述当前用户目录及原启动入口明确指向的位置，不全盘扫描。定位 config.json、current-release.json、rabi-agent-launcher.mjs、登录启动项和属于此配置的进程，区分磁盘版本、当前指针版本与实际运行版本。已有启动器支持时，运行 node rabi-agent-launcher.mjs --config <原配置绝对路径> --command status。私下核对 nodeId、Manager guid、原凭据、执行程序设置、workspace、允许目录和 autoUpdate，禁止输出凭据。多个配置或目标 Manager 身份不符时停止该实例的写入并报告冲突，不合并身份、不覆盖信任指纹。
2. 检查 Node.js 22.13+ 和实际 CPU 架构；缺少时从 Node.js 官方来源安装匹配版本。用已有有效 nodeCredential 下载 release；尚未接入或旧凭据被拒绝时才使用票据作为 Authorization: Bearer 下载。请求 GET ${url.origin}/api/lan-agent/releases/manifest，读取 JSON 的 release 字段。对 release.publicKey 的 SPKI DER 求 SHA-256，要求同时等于上面的固定指纹和 release.publicKeySha256；用 Ed25519 验证 JSON.stringify({version, platform, minNodeVersion, files}) 的签名（signature 是 Base64），并计算此载荷的 SHA-256 内容摘要。任何校验失败立即停止，不能因版本号相同跳过内容核验。网络超时、服务异常或 connected=false 不等于凭据失效，不因此兑换新票据。
3. 按实际状态处理：未安装才首次接入；配置有效且运行版本、内容和能力均符合当前发布时直接复用，不重装、不重复兑换票据；已安装但离线时用原启动器恢复连接；磁盘已更新而进程仍旧、内容摘要不同或缺少目标能力时升级原连接器。缺少 nodeCredential 或旧凭据被拒绝时，保留原身份并用本提示词中的有效新票据完成重新接入，--bootstrap 会自动修复原节点凭据，无需额外授权或主控 Agent 确认。恢复中的 .enrollment.json 保留供同次接入核对；兑换响应丢失时自动恢复，不要求用户到 Manager 手工核对票据。只有确需兑换且缺少有效票据时才要求重新复制提示词。明确停用的 Agent 保留停用状态，不重新接入规避停用。
4. 需要安装或升级时才下载缺失文件：仅允许 Manager 同源且位于 /api/lan-agent/releases/ 下的 downloadUrl，禁止跨源重定向和转发凭据；拒绝绝对文件路径、空路径段、. 和 ..，逐个核对 sha256 和 size。在原安装根 releases/<version>-<内容摘要> 中暂存已校验发布，不覆盖运行中的目录；已有相同内容先校验再复用，不重复下载。全部校验后在发布目录写入 release-identity.json（digest 为上述完整内容摘要，version 为发布版本）。在已校验目录运行 npm install --omit=dev --include=optional；Mac/Linux 交互终端依赖 node-pty，原生编译先检查工具，Mac 使用 Xcode Command Line Tools。不要安装完整 RabiRoute。
5. 写前将原私有配置、指针、启动器、Hook 和涉及的登录启动项完整备份到当前用户私有目录，保留可恢复旧发布；写后逐字段回读。旧会话绑定字段只保存在恢复备份中，由客户端一次迁移清除；不保留逐 Agent 授权记录。已有私有配置保留稳定 nodeId、nodeCredential、执行程序设置、workspace、允许目录、autoUpdate 和用户禁用项；仅凭据修复允许替换失效 nodeCredential。首次接入才生成唯一节点 ID，新配置保持 agents: []。仅安装电脑客户端，不要求安装或启动 Codex/DSH，不发现、不创建 Agent 会话。所有启动都明确 --config <同一私有配置绝对路径>；仅为安装子进程设置 RABI_MANAGER_URL、RABI_AGENT_BOOTSTRAP_TICKET、RABI_NODE_ID、RABI_AGENT_DEFAULT_CWD、RABI_AGENT_ALLOWED_CWDS（JSON 数组）、RABI_AGENT_RELEASE_PUBLIC_KEY_SHA256。不设置或继承 RABI_AGENT_TYPE、RABI_AGENT_CODEX_THREAD_ID 或 DSH 绑定变量，不读取或迁移旧 WebGUI token。首次目录采用当前用户已有的本地目录。
6. 支持自动更新的运行节点优先使用原程序的签名更新和 IPC 交接，不再并行启动第二个连接器；保留显式 autoUpdate=false。旧程序不支持交接时，先等已接收任务结束，再经原启动器 --stop（旧版用其已有退出入口）退出同一配置的主程序及所属子程序，确认退出后才切换。不得按进程名批量结束 Node、Unity、Codex 或 DSH。首次安装在已校验目录以隐藏、脱离终端的子进程运行 node rabi-agent.mjs --bootstrap --config <私有配置绝对路径>，它会常驻，不等待它退出。已有安装手工迁移时，停机并备份后原子更新 current-release.json 的 entrypoint、digest 到已校验发布，再以相同配置运行新 --bootstrap；只下载新版或重跑旧 bootstrap 不会替换有效的旧指针。中断后使用原配置及 .enrollment.json 恢复同次接入，不换节点、不额外申请授权。失败先确认候选退出，再恢复原指针、启动器、Hook 和启动项；凭据修复已经生效时保留有效新凭据，不恢复失效凭据。主程序统一拥有连接器和 Windows 托盘，不改 Desktop 启动配置、不接管 Desktop 端口、不启动备用 Agent Runtime。
7. 验收以实际运行结果为准：用私有 nodeCredential 请求 GET /api/lan-agent/self，核对原 nodeId、Manager guid、generation、instance 和 connected；用启动器 status、所属进程路径与当前指针核对运行版本和内容摘要，不能只看 package.json 或磁盘文件。再经现有电脑接口做与原问题相关的只读检查，例如读取已存在文件的元数据或少量字节；不要重新上传已有文件来证明能力。connected=false 先查连接原因，不删除节点。票据不能列出所有节点或调用管理 API。接口或目标资源不可用时报告具体缺口，不伪造验证结果、不盲目重装。
8. 新版连接和目标能力验证通过后，先说明具体删除范围，再删除本实例被替代的旧连接器发布、重复启动脚本及失效登录启动项，复查只剩一个有效启动入口、一个主程序 owner；不保留可再次启动旧连接器的活跃入口。删除前核对绝对路径在本实例安装根内、无运行进程和当前指针/Hook/启动项引用、不属于其它配置；不跟随符号链接或目录联接，不删除整个安装根。config.json、.enrollment.json、有效凭据、任务、日志、工作目录、已上传文件和私有恢复备份均保留。恢复备份不注册为启动入口。验证失败不清旧版；归属不明只停止该项删除并报告，继续其它已确认步骤。
9. 回报采用了首次安装、复用、恢复、升级或凭据修复哪一分支，给出脱敏节点身份、实际运行版本/摘要、连接与能力验证、旧入口清理结果和剩余问题。回到原任务，复用已有构建产物、上传文件及回执，不因修复连接器重复构建、上传或投递。

接入后的接口使用：电脑上线后即可使用它实际提供的电脑接口。普通已鉴权 Agent 同样可以查询计划、近期与沉淀记忆、Skill 及公开合同，不要求它是主控 Agent，不另开逐项许可；数据由各自 Rabi 服务唯一持有。Agent 调用统一用稳定入口 node rabi-agent-launcher.mjs --config <私有配置绝对路径> --api METHOD /relative-path --agent-type <实际 AgentType> --id <当前完整会话 Id>，不在命令行放凭据。电脑凭据直接认证连接，不登记或绑定 Agent/会话，不使用 default 回退。每次都明确传入实际类型和完整 Id；可查询 Agent 类型目录和会话列表。先查 /api/agent/help、/api/lan-agent/capabilities 和 /api/lan-agent/resources，按真实 roleId 查询 /api/roles/<roleId>/knowledge/search、/plans、/memory 与 /skills；按目录读取 docs/rabi-agent-interfaces.md、docs/plan-and-memory-model.md、docs/agent-context-injection.md 及适用 Skill/references，不猜路径。--api 写请求通过 --body-stdin 传 JSON，按合同提供 --if-match <强ETag> 与 --idempotency-key <稳定键>。CLI 核对当前 Manager 身份；地址或 generation 变化后重新发现并核对 /meta，不扫描端口。超时、503、uncertain 先权威读回，不自动重放；412 刷新版本再确认。正式外发取得 Manager 与渠道回执后才报告已发送。`;
}
