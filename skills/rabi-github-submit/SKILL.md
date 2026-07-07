---
name: rabi-github-submit
description: 为 RabiRoute 的 GitHub 提交做提交前准备，并按本次提交的真实进展维护项目上下文。用于用户要求 submit、commit、push、publish 或准备 RabiRoute GitHub 改动，尤其是需要根据当前提交更新版本日志、本地 Rabi 人格数据或公开示例 Rabi 人格时。
---

# Rabi GitHub 提交

## 概览

在 stage、commit、push 或创建 PR 之前，使用这个 skill 作为 RabiRoute 专用提交检查清单。它在常规 GitHub 流程之上增加一条项目规则：当前提交完成的具体进展不仅要反映在更新日志里，必要时也要同步到 Rabi 的本地运行期人格，以及脱敏后的公开示例人格。

## 必要上下文

从 RabiRoute 仓库根目录工作。本机通常是 `C:\Data\CottonProject\RabiRoute`；在 WSL 中使用对应的 `/mnt/c/Data/CottonProject/RabiRoute`。

重要路径：

- `版本更新日志.md`：公开项目更新日志。
- `data/roles/Rabi/`：本地运行期 Rabi 人格，默认私有，通常不提交。
- `examples/data/roles/Rabi/`：公开示例 Rabi 人格，脱敏后可以提交。
- `examples/data/roles/Rabi/plans/` 和 `data/roles/Rabi/plans/`：Rabi 的项目计划。
- `examples/data/roles/Rabi/memory/` 和 `data/roles/Rabi/memory/`：近期记忆和沉淀记忆。
- `examples/data/roles/Rabi/README.md` 及下级 README：面向人的示例人格说明。

## 工作流程

1. 写提交说明或编辑 Rabi 上下文前，先检查当前变更集。
   - 运行 `git status --short` 并审阅改动文件。
   - 阅读相关 diff、文档或代码路径，直到足以理解本次项目实际进展。
   - 以待提交 diff 为事实来源；不要只凭文件名、旧计划或泛泛的项目方向推断进展。

2. 当改动面向用户、涉及架构、值得发布或对运维重要时，更新项目日志。
   - 优先在 `版本更新日志.md` 写简洁条目。
   - 说明行为变化、迁移注意事项和未来维护者会关心的验证结果。

3. 检查本地 Rabi 是否存在，并且只按本次提交的进展更新它。
   - 如果 `data/roles/Rabi/` 存在，把它视为 Rabi 当前私有项目上下文的运行期来源。
   - 当本次提交改变 RabiRoute 的方向、边界、adapter 模型、route kind、WebGUI 行为、人格生命周期、排障知识或示例数据策略时，更新其 `plans/`、`memory/` 和 README 类文档。
   - 把 active/in-progress 计划也纳入检查：本次提交可能完成一个切片、改变下一步、增加证据，或让某个计划描述过期，即使整个计划尚未完成。
   - 如果 active/in-progress 计划和记忆已经准确描述提交后的状态，就保持不变，并在最终说明中提到已检查。
   - 记录本次提交完成、改变或新揭示的内容；避免做无关 backlog 整理。
   - 不要把本地运行密钥、真实 ID、私聊内容、日志或 token 写进可提交文件。

4. 按本次提交更新公开示例 Rabi 人格。
   - 提交前始终检查 `examples/data/roles/Rabi/`。
   - 当本地 Rabi 中有持久且公开安全的项目知识，且它能帮助新用户理解本次提交变化时，将其改写进公开示例人格。
   - 更新 example `plans/`，反映本次提交影响到的 completed、active、in-progress 或新发现工作。
   - 更新 example `memory/recent/` 或 `memory/consolidated/`，写入应随开源示例发布的脱敏项目经验。
   - 当目录意义、工作流或项目叙事会过期时，更新 `examples/data/roles/Rabi/README.md`、`plans/README.md` 或 `memory/README.md`。
   - 如果公开示例人格对本次提交已经是最新，不要为了显示动作而制造 churn。

5. stage 前检查公开示例数据脱敏。
   - 公开示例文件可以使用 localhost、占位符、模板变量、虚构样例内容和项目通用细节。
   - 不要提交真实 QQ 号、群号、私聊、token、Cookie、本机用户名、私有路径或运行期 `data/` 内容。
   - 如果本地 Rabi 数据里有有用经验，应改写成公开安全的示例，而不是直接复制。

6. 验证完整提交。
   - 根据改动文件运行仓库常规测试、类型检查、build 或针对性验证。
   - 重新运行 `git diff --check`。
   - 如果修改了示例人格，检查 `git diff -- examples/data/roles/Rabi`。
   - 检查 `git status --short`，只 stage 有意提交的公开文件。

7. 使用正常 GitHub 流程提交。
   - 根据实际改动和验证结果编写 commit/PR 摘要。
   - 如果本次提交包含 Rabi 人格或公开示例更新，在说明里提到。
   - 如果更新了本地 `data/roles/Rabi/` 但没有提交，最终交接里要明确说明。
   - 在这台机器上，如果本地 commit 创建后，CLI `git push` 多次因 GitHub 网络、代理、TLS 或凭证超时失败，可以用 GitHub Desktop 作为推送 fallback。不要用 GitHub Desktop 改提交内容；只发布已经审阅过的本地 commit，然后重新检查 `git status -sb`。

## Rabi 上下文应该更新什么

凭判断行动，不要机械修改每个文件。只有当前提交教会了 Rabi 某种持久知识时才更新上下文。

- Plans：检查 active 和 in-progress 工作，必要时移动 active/archive 状态、调整状态、增加新发现的后续计划，或根据实现修订计划描述。
- Memory：为新经验添加小型近期记忆；只有经验稳定且广泛有用时才沉淀。
- README：当示例结构、项目叙事、设置预期或公开说明会过期时更新。
- Persona prompts 或 skills：只有 Rabi 的行为、边界或能力发生变化时才更新。

## 判断规则

- 如果改动只是内部 typo 或机械格式调整，更新日志和 Rabi 人格可能无需修改。
- 如果改动影响用户理解、配置、调试、扩展或安全发布 RabiRoute，应更新日志，并至少检查本地和公开示例两个 Rabi 人格位置。
- 如果某个计划仍在进行中，也要检查本次提交是否改变它的状态、证据、风险、下一步或措辞；如果已经准确，就保持不变。
- 如果本地 Rabi 和公开示例 Rabi 有差异，保留 `data/roles/Rabi/` 的私有/本地具体性，只把安全且持久的经验转换进 `examples/data/roles/Rabi/`。
- 如果 `data/roles/Rabi/` 不存在，继续处理公开示例人格，并说明本地运行期 Rabi 目录不存在。
- 除非用户明确要求且文件确认安全，否则绝不 stage 运行期 `data/`、日志、`.env`、`dist` 或 `node_modules`。

## 常用命令

```bash
git status --short
git diff --stat
git diff --check
rg -n "Rabi|persona|memory|plans|route kind|adapter|WebGUI|update log" README.md docs src examples/data/roles/Rabi
```

在 Windows PowerShell 读取或写入中文 Markdown 时，优先显式指定 UTF-8：

```powershell
Get-Content -LiteralPath '.\版本更新日志.md' -Encoding UTF8
Get-Content -LiteralPath '.\examples\data\roles\Rabi\README.md' -Encoding UTF8
```
