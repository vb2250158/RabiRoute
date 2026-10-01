简体中文 | <a href="./README_en.md">English</a>

# io.rabiroute.manager.route-control

内置 Manager 插件。实例 `manager:route-control` 提供 `manager.route-control@1`。实现只通过 `@rabiroute/plugin-sdk` 和清单声明的版本化能力访问宿主资源。

独立 Web 入口注册“新增路由”“快速配置”和“打开配置目录”动作，Manager 目录声明这些动作的名称与位置。顶栏“新增路由”在路由列表为空时仍可使用，复用现有创建与快速配置流程；停用插件后入口和动作一起释放。完整构建将该入口同步到本包的 `web/client.mjs`，无需在控制台添加另一套创建按钮。

未保存的新路由可以取消：页面先确认服务端没有对应 ID 或配置名；发现相同 ID 或配置名时保留草稿并提示冲突，不删除该服务端路由。保存结果未确认、读取失败或 Manager 身份变化时也保留草稿；已确认保存的路由使用正式删除流程。
