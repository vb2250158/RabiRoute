<!-- docs-language-switch -->
<div align="center">
<a href="./project-skill-distribution_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# 项目技能的分发与漂移检测

状态：**现行维护规范**。本文说明 RabiRoute 拥有的技能如何进入其它项目，以及上游改动后如何发现副本已经落后。

## 分发的是规则，不是文件

`project-skills.json` 的 `skills` 列出 RabiRoute 负责维护、可安装到下游项目的技能。这些技能进入目标项目的 `.agents/skills/<name>/`，由该项目的 `AGENTS.md` 引用后按任务加载。

下游副本是**本地化派生版**，不是字节拷贝：

- 正文按项目语言和业务语境改写；
- 指向 RabiRoute 内部文档的相对链接替换为该项目的本地页，例如项目自己的计划 API 说明；
- 追加项目专属规则。

因此「把上游目录覆盖过去」等于删掉项目的本地化成果和专属规则。上游只拥有规则的正确性，项目拥有自己副本的内容。

## 副本的基线

最后一次完成的移植由副本目录内的 `.rabiroute-sync.json` 记录：

- `sourceFiles`：移植当时上游每个文件的 SHA-256；
- `targetFiles`：移植当时副本每个文件的 SHA-256；
- `portedAt`：移植时间。

该文件随项目自身版本控制提交，因此同一项目的每台电脑看到同一份基线。

## Agent 使用的命令

在持有 RabiRoute 源码的机器上执行，`-ProjectPath` 指向目标项目根目录：

```powershell
# 报告漂移（只读）
pwsh -NoProfile -File scripts/Test-ProjectSkillSync.ps1 -ProjectPath <项目根>

# 作为门禁：只要不是 in-sync，或副本没有被目标项目 AGENTS.md 引用，就返回非零
pwsh -NoProfile -File scripts/Test-ProjectSkillSync.ps1 -ProjectPath <项目根> -Check

# 需要在指定技能上操作时限定范围
pwsh -NoProfile -File scripts/Test-ProjectSkillSync.ps1 -ProjectPath <项目根> -Skill plan-task-orchestration -UpdateBaseline
```

标准流程：

1. 运行报告，读取每个技能的判定和逐文件差异；
2. 把上游改动移植进本地化副本，保留项目的本地修改与专属规则，不做整文件覆盖；
3. 移植完成后运行 `-UpdateBaseline` 记录新基线，再运行 `-Check` 确认 `in-sync`。

## 判定含义

| 判定 | 含义 | 处理 |
| --- | --- | --- |
| `in-sync` | 上游与副本都与基线一致 | 无需动作 |
| `source-ahead` | 上游已变，副本未动 | 移植上游改动 |
| `target-modified` | 上游未变，项目改过副本 | 保留项目改动，不动上游 |
| `both-changed` | 两侧都变 | 先读两侧再移植，不能只取一侧 |
| `baseline-missing` | 尚未记录基线 | 核对一次副本后记录基线 |
| `target-missing` | 项目没有安装该技能 | 安装它，或把它从目录清单移除 |

报告同时给出副本是否被目标项目 `AGENTS.md` 引用。已安装但没有任何加载入口的技能属于无效分发，`-Check` 会判为失败。

## 边界

- 脚本不写、不改、不删副本正文，只读两侧文件；唯一写入是 `-UpdateBaseline` 写基线文件。
- 目标路径只要出现符号链接、junction 或被文件占用，脚本直接拒绝。
- 清单之外的技能不会被写入目标项目；目标项目自行维护的技能不受影响。
- 本机制只同步 RabiRoute 拥有的项目技能。

## 与其它同步机制的分工

| 机制 | 同步对象 | 范围 |
| --- | --- | --- |
| 本文 | RabiRoute 拥有的项目技能 | 上游仓库 → 目标项目的 `.agents/skills/` |
| [RabiLink 跨电脑访问](rabilink-peer-rpc.md) | 按授权读取目标电脑数据，不同步副本 | 同一可信 RabiLink 应用内 |
| LAN Agent 资源目录 | RabiRoute 包内 `skills/*/SKILL.md` 与显式公开文档 | 已授权 Agent 按需只读拉取，见 [远端 Agent 接入](lan-rabi-agent-bootstrap.md) |

RabiRoute 不向项目或 Agent 端推送技能：本机 Codex / DSH / WorkBuddy 会话各自从自己的工作区技能目录加载，跨电脑通过 RabiLink 访问目标电脑的人格，不再同步人格数据副本。

## 用户级技能与宿主分工

同一清单的 `agentSkills` 管理通用、仓库开发、子应用及宿主专项技能：`source` 是权威目录，`audience` 是用途，`hosts` 是可用宿主，`install=false` 的子应用技能只留在应用目录。运行任务按需加载通用技能，源码开发技能按开发任务加载；人格运行数据不在此清单中。

DSH 工具映射由其增强插件的 `skills/dsh-rabi-tools` 与 `skill-catalog.json` 维护，生命周期事件由 `plugins/rabi-dsh-context` 处理。Codex 绑定由 `plugins/rabi-codex-context/skills` 维护。通用检索、计划与发送流程只在 Rabi 维护一次。

```powershell
# 只比较；共享资产仓库用 all，独立宿主目录可选 codex、dsh、workbuddy
node scripts/sync-agent-skills.mjs --target-root <真实技能源目录> --host all

# 写前备份，逐文件回读，记录源与安装内容的 SHA-256
node scripts/sync-agent-skills.mjs --target-root <真实技能源目录> --backup-root <技能目录外的备份目录> --host all --apply

# DSH 专项技能从其源码仓库投影，仍使用同一同步器
node scripts/sync-agent-skills.mjs --source-root <DSH插件源码> --catalog skill-catalog.json --target-root <真实技能源目录> --backup-root <备份目录> --host dsh --apply
```

这是显式 opt-in 的本地安装工具，默认 dry-run；不会后台推送或自动更新人格技能、已配置人格或 Agent 资产。只在用户明确授权的真实目标根运行 `--apply`。已有目录无基线或被人工修改时，脚本拒绝覆盖；先完成逐项语义比较和必要合并，再决定是否接受源投影。

**`--adopt --apply` 授权用源投影覆盖目标，并删除该技能中源投影不再包含的文件；它不是“只记录当前目标基线”，也不会把本地修改自动合回源。** 必须先保留需要的本地内容并明确接受该覆盖结果，不能按修改时间选新版本。脚本在独立外部目录保存完整备份，写失败恢复当前技能；已经成功的前序技能保留其回读记录，因此不是整批原子事务。每项 `.rabi-skill-lock.json` 记录源哈希与安装哈希。未发布源码的哈希是本机内容快照，不能当作已发布版本。

源、目标、备份根必须互不包含，所有已存在父级及内部条目均不得通过符号链接或 junction 写穿；备份也不能是源或目标的祖先。传入经 `realpath` 核对的真实路径。Mac 常见 `/tmp` 等系统别名也会被拒绝，应使用对应真实目录，并非不支持 Mac。Windows 比较按本机路径语义处理大小写和分隔符，不用字符串前缀判包含。此工具面向受信本地目录且要求没有外部并发写入；检查不构成抵御恶意并发换链的原子文件系统隔离。

跨目录 Markdown 引用在本机安装副本中解析为源仓库的实际路径，完整参考资料仍由源仓库拥有；因此安装机器必须保留该源码目录。锁文件与安装路径属于本机派生数据，不回流到公开技能。源码移动后重新运行同步器。跨机应先取得同一固定提交，再在该机器重新投影，不能直接复制含另一台机器绝对路径的安装副本。

已接入共享资产的客户端继续使用 junction；同步器要求写真实源目录，不覆盖链接。为独立客户端创建入口时按 hosts 过滤。共享扫描根可能看到其他宿主技能，因此宿主专用技能的触发说明也必须明确限制；文件可发现不表示会自动执行。

验收运行 `npm run check:skills`，再无写入重跑同步器确认全部 in-sync。最后分别核对客户端发现、按需读取和真实首轮调用；文件同步不替代模型行为验收。公开副本清理项目、人名、账号、私有路径和凭据，脚本与测试也包括在内；必要的产品标识及许可署名保持准确。