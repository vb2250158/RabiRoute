<!-- docs-language-switch -->
<div align="center">
<a href="./LX06-FLASH-CHECKLIST.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# LX06 刷机调查清单

> 状态：高风险历史调查。RabiRoute 不提供固件、刷机工具或受支持的音箱镜像。使用前必须按当前 [Open-XiaoAI 上游](https://github.com/idootop/open-xiaoai)、准确 LX06 硬件和固件重新核对每条命令。

原调查目标是 Xiaomi XiaoAI Speaker Pro，型号 `xiaomi.wifispeaker.lx06`。

## 安全门

刷机可能导致保修失效、数据清除或设备变砖。只有设备所有者接受风险，并且恢复路径已经验证时才能继续。

不要公开 SN、MAC、二维码、Wi-Fi/SSH 密码、小米账号、受限制固件或本地设备地址。

## 仓库侧准备

当前仓库只提供 PC 桥接相关文件：

```text
plugin-adapters/xiaoai-rabiroute/index.mjs
plugin-adapters/xiaoai-rabiroute/smoke-send.mjs
plugin-adapters/xiaoai-rabiroute/xiaoai-local.config.example.json
examples/data/route/xiaoai/adapterConfig.json
docs/xiaoai-integration/xiaoai-roleMessageConfig-snippet.json
```

这些文件不会让 LX06 刷机自动变得安全或受支持。

## 刷写前验收

在写任何分区前，必须确认：

1. 准确型号、主板版本和当前固件。
2. 当前上游文档明确支持这个组合。
3. 数据线、USB 识别和驱动正常。
4. 修改镜像的来源和校验值可信。
5. 原启动分区与恢复流程已经测试。
6. 恢复所需的非秘密配置已有本地备份。

不要根据别的小爱型号或旧 LX06 教程推断兼容性。

## 历史命令轮廓

旧调查曾使用 Amlogic 工具识别设备，把 `boot_part` 指向 `boot0`，并把修改镜像写入 `system0`。仓库已不包含当时依赖的上游版本，因此本文不再把这些命令包装成可复制流程。

只有重新核对当前上游后，操作人才能整理准确命令。执行前应在私有工作记录中保存工具版本、固件 hash、identify 输出和恢复命令。

## 刷写后的集成边界

如果受支持的镜像能启动且 SSH 正常，再按当前上游说明安装音箱 client。server 地址与凭据只放在被忽略的本地配置。

PC 侧仍需要兼容 server、本桥接层、启用的 XiaoAI Route，以及音箱端对 `intercept` 和回复播放的显式处理。SSH 反向隧道只是可选网络绕行，不是刷机成功证明。

## 恢复

没有确认过的原启动分区或原系统镜像恢复方法，就不要开始。旧记录提到 `boot1` 可能是原系统，但必须在实际设备上确认后才能修改。

## 完整验收证据

完整环境验收需要分别证明：设备可恢复、client 重启重连、非命中不打断、命中真正打断、RabiRoute 完成记录和路由、Desktop IPC 投递到已加载任务、真实回复完成音箱播报。

当前仓库只证明 PC 桥接和 Route 侧的一部分，不证明完整闭环。
