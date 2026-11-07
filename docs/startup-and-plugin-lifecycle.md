# 启动窗口与插件生命周期

[English](startup-and-plugin-lifecycle_en.md)

双击启动 RabiRoute 时，启动器先显示品牌窗口，检查安装与启动环境，再启动原 Host。窗口显示真实阶段，没有固定展示时长或估算百分比。服务可用后自动关闭；关闭窗口或点击“后台继续”只隐藏窗口，启动仍由原 Host 继续。命令行查询、后台自启动和提权任务不另外弹出启动窗口。

## 核心先可用，其他功能逐步就绪

启动关键路径保留安装版本选择、原 Host 控制与进程所有权、Manager 身份和监听器，以及 profile 中 `readyRequires` 的真实依赖。插件管理和诊断来自宿主，不依赖某个业务插件是否成功启动。

其余插件在后台初始化。依赖尚未发布的插件显示等待依赖；一个插件缓慢或失败，不阻断无依赖插件与管理界面。源码补丁监听器在 Manager READY 后启动，其 compiler 与已进入的发布操作仍由原生命周期拥有者等待退出。读取依赖声明不等于执行所有插件的初始化。

插件初始化阶段与真实运行分开显示：

- **初始化中**：初始化尚未完成；更新时仍可保留原运行版本。
- **运行中**：原插件已发布；发布后的后台启动仍有初始化标记时继续显示准备状态。
- **正在停止**：设置已移除或停用，但原资源还在退出。
- **退出待确认**：显示原插件的具体诊断，无依赖功能继续可用。

退出完成后清除当前退役状态；历史诊断不会把已停止插件永久标为未退出。

## 安装、停用、卸载

在“插件”页选择已有版本安装，或填写**运行 RabiRoute 宿主的电脑上的插件运行包目录**进行导入。目录内应有 SDK 生成的 `rabi.plugin.json` 和对应入口、资源。此入口导入目录，不是 ZIP 上传。

宿主发布目录保持不可变。用户导入的包位于 `data/plugins/packages/<pluginId>/<version>`；显式安装的包版本也会保留在这个目录，避免宿主升级后丢失独立选择的插件版本。同一插件同一版本的不同字节不会覆盖原包，应更新插件自己的版本。

启用、停用和安装成员关系由原 `PluginProfileSettings` 按实例保存，保留原设置版本检查。卸载会移除有效成员关系，通过原 Kernel 取消初始化、撤回注册并释放资源；配置和业务存档保留。重装已移除的同一版本时复用原实例身份。仍已安装的包可添加独立实例，是否存在能力冲突由真实插件声明与 Kernel 报告。

HTTP 接收设置不代表资源已经退出。页面按原状态事件和读取结果展示初始化、停止或失败；结果未知时读取原状态，不自动重复安装。坏实例文件只影响该实例，健康邻项仍能使用；安装不会覆盖身份不符或损坏的目标设置文件。

## 插件作者：异步初始化与释放

所有执行入口沿用统一的 `activate(context): void | Promise<void>`。声明式插件不执行额外业务代码。异步工作由原 activation 和 `EffectScope` 拥有：

```ts
export async function activate(context) {
  const resource = await openResource({ signal: context.lifecycle.signal });
  context.effects.adopt(() => resource.close(), "resource connection");
  context.services.provide("example.resource@1", resource);
}
```

初始化取消后不得继续注册服务。迟到取得的资源仍交给原 scope 释放；返回的释放 Promise 必须表示真实退出。CPU 密集计算使用原 Worker 执行方式，仅给函数加 `async` 不会把同步计算移出主线程。依赖按 manifest 声明，宿主不硬编码插件启动名单。

Kernel 的 `.switch()` 默认仍等待该次初始化。Manager 对非必要初始化使用 `initialization: "background"`；`settle(instanceId?)` 等待原有工作，`pendingRetirements()` 投影实际资源拥有者。初始化和清理不占全局 mutation 队列，发布与回滚仍走原事务。

## 主题插件替换启动动画

启动窗口跟随现有 `desktop settings.webTheme`，不另建启动主题开关。主题包在原静态 `theme` contribution 的 `value.startup` 声明外观。示例：

```json
{
  "kind": "theme",
  "id": "example.theme",
  "value": {
    "surface": "shared.themes",
    "hosts": ["web", "desktop"],
    "themeId": "example",
    "webResourceId": "example.web-theme.v1",
    "startup": {
      "schemaVersion": 1,
      "light": {"background": "#F5F8FC", "foreground": "#17242C", "accent": "#22BEC5"},
      "dark": {"background": "#111B21", "foreground": "#F0F6FA", "accent": "#6CE8E6"},
      "motion": "orbit",
      "logo": "./assets/logo.ico",
      "frames": [
        {"logo": "./assets/frame-1.ico", "durationMs": 160},
        {"logo": "./assets/frame-2.ico", "durationMs": 160}
      ]
    }
  }
}
```

静态资源文件使用现有 `{"contributions": [...]}` 包装，`entries.manager` 与 `entries.desktop` 可同时声明 `execution: "declarative"` 并引用该文件。供 Web 下拉选择时，包的 Web 入口还须通过原 `api.registerTheme` 注册相同 `themeId` 与 `webResourceId`；启动器不执行这段 Web 代码。

ICO 帧与持续时间允许主题提供自己的逐帧动画；不提供帧时使用 `none`、`breathe` 或 `orbit` 内置表现。系统关闭动画时使用静态画面。原生窗口先显示品牌画面，再异步预载主题图标，播放复用内存句柄；关闭、更换主题和退出时释放原资源。

Manager 在设置提交、插件成员或包变化后更新可重建的 `data/desktop/startup-theme.json` 与当前 SHA 图标缓存。冷启动只读取该本地表现，不等待 Manager 或加载主题脚本。主题停用、卸载、资源缺失时使用品牌表现，宿主继续启动；不再引用的派生图标会清理，正式配置和插件原资源不受影响。
