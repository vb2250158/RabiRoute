# WebGUI 端点范围审计

[English](webgui-coverage-contract_en.md) | 简体中文

`npm run check` 中的 `Audit-WebguiCoverage.mjs` 检查 WebGUI 发现的公共 Manager 路径能否使用通用 API 传输。新增公共 API 不需要加入审计目录、修改 Relay 或补充逐接口授权。实际业务是否成功，由目标 PC 接口及其参数、版本、对象归属和用户明确禁用项决定。

审计使用共享 `validateApiRequest` 和 `API_METHODS`，对每个发现路径检查 GET、HEAD、POST、PUT、PATCH、DELETE、OPTIONS。写入样本带稳定 operationId。发现的 fetch 方法仅供描述；动态调用不能因为静态扫描显示 GET 就漏查写入方法。

`webgui-coverage-contract.mjs` 保留已知 UI 和连接协议的回归夹具索引。历史 `required` 项继续检查原有页面功能，关联 fixture 继续检查文件存在；旧 `unsupported`、`pc-only`、`dedicated` 等标签不决定公共 Manager API 权限。所有已知 PC 路径同样检查通用传输；Relay 连接 helper 的显式合同独立保留。

模板扫描平衡嵌套 `${...}` 和引号，参数与动态尾部分别保留为 `:param`、`:dynamic`，并用安全样本检查传输。动态样本不是完整业务端点或实际请求成功的证明。当前扫描覆盖 fetch 字面量和受检 Skill helper，不是完整 TypeScript 数据流分析；间接 helper 的发现覆盖仍需相应夹具。

内部路径、传输私有路径和协议相对外部 URL 对全部共享方法保持拒绝。通用传输仍校验相对路径、请求头、大小及写入幂等键，不把人格、工作区、Route 或目录登记当作额外功能许可。

从应用目录运行 `node --test scripts/webgui-coverage.test.mjs`。测试覆盖当前发现路径、未登记的未来接口、动态人格与扫描路径、故意收窄未来写入方法，以及全部方法的私有边界负例。静态审计与 fixture 文件存在检查不代替实际 HTTP、流式或设备验收；眼镜也无需复制 PC 的全部管理界面。
