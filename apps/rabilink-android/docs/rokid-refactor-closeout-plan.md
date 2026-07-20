# Rokid 模块本轮重构收工文档

<!-- docs-language-switch -->
<div align="center">
<a href="./rokid-refactor-closeout-plan_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

> 状态：已完成的重构记录。它描述模块拆分验收，不代表 Rokid 原生 ASR/TTS 已打通。

本文件只覆盖当前 `com.rabi.link` 单 APK 内的 Rokid 手机侧 SDK 探针重构收口，不把小米路线、RabiRoute/Codex/MCP 消息端接入或眼镜端独立应用纳入本轮完成范围。

## 目标

把 Rokid 模块从“一个 Activity + 一个偏胖 Controller”继续拆成清晰的手机侧 SDK 探针模块。完成后，页面、SDK 调用、回调、链路状态、音频缓冲、证据保存和文档说明各自有明确归口。

## 不做范围

- 不处理小米路线。
- 不接 RabiRoute/Codex/MCP 消息端。
- 不新增眼镜端 APK。
- 不新增眼镜侧派生应用包名。
- 不改变正式包名 `com.rabi.link`。

## 任务表

| 序号 | 完成状态 | 事项 | 为什么还要做 | 目标文件 |
| --- | --- | --- | --- | --- |
| 1 | 已完成 | 抽出 CXR 回调安装 | `RokidCxrController` 还塞着 link、CustomView、audio、image 四组回调，后续加能力会继续变胖。 | `RokidCxrCallbacks.java` |
| 2 | 已完成 | 抽出链路状态对象 | `cxrConnected` / `glassBtConnected` 是运行时状态，应有唯一归口。 | `RokidCxrLinkState.java` |
| 3 | 已完成 | 抽出探针默认参数 | 音频通道、拍照尺寸、JPEG 质量、亮度/音量、Hello 文案现在散在 UI、Controller、Activity。 | `RokidProbeDefaults.java` |
| 4 | 已完成 | 把文档里的 Rokid 职责段改成表格 | README 和合并说明里的 Rokid 职责是一长串，后续 Agent 很难维护。 | `README.md`、`docs/rabi-link-probe-merge-plan.md` |
| 5 | 已完成 | 收工检查 | 确认单 APK、包名、构建没有偏。 | `assembleDebug`、命名扫描、文件体积复核 |

## 收工标准

- `RokidCxrController` 只保留 CXR-L 调用门面和最少编排。
- CXR 回调安装、链路状态、音频采集、证据保存、页面 UI、报告日志各有明确归口。
- 正式包名仍然只有 `com.rabi.link`。
- 不新增眼镜侧派生应用包名或第二个 APK。
- `assembleDebug` 通过。
- 命名扫描不出现旧 ADB 包名或眼镜侧派生应用包名；历史歧义命名只允许留在合并说明的历史记录段。

## 验收命令

```powershell
$env:JAVA_HOME='<repo>\apps\rabilink-android\out\tools\jdk-17.0.15+6'
$env:PATH="$env:JAVA_HOME\bin;$env:PATH"
.\out\tools\gradle-8.6\bin\gradle.bat :app:assembleDebug
rg -n "<旧 ADB 包名>|<眼镜侧派生包名>|<旧类名前缀>|<旧文件名前缀>" README.md docs app/src/main/java/com/rabi/link
Get-ChildItem -Path 'app/src/main/java/com/rabi/link/modules/rokid' -File | Sort-Object Length -Descending | Select-Object Name,Length
```

## 验收结果

- `assembleDebug`：通过。
- 命名扫描：全仓旧命名、旧路径和旧派生包名精确扫描无命中。
- 文件体积复核：`RokidCxrController` 已从偏胖控制器拆成调用门面，CXR 回调、链路状态、默认参数和音频采集已有独立归口。
