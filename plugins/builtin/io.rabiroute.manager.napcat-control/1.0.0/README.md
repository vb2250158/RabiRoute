简体中文 | <a href="./README_en.md">English</a>

# io.rabiroute.manager.napcat-control

内置 Manager 插件，通过 `host.manager.napcat-control@1` 复用原 NapCat 实例、配置与进程拥有者，提供 `manager.napcat-control@1`。

10 个 POST `/api/message/napcat-*` 操作从 `createNapcatControlOperations` 同时安装路由、输入合同和发现目录。操作 ID 为 `manager.napcat.<后缀>`，后缀包括 `repair-all`、`ensure-ready`、`health`、`login-panel`、`login-action`、`configure-onebot`、`add`、`launch`、`restart`、`remove`。已鉴权远端可按公共合同调用，保留用户明确禁用项及原对象、账号和绑定检查。

保留原 JSON 输入语义、空 body `{}` 和原生参数转换，不另加应用字节上限；`repair-all` 忽略任意 body。登录页面与登录操作结果使用 `no-store`。原生 `ok` 的真假规则决定各操作的 HTTP 状态；生命周期失败仍返回 `400 {ok:false,message,state}`。

接口没有请求级幂等键。结果不确定时先核对原实例健康与配置，不能自动重放登录、修复、添加、移除或进程操作。HTTP 成功不等于 QQ 已登录、消息送达或真实设备验收通过。

候选准备只构造私有控制上下文并注册候选路由。`context.publication` 正式发布时同步切换活动上下文并开放操作；发布前失败或同步发布失败保留原上下文、接口和 guardian。

插件退役停止接入并等待已接入的真实操作收尾。仅当本上下文仍为活动上下文时才停止全局 supervisor；替换后的旧插件由其配对 supervisor 自行退役，不能停止新 supervisor。清理上下文时同样核对引用身份。绑定进程保留给原进程拥有者交接，不随插件换代结束 QQ。

受控回归覆盖同一 Manager 内的失败候选、同步发布回滚、替换及版本回滚，以及已接入命令的真实测试子进程 `close` 和 stdout/stderr 排空。测试不启动 QQ/NapCat；安装版与真实账号验收分别执行。
