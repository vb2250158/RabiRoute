# RabiLink AIUI 验收报告

更新时间：2026-07-13

## 验收结论

当前结论分为两层：

- **本地验收：通过。** 连接对话、持续下行流、无任务主动投递、TTS/ASR 交接、原生 Agent 配置助手、双模式 UI、电量/充电、Ink resize、启动安全和最终 AIX 均已通过自动化测试。
- **1.0.5 云端与真机验收：待完成。** 云端仍是此前上传的 `RabiLink 1.0.4`；本次 1.0.5 尚未上传、提审或同步到当前已断开的手机与眼镜，因此不能沿用旧 runtime proof。

不能用本地模拟 ASR、Craft 文字注入或此前 CXR 电量记录替代最终眼镜运行结论。

## 当前交付物

| 项目 | 当前值 |
| --- | --- |
| 云端智能体 | `RabiLink` |
| 本地待发布版本 | `1.0.5` |
| 当前云端历史版本 | `1.0.4` |
| AIX | `dist/rabilink-aiui.aix` |
| AIX VERSION | `67f2d978-cfcf-4bbe-9013-df2401bd5623` |
| AIX SHA256 | `fa596e2920c46bfb804a96916f4d716cff6bf9071427163286045cafcaadfd3c` |
| 1.0.5 云端状态 | 未上传；不得自动执行外部发布 |
| 本地验收 | 18/18 通过 |

源码 AIX、`dist/delivery/rabilink-aiui.aix` 和 ASCII 临时镜像必须保持相同 SHA256。

## 原始需求逐项验收

| 需求 | 结论 | 权威证据 | 真机待验 |
| --- | --- | --- | --- |
| 首页使用左右双段滑轨 | 本地通过 | `Audit-AiuiDesign.mjs` 断言两处 `modeSwitch`、移动 thumb 和无 `<button>`；Ink 截图可见双段轨道 | 最终眼镜截图 |
| 左侧模式命名 | 采用 `连接对话`，通过 | 页面 Schema、HUD、卡片和 Agent 说明统一使用最终名称 | 无 |
| 右侧为配置助手 | 本地通过 | 同一 InkView 的右侧轨道为 `配置助手`；20 次往返不调用 `finish()` | 眼镜触摸板实测 |
| 重试、暂停低于模式切换层级 | 本地通过 | `utilityAction` 位于滑轨下方，无 border/background；配置助手不显示伪“说话”按钮 | 眼镜可读性确认 |
| 滑动直接切换，不再点击进入 | 本地与 Craft 通过 | Ink 0.13/0.14 从两个入口 resize；触摸事件走同页状态机 | 眼镜真实触摸板方向 |
| 左下时钟图标和时间 | 本地通过 | `clockIcon` + `HH:mm` 在沉浸式 HUD 和 448×150 卡片均完成像素渲染 | 眼镜本地时间核对 |
| 右下电量图标、百分比和充电标记 | 本地与 CXR 链路通过 | 97% + charging fixture 完成 Ink 渲染；Relay 状态覆盖鉴权、持久化、过期清空 | 最终 AIX 读取实时眼镜电量 |
| 默认连接对话、配置助手使用原生 Agent | 本地通过 | 85 条明确命令、283 种说法；严格 intent 不做子串猜测；配置模式不创建页面 ASR | 眼镜原生 Agent 真实调用 |
| 连接对话不维护任务状态 | 本地与 HTTP 集成通过 | 上行 `/input` 返回 accepted 且无 `taskId`；页面源码无 pending task 集合或完成态过滤 | 眼镜长时间运行 |
| 普通回复与主动投递共用持续队列 | 本地与 HTTP 集成通过 | 空闲长轮询被 `/worker/messages` 主动消息唤醒；普通/主动消息均进入同一显示和 TTS 队列 | 真实 Codex 回复与定时提醒 |
| TTS/ASR 防回流 | 本地通过 | TTS 前 abort 当前 recognition，`utterance.onend` 后恢复下一轮 ASR | 眼镜扬声器与麦克风实测 |
| 配置助手调用已绑定 PC Rabi | 集成通过 | 原生 Agent intent 直接分发到 Relay mobile/WebGUI API；未知需求不提交 task | 眼镜发出真实只读配置指令 |
| 非沉浸式入口卡也使用同一设计 | 本地通过 | 448×150 卡片与沉浸式 HUD共享模式状态；卡片截图和 safe-width 像素检查通过 | Craft/眼镜宿主最终显示 |
| 安装和使用问题形成文档 | 通过 | `installation-and-troubleshooting.md` 已覆盖五阶段发布、ADB、Craft、ASR、卡死、局部重绘、电量、UTF-8 与常驻边界 | 后续问题继续追加 |

## 自动化结果

以下命令已在最终 AIX 上通过：

```powershell
npm run check
npm run acceptance:local
npm run delivery:verify
npm run readiness
npm run goal:evidence
```

关键结果：

- `npm run check`：85 条明确配置命令、283 种说法、严格 native-Agent intent、20 次同页模式往返。
- `npm run acceptance:local`：18/18 项通过。
- Ink 0.13/0.14：从连接对话和配置助手两个入口执行卡片到沉浸界面 resize，均完成 20 次模式往返。
- 启动安全：预览不抢占 ASR；连续快速失败在第 5 次停止自动重试。
- Craft 最终 AIX：模式切换和模拟 ASR 的 3 秒采样均为 `partial_frames = 0`。
- Delivery：最终 AIX 9 个文件，版本和 SHA256 与云端上传证据一致。

## 证据索引

- `dist/local-acceptance.json`：18 项本地验收矩阵。
- `dist/craft-render-acceptance.json`：Craft 最终 AIX 模式/ASR 像素采样。
- `dist/craft-upload-status.json`：云端上传、工具 Schema 和版本可见性。
- `dist/craft-review-status.json`：云端绑定、提审按钮和未提交状态。
- `dist/goal-evidence.json`：完整目标的已证明项与外部状态缺口。
- `dist/ink-runtime-smoke.png`：沉浸式连接对话 HUD。
- `dist/ink-runtime-tools-page-1-charging.png`：配置助手与充电状态 HUD。
- `dist/ink-runtime-compact-smoke.png`：非沉浸式连接对话卡片。
- `dist/ink-runtime-compact-configuration-charging-smoke.png`：非沉浸式配置助手与充电状态卡片。

## 设备回来后的最终验收

1. 手机和眼镜可用后，把本地 `RabiLink 1.0.5` AIX 上传到 Craft；上传和提审都需要账号所有者明确授权。
2. 审核通过后，在 Rokid AI App 智能体商店添加/更新 RabiLink，并确认智能体管理中可见。
3. 手机连接眼镜，启动 1.0.5 RabiLink AIUI；不要用 ADB 把 `.aix` 当 APK 安装。
4. 真实触摸板后滑到配置助手、前滑回连接对话。
5. 连续说话验证真实 ASR 与普通回复 TTS；再从 PC 主动投递一条无任务提醒，确认眼镜仍能收到并播报。
6. 让眼镜原生 Agent 以 `intent=读取配置` 调起配置助手，确认页面直接执行且没有页面内第二轮 ASR。
7. 核对左下时间、右下眼镜电量和充电状态。
8. 运行 `npm run runtime:proof`，再运行 `npm run goal:evidence`；只有 runtime proof 和所有外部阶段都通过，才把总目标标记为完成。
