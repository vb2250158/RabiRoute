<!-- docs-language-switch -->
<div align="center">
<a href="./project-skill-distribution_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# 项目技能的分发与漂移检测

状态：**现行维护规范**。本文说明 RabiRoute 拥有的技能如何进入其它项目，以及上游改动后如何发现副本已经落后。

## 分发的是规则，不是文件

`project-skills.json` 列出 RabiRoute 负责维护、可安装到下游项目的技能。这些技能进入目标项目的 `.agents/skills/<name>/`，由该项目的 `AGENTS.md` 引用后按任务加载。

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
| [多电脑人格数据同步](persona-data-sync.md) | 人格目录数据 | 同一 RabiLink 应用下的多台电脑 |
| LAN Agent 资源目录 | RabiRoute 包内 `skills/*/SKILL.md` 与显式公开文档 | 已授权 Agent 按需只读拉取，见 [远端 Agent 接入](lan-rabi-agent-bootstrap.md) |

RabiRoute 不向项目或 Agent 端推送技能：本机 Codex / DSH / WorkBuddy 会话各自从自己的工作区技能目录加载，跨电脑只同步人格数据。
