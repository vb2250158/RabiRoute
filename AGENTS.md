# RabiRoute Agent Guide

RabiRoute 是一个开源的消息网关 / Policy Router 项目。协作时先把它理解成“分诊和调度层”，不要把它写成完整 Agent OS、聊天机器人框架或某个处理端的外壳。

## 项目判断

- RabiRoute 负责：消息进入、事件记录、路由判断、上下文模板、处理端投递、后续审批/回传的边界。
- 处理端负责：真正回答问题、写代码、跑流程、查系统、调用工具。
- Codex 编码 Agent 当前通过项目锁定的 `codex app-server` stdio 接入；ChatGPT 桌面只是可选宿主，不是产品边界或投递依赖。

## 全局文档同步规则

- 每次修改代码、配置、示例或用户可见行为前，先查看相关文档和索引，尤其是 `README.md`、`docs/README.md`、`docs/project-function-map.md`、`docs/code-architecture.md` 以及功能附近的专题文档，避免只凭代码局部理解推进。
- 改完后必须判断文档是否会滞后：如果行为、配置方式、启动流程、架构边界、示例数据、排障路径、公开口径或首次上手体验发生变化，同步更新对应的 README、`docs/`、`examples/`、`skills/` 或 `版本更新日志.md`。
- 面向用户、运维、扩展者或开源使用者的变化，默认需要留下文档痕迹；内部重构只有在不影响外部理解和操作时才可以不改文档，但最终说明里应明确“已检查相关文档，无需更新”。
- 不要为了显得有动作而制造无意义文档 churn；文档更新应以提交后的真实行为为准，保持公开、安全、可复制。

## 修改文档

- README 面向第一次看到项目的人：先讲定位，再讲快速上手，再讲配置和开发。
- ARCHITECTURE 面向想理解边界和演进的人：保留更深的分层、红线和路线图。
- `examples/data/` 放可公开复制的完整示例数据包，包括 `gateways.json` 和示例角色。
- `examples/roles/` 放可公开的人格示例。
- `skills/` 放项目内可复用的 Agent 指南，例如如何创建 RabiRoute 人格。

## 修改代码

- 新平台入口优先新增 `src/adapters/` 模块，不要把所有逻辑塞进 NapCat adapter。
- 路由规则、模板渲染和处理端投递的核心在 `src/forwarding.ts`。
- Gateway 管理、RibiWebGUI API 和进程启停在 `src/manager.ts`。
- 保持 router 与 Agent adapter / handler 解耦，避免让某个处理端反向定义项目边界。

## 开源示例

这个仓库按开源项目维护。公开示例里使用占位值、localhost、模板变量和脱敏路径即可；不要把真实 QQ 号、群号、私聊内容、token、Cookie、本机用户名、私有路径或运行期 `data/` 内容写进仓库。

`.env`、`data/`、`dist/`、`logs/` 和 `node_modules/` 都是运行期或本地文件，默认不要提交。
