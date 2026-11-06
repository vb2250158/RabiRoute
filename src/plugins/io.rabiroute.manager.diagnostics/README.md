简体中文 | <a href="./README_en.md">English</a>

# io.rabiroute.manager.diagnostics

实例 `manager:diagnostics` 提供 `manager.diagnostics@1`。`operations.mjs` 拥有 `/api/gateways` 的 HTTP 合同与查询处理；修改该查询无需修改宿主业务提供表。

插件通过 `host.manager.gateway-status@1.readStatuses()` 读取现有 Gateway owner 的状态，不复制运行状态、配置或缓存。通过 SDK 的 `host.manager.operations@1` 注册操作，注册释放随插件 effect 生命周期执行。认证仍由统一 API 入口负责；失败透传给原 API 错误处理，不返回伪造的空成功。

`/meta` 由 core 插件提供，与本插件生命周期无关。页面贡献保持原合同；此次后端试点不更换 Web 资源。正式包加载、发布、卸载与安装版回读分别验收，源码测试不代表安装生效。
