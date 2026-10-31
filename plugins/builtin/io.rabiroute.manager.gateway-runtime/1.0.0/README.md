简体中文 | <a href="./README_en.md">English</a>

# io.rabiroute.manager.gateway-runtime

内置 Manager 插件。实例 `manager:gateway-runtime` 提供 `manager.gateway-runtime@1`。实现只通过 `@rabiroute/plugin-sdk` 和清单声明的版本化能力访问宿主资源。

## generation 更新

候选只注册自己的控制接口，不取得正式启用租约，也不启动、停止或重启 Gateway。`context.publication.add` 在同步发布事务中取得宿主资源租约；发布失败只撤销候选租约，保留原 generation。

候选通过宿主 `createGatewayListenerProjection()` 创建自身目录投影。唯一的 Manager 长期 host 持有原 Gateway child 的 stdout 解析器、半行缓冲和已验证监听合同缓存；投影只在本 activation 正式发布时可见。候选失败和旧实例退役均只释放自己的投影，不销毁长期 host、不重播 stdout，也不重启保留的 Gateway 进程。

发布后的 `afterPublish` 等待旧实例完整退役并检查取消信号，再按原有 Manager readiness 与只读配置调用正式 Gateway 调度。新 generation 先取得租约，旧 generation 再释放租约；插件更新期间继续使用现有 Gateway 进程，只有最后一个已发布拥有者停用或卸载时才等待这些进程结束。重复清理复用同一次释放与等待。

隔离验证见 `src/manager/gatewayWearablePublication.test.ts`：覆盖准备失败、发布回滚、旧慢请求排空、代际替换、版本回退及最终清理，使用受控 Gateway callbacks，不启动真实消息端。
