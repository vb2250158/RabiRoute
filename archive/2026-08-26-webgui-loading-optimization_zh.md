# WebGUI 加载优化记录

[English](2026-08-26-webgui-loading-optimization.md) | 简体中文

**状态：** 已完成
**范围：** RibiWebGUI 启动，以及直达 `#/routes/XinghaiBuilder-main/knowledge`。

## 已观察到的问题

该页面曾长时间空白，Lighthouse 记录 LCP 为 162.49 秒、DOMContentLoaded 为 45.89 秒；失败链路还出现了 12 秒异步组件超时。

知识页本身已经按计划和记忆分页、分窗口渲染。阻塞发生在它之前：

1. `main.ts` 在 Vue 挂载前等待插件目录和全部活跃 Web Bundle。
2. `gatewayStore.load()` 把完整 Gateway 配置、元数据和网络选项放进知识页的首轮数据链。
3. Manager 可能被大消息处理看板持久化和计划目录刷新占用。
4. 当前每个计划目录各自注册 watcher；Manager 变慢时，前端性能上报还会重叠请求。

## 设计约束

- Manager 仍是 Route 配置、插件目录、人格绑定、计划数据和运行时状态的唯一真源。
- WebGUI 壳、路由加载态和路由错误恢复不能依赖全部可选 Web Bundle 都激活成功。
- 页面代码保持按需加载；后台插件刷新不能延迟当前 Route。
- 外部投递及其他不可逆副作用继续使用现有确认和 Outbox 语义。
- 已有知识页渐进分页和渲染窗口机制必须保留。

## 已实施的修改

1. `main.ts` 完成 LAN 地址规范化后立即挂载 WebGUI 壳，再在后台刷新插件目录和可选 Web Bundle。
2. `builtinStartupPages.ts` 在插件目录可用前注册 `route.knowledge`。Manager Base Bundle 不再重复注册该 Route；目录仍在读取或不可用时，Router 不会把这个内置页面跳转到恢复页。
3. `gatewayStore.loadRouteSummaries()` 从 `/gateways?summary=1` 只投影 Route 身份、配置名、人格 ID 和运行标记。知识页优先用直达 URL 对应摘要解析 `agentRoleId`；完整 Gateway 配置、元数据和网络选项仍在后台读取，继续作为编辑与诊断数据源。
4. 每个人格的计划缓存改为监听一个 `plans/` 根目录递归 watcher。路径未知的事件先保留热缓存，再由防抖完整刷新对账；文件系统不支持递归监听时仍走 500 ms TTL。
5. 前端性能遥测同一时刻只保留一个上传请求。上传失败会恢复已采集样本，并在下次请求前指数退避。
6. 永久中英文架构文档已同步这些启动与数据所有权规则；本记录保留在归档目录。
7. 消息处理看板升级为 v2。未完成需求最多保留 24 小时，`sent`、`not_required` 和 `send_failed`（包括计划通知）只保留 15 分钟；过期消息的正文、附件和 `replyContext` 删除，只留下最多 7 天的 SHA-256 重放去重键。重放命中后返回 `replay_suppressed`，不再投递 Agent 或发布看板事件。计划订阅独立保留后续通知需要的来源和 worker，不再让过期需求因订阅引用而继续占用看板。
8. 知识页计划恢复“首屏优先、后台全量”的目录加载：先显示 8 条摘要，再串行读取同一筛选条件下的剩余页至 `nextCursor` 为空。每页让出一次渲染帧；切换 Route、隐藏页面或卸载会使请求版本失效，停止后续请求。计划正文、附件和卡片挂载仍按阅读位置与滚动窗口控制。

## 验证

- `npx tsc -p tsconfig.json --noEmit` 通过。
- `npm exec vue-tsc -- -p ribiwebgui/tsconfig.json --noEmit` 通过。
- 启动 Route 注册、插件页/模块、Base Bundle 注册和角色知识缓存相关的聚焦单元测试共 51 项，全部通过。
- `npm run webgui:build` 通过，并刷新 Manager Base Web Bundle。Vite 仅输出既有的大 chunk 警告。
- 消息处理看板、Manager 路由和转发路径聚焦测试共 58 项，全部通过；`npx tsc -p tsconfig.json --noEmit` 通过。
- Chrome DevTools 通过当前源码的 Vite 服务打开 `http://192.168.0.57:8793/#/routes/XinghaiBuilder-main/knowledge`。14 秒后固定壳和 `XinghaiBuilder` 知识页已显示，未进入插件恢复页，页面没有 JavaScript 错误。重启前的旧 Manager 进程仍会在 12 秒后让计划数据请求超时；页面保持已渲染状态并显示请求失败，不再回到空白页。

## 实时部署验证

2026 年 8 月 26 日已从 `dist/manager.js` 重建并重启 Manager。第二轮 Manager PID 为 `12560`。消息处理看板已写为 v2，实测为 512,833 B、30 条需求、13 条计划订阅和 166 条哈希去重记录；最近一次持久化为 46 ms。20 轮并发控制面请求全部成功：`/` P95 9.3 ms，`/meta` P95 17.8 ms，`/gateways?summary=1` P95 29.9 ms，知识页计划接口 P95 62.3 ms。Chrome 以全新浏览器资料访问实时知识页，DOMContentLoaded 为 320.3 ms，页面显示 `XinghaiBuilder`、419 条计划中的前 8 条，没有进入恢复页，也没有 Console、运行时或网络错误。

## 2026 年 8 月 26 日补充验证

- `node --import tsx --test ribiwebgui/tests/knowledge-pagination.test.ts` 的 9 项测试通过，覆盖首批后自动续页、Route 变更停止后续请求和游标不推进停止。
- `npm run build` 通过，重新生成并同步 Manager Base Web Bundle。
- 旧 Manager `12560` 已退出；从当前 `dist/manager.js` 启动的 Manager PID 为 `64660`，`/meta` 返回 `healthy`。根 HTML 为 `no-store`，引用当前入口 `app-DZNwyrXb.js`。
- 全新 Chrome 资料直达知识页后，页面显示 `XinghaiBuilder`、`计划 419 / 419` 和“列表数据已加载”；Console 没有 error。计划卡仍只按滚动窗口挂载，正文和附件仍按阅读位置读取。
- 20 个并发计划摘要请求全部返回 200；P50 为 148.9 ms，P95 为 162.1 ms，最大值为 163.2 ms。
