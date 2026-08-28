简体中文 | <a href="./README_en.md">English</a>

# io.rabiroute.manager.gateway-runtime

内置 Manager 插件。实例 `manager:gateway-runtime` 提供 `manager.gateway-runtime@1`。实现只通过 `@rabiroute/plugin-sdk` 和清单声明的版本化能力访问宿主资源。

## generation 更新

新 generation 先取得宿主资源租约，旧 generation 再释放租约。插件更新期间继续使用现有 Gateway 进程；只有插件最终停用或卸载时才停止这些进程。
