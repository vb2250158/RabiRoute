[English](core-public-api-operations_en.md) | [简体中文](core-public-api-operations.md)

# Manager 基础公共接口迁移

面向接入开发者与维护者。`createCorePublicOperations` 提供以下九个可执行声明，复用原生状态、投递预留和 Host 重置事务。声明负责注册、发现、解析、输入和响应校验；业务方法不调用旧 HTTP dispatcher。

| 方法 | 路径 | 原生行为 |
| --- | --- | --- |
| GET | `/health` | 原 `managerHealthPayload()`，保持应用身份、就绪与后台健康字段 |
| GET | `/api/automatic-updates` | 原 `AutomaticCodeService.snapshot()`；未配置时保留 disabled 原因 |
| GET | `/api/source-patches` | `ManagerSourcePatchService.status()` 缓存快照 |
| GET | `/api/source-patches/operations/:operationId` | 原操作读回；排除 fingerprint 与内部 proof；缺失 404，读取失败 503 |
| GET | `/api/web-patches` | `WebPatchService.status()` 原身份、revision、容量与状态 |
| GET | `/api/web-patches/operations/:operationId` | 已提交 200；ready 且无回执 404/not_started；受阻且无回执 503/unknown |
| GET | `/api/agent/delivery-authority` | 精确 deliveryId/generation 的既有预留证明；保留原 source/target、promptHash、执行参数 hash，禁止返回 prompt |
| POST | `/api/rabi/identity/reset-instance-id` | 2048 字节 JSON、confirmed=true、UUID operationId 与 expectedGuid；按当前保存拼写进行原生 GUID CAS，202 仅表示 queued |
| GET | `/api/rabi/identity/reset-instance-id/:operationId` | 原 Host 状态，queued 时等待文件事件最多十秒，断连关闭 watcher |

所有接口使用原连接鉴权。已鉴权且未被明确禁用的远端不增加功能白名单、本机来源门或第二密钥。实例重置仍支持原先严格的本机浏览器入口；伪造代理头或未接纳的 Agent 凭据不能使用该例外。

`prepare` 在正文读取前捕获同一 principal、原目标服务/方法和拷贝的 Manager 双身份。服务、方法、applicationGenerationId 或 managerInstanceId 改变时返回 409；派发前为 not_started，原生派发后保留 unknown，不转投替换服务。所有异步读回、endpoint 刷新与重置入队完成后复验原身份；撤销或替换后不披露旧结果。原生重置请求使用唯一 operationId 文件与精确 expectedGuid，重用不同载荷冲突，未知结果先查原操作。响应取消不重放已接受的 Host 命令，注册租约等待实际 Promise 完成。JSON 解析器对超限正文返回 413，对无效正文/重复查询身份返回 400；错误回执带当前合同修复信息。

## Host 与资源边界

`POST /_rabiroute/host/source-patches` 及其 `/reconcile`、`POST /_rabiroute/host/web-patches` 及其 `/reconcile` 保留原 Host 私有发布协议、身份、CAS、持久回执与容量限制。`/_rabiroute/web/:revision/...` 的 GET/HEAD 协议由新原生静态 owner 接管；旧 route 静态块、整页 document()/read() 缓冲与改写方法已删除。WebPatchService 的 modules()/module() 仍持有模块映射与稳定版本导出；staticManifest() 提供兼容性和不可变清单。activeReads 字段仅为旧公共状态兼容保留为 0，本服务已无缓冲读取；实际文件句柄归 NativeWebguiStaticOwner 管理。它们没有被计入以上九个公共声明，也没有把现有公共更新或重置请求改归私有。

## 控制面接线

在 `controlPlaneRoutes.ts` 的统一 `ApiOperationDefinition[]` 注册点调用一次：

```ts
createCorePublicOperations({
  identity: () => ({
    applicationGenerationId: managerHostIdentity?.applicationGenerationId ?? managerInstanceId,
    managerInstanceId
  }),
  health: managerHealthPayload,
  automaticUpdates: () => automaticCodeService?.snapshot()
    ?? { state: "disabled", reason: "No external source root is configured." },
  sourcePatches: managerSourcePatches,
  webPatches: managerWebPatches,
  deliveryAuthority: {
    store: agentRequests,
    managerInstanceId: lanAgentRegistry.localInstanceId,
    refreshEndpoints: async identities => {
      if (!agentEndpointDelivery) throw new Error("Manager endpoint delivery authority is unavailable.");
      await agentEndpointDelivery.refreshEndpoints(identities);
    },
    authorize: (endpoint, role) => {
      if (!agentEndpointDelivery) throw new Error("Manager endpoint delivery authority is unavailable.");
      agentEndpointDelivery.authorize(endpoint, role);
    }
  },
  identityReset: {
    service: instanceIdentityReset,
    currentGuid: () => rabiGlobalConfig.read().rabiGuid
  }
})
```

注册必须发生在这些 owner 已创建后，公共请求必须到达 registry，且保持原全局只读、启动就绪与连接鉴权处理顺序。移除主 HTTP 链的 health、automatic-updates、delivery-authority 与实例重置直接分支及相应旧 handler import。源码/Web route handler 只保留 Host 私有发布分支；其公共状态分支已从源码移除。

`handleAgentDeliveryAuthority` 和 `handleInstanceIdentityReset` 的旧生产导出已删除，原测试 HTTP 夹具已迁到相同 registry。实例重置的规则只有 `createInstanceIdentityResetOwner` 一份，投递证明只有 `readAgentDeliveryAuthority` 一份。共享 controller 的旧 import 与调用必须在总接线变更中同时删除，不保留旁路。共享 controller、策略、编译入口和索引由总接线负责人修改，本模块不越权改写。

## 验证边界

`corePublicOperations.test.ts` 使用随机临时 HTTP 端口、已接纳远端凭据、受控 Host driver 和临时请求文件，覆盖九种真实 method/path、GUID CAS、操作去重、状态区分、投递证明、正文前撤销、异步披露与断连后租约。`identityResetRoutes.test.ts` 保留原 Host 固定命令、持久回执与 watcher 验证；`agentDeliveryAuthorityRoutes.test.ts` 保留预留恢复、取消和身份 ABA 验证。

运行：`node --test-concurrency=2 --import ./scripts/test-manager-runtime-env.mjs --import tsx --test src/manager/corePublicOperations.test.ts src/manager/identityResetRoutes.test.ts src/manager/agentDeliveryAuthorityRoutes.test.ts`。

本模块测试不调用真实 Host 发布或重置，不向平台或 Agent 发送真实消息。统一编译、控制面最终接线、整体 catalog parity 与运行验收由原根任务统一执行。独立审计的 not-proven 状态保持不变；此页不把 91 项分类清单或 22 个旧 UI routeId 当作 HTTP 总量或缺口。
