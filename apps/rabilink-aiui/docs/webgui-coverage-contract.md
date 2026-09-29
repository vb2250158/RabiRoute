# WebGUI 端点范围审计

[English](webgui-coverage-contract_en.md) | 简体中文

`npm run check` 保留 `Audit-WebguiCoverage.mjs` 入口。它验证显式端点／方法／owner／运行模式／分类合同，不要求眼镜复制全部 PC 管理界面，也不把原先 35 个缺项宣称为已实现。

- `required`：原有 legacy 配置功能继续要求页面实现与实际 Relay 方法权限同时存在。
- `unsupported`：PC 专用 hooks、LAN Agent、登录控制、小爱、桌宠、桌面、处理看板、性能、插件、缓存、视频、访问设置，以及未实现角色记录／文档能力，通用转发必须拒绝。
- `dedicated`：设备 profile、知识请求和 owner 授权仅走专用认证入口；角色计划状态通过 `plan_statuses` 工具映射，不开放通用角色接口。
- `pc-helper`：角色 Skill 浏览器的 request helper 用稳定 manifest 声明，仅 PC 界面功能，不等于眼镜 Skill 执行。
- `dynamic-prefix`：peer、动态 gateway action 等不是完整 endpoint，也不是泛权限；具体可用 gateway action 单独列入 required。

模板解析平衡嵌套 `${...}` 和引号，查询后缀不再成为路径；未知发现路径失败关闭。动态尾部保留 `:dynamic`，不能误标完整覆盖。当前扫描 fetch 字面量，间接 request helper 由受检 manifest 补齐；这不是全 TypeScript 数据流分析，新 helper 仍须显式登记。

权限验证从当前 Relay 提取真实 `mobileWebguiPathAllowed(method,path)` 并执行，逐 GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS 核对，不再对整文件搜索 pathname。专用入口仍必须被 generic 权限拒绝，合同关联现有真实 profile HTTP、knowledge E2E 和授权 HTTP fixture；审计检查 fixture 存在，实际 fixture 必须单独执行，不能把静态关联当业务测试成功。

`node --test scripts/webgui-coverage.test.mjs` 验证未知端点及敏感权限扩大都会失败。本轮本机快照主审计和 4 项测试通过；未扩大 Relay 白名单，未改变模型、布局、安装或设备状态。动态 endpoint 的 HTTP 方法由 manifest明确授权边界，不能仅凭 fetch 的默认 GET 推断服务器支持。
