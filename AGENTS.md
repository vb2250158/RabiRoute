# RabiRoute Agent Guide

RabiRoute 是一个开源的消息网关 / Policy Router 项目。协作时先把它理解成“分诊和调度层”，不要把它写成完整 Agent OS、聊天机器人框架或某个处理端的外壳。

## 项目判断

- RabiRoute 负责：消息进入、事件记录、路由判断、上下文模板、处理端投递、后续审批/回传的边界。
- 处理端负责：真正回答问题、写代码、跑流程、查系统、调用工具。
- Codex Desktop 当前只是默认验证链路，不是产品边界。

## 修改文档

- README 面向第一次看到项目的人：先讲定位，再讲快速上手，再讲配置和开发。
- ARCHITECTURE 面向想理解边界和演进的人：保留更深的分层、红线和路线图。
- `examples/roles/` 放可公开的人格示例。
- `skills/` 放项目内可复用的 Agent 指南，例如如何创建 RabiRoute 人格。

## 修改代码

- 新平台入口优先新增 `src/adapters/` 模块，不要把所有逻辑塞进 NapCat adapter。
- 路由规则、模板渲染和处理端投递的核心在 `src/forwarding.ts`。
- Gateway 管理、WebUI API 和进程启停在 `src/manager.ts`。
- 保持 router 与 target/handler 解耦，避免让某个处理端反向定义项目边界。

## 开源示例

这个仓库按开源项目维护。公开示例里使用占位值、localhost、模板变量和脱敏路径即可；不要把真实 QQ 号、群号、私聊内容、token、Cookie、本机用户名、私有路径或运行期 `data/` 内容写进仓库。

`gateways.json`、`.env`、`data/`、`dist/`、`logs/` 和 `node_modules/` 都是运行期或本地文件，默认不要提交。
