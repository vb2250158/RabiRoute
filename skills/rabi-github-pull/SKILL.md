---
name: rabi-github-pull
description: 安全拉取 RabiRoute 更新，并根据项目更新日志和公开示例迁移本地运行配置。用于用户要求 pull、update、sync、upgrade、refresh RabiRoute 仓库，尤其是本地 data、gateway config、route config、persona 文件或 adapter 配置可能需要随上游更新迁移时。
---

# Rabi GitHub 拉取

## 概览

在拉取 RabiRoute 更新前后使用这个 skill。RabiRoute 的配置变更常常先落在 `版本更新日志.md`、`examples/data/` 和 adapter 文档里，而本机运行期 `data/` 目录不会自动升级；因此一次安全的拉取既包括 Git 同步，也包括本地配置迁移检查。

## 重要路径

- `版本更新日志.md`：迁移说明和行为变化的主要来源。
- `examples/data/`：公开的当前配置模板。
- `data/`：本地运行期配置和人格数据，默认是私有数据。
- `.env`：本机密钥和机器相关设置，绝不能用示例文件覆盖。
- `src/adapters/`、`src/forwarding.ts`、`src/manager.ts`：路由、adapter 和配置模型变更的常见位置。
- `docs/`：更新日志链接到的更详细迁移说明。

## 拉取流程

1. 在触碰 Git 历史前检查本地状态。
   - 运行 `git status -sb`。
   - 如果 tracked 文件有本地改动，阅读足够 diff，判断它们是用户工作还是生成文件抖动。
   - 不要覆盖本地 `data/`、`.env`、日志、构建产物或用户改动。

2. 拉取前先 fetch 并审阅上游。
   - 运行 `git fetch origin`。
   - 如果存在 upstream，用 `git log --oneline --decorate --left-right HEAD...@{u}` 查看即将进入的提交。
   - 在迁移本地配置前先看即将进入的 `版本更新日志.md` diff：

```bash
git diff HEAD..@{u} -- "\347\211\210\346\234\254\346\233\264\346\226\260\346\227\245\345\277\227.md" examples/data docs README.md
```

3. 如果存在 `data/`，先备份本地运行配置。
   - 在 tracked 文件外创建带时间戳的备份，例如 `.codex-logs/config-backups/<timestamp>/`。
   - 优先备份 `data/gateways.json`、`data/route/`、`data/roles/` 和各 adapter 的专用配置目录。
   - 最终回复里不要打印密钥、token、Cookie、真实 QQ 号、私聊内容或完整私有运行数据。

4. 保守拉取。
   - 优先使用 `git pull --ff-only`。
   - 如果不能 fast-forward，停下来检查；不要为了继续而直接创建 merge commit。
   - 如果本地 tracked 改动阻塞拉取，除非用户已经指定策略，否则先询问，不要自行 stash 或 commit。

5. 根据更新日志和示例升级本地配置。
   - 将 `examples/data/` 下相关文件与本地 `data/` 结构对比。
   - 当更新日志或代码明确要求某个字段时，把公开安全的默认值补进本地配置。
   - 保留本地 ID、密钥、endpoint、enable 状态、人设内容、消息历史和私有路径。
   - 对改名字段，保留旧值线索，并且只在目标 schema 清楚时迁移。
   - 如果不确定某个本地值是否是用户有意设置，把它列为后续确认项，不要猜。

6. 迁移后验证。
   - 配置或示例变化时运行 `npm run check:config`。
   - route、adapter、forwarding、manager 或 WebGUI 行为变化时运行针对性测试或 `npm test`。
   - TypeScript/API 变化时，在可行情况下运行 `npm run build:backend`。
   - 如果迁移期间编辑了 tracked 文件，运行 `git diff --check`。

7. 汇报结果。
   - 总结拉取到的提交，或说明当前已经是最新。
   - 列出升级、跳过或需要用户确认的本地配置文件。
   - 说明运行过的验证命令和失败项。
   - 私有运行细节只做摘要并脱敏。

## 迁移检查清单

更新日志提到配置、route kind、adapter、人格式、RibiWebGUI 或 manager 变化时，检查这些区域：

- Gateway 条目：adapter 类型、显示名、启用状态、进程命令、环境变量。
- Route 配置：route kind、匹配规则、模板变量、目标处理端、输出策略。
- Adapter 配置：NapCat、WeCom、webhook、voice 或 plugin-adapter 字段。
- Persona 配置：`personaConfig.json`、消息模板规则、growth、skills、plans、memory。
- WebGUI/manager 配置：新 API 字段、默认端口、进程监管、日志路径。
- 示例数据策略：新增公开示例不能被原样复制到私有运行文件。

## 判断规则

- 如果没有 `data/` 目录，只拉取并验证 examples；说明本机无需运行期迁移。
- 如果上游只是文档变化且不影响配置行为，不要搅动本地运行文件。
- 如果 examples 新增可选字段，除非更新日志说明字段必需，否则优先不改本地配置。
- 如果代码现在要求某个字段且 examples 给出安全默认值，在保留私有值的前提下把默认值补到本地。
- 如果迁移可能发送消息、启动进程或暴露私有数据，先停下来询问。
- 不要把本地运行期 `data/`、`.env`、日志、`dist` 或 `node_modules` 作为拉取清理的一部分提交。
