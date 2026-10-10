<!-- docs-language-switch -->
<div align="center"><a href="./desktop-pet-agent-motion_en.md">English</a> | 简体中文</div>
<!-- /docs-language-switch -->

# 桌宠移动接口

Agent 通过 Manager 指挥已启用的桌宠走路或传送，Qt Desktop 复用当前动作包和移动动画执行。无需开启闲逛；接口也不会修改闲逛开关、窗口焦点或应用窗口位置。

先从 Host 当前状态发现 Manager 地址，并按[Agent 接口](rabi-agent-interfaces.md)核验 `/meta` 的代际与实例身份。

`POST /api/desktop-pet/roles/:roleId/motion`，请求头 `Content-Type: application/json` 和 `Idempotency-Key`（与 `requestId` 相同）：

```json
{"requestId":"pet-move-0001","mode":"auto","target":{"kind":"active-window","corner":"bottom-right"}}
```

| 字段 | 合同 |
| --- | --- |
| `requestId` | 8–128 位 ASCII 标识，允许字母、数字、`_`、`.`、`-`，首位为字母或数字 |
| `mode` | 可省略，默认 `auto`；`walk` 强制走路，`teleport` 强制传送 |
| `target.kind=position` | `x`、`y` 为 Qt 逻辑桌面像素整数（不是物理像素），范围 ±100000，支持负坐标；目标须位于已连接屏幕，并按工作区边缘收敛以使整个桌宠可见 |
| `target.kind=screen-corner` | `corner` 指定屏幕角；可用 `screenName` 选择 Qt 屏幕名，否则使用桌宠当前屏幕 |
| `target.kind=active-window` | 在执行时读取激活窗口的可见边界与所属屏幕；只移动一次，不持续跟随 |
| `corner` | `bottom-right`、`bottom-left`、`top-right`、`top-left` |

坐标指桌宠窗口左上角。`auto` 沿用闲逛规则：同屏和不超过当前屏幕对角线的邻近跨屏目标走路，更远的跨屏目标传送。窗口角目标会缩进并限制在可用工作区内。

Desktop 在预载时测量渲染帧底部左右鞋底，以连续接地鞋底相对素材朝向的后移量标定整周期步长；鞋底前移、换支撑脚、静止帧和不可靠的跳变不计入标定。速度为周期步长除以实际播放周期时长，随显示大小及帧率上限变化。走路期间同一精确计时器驱动动画和连续位移，约每 16ms 更新位置，不再每换一帧跳动一次；延迟回调最多推进 50ms，动画和身体一起减速，不追赶到远处。GIF 保留原始帧时长，脚底高度按动画校正，不另加弹跳。无法测出有效步态时拒绝走路。

动作包根字段 `sourceFacing` 标记原始素材朝向（`left` 或 `right`，缺失/无效时兼容默认 `right`），由 Manager 校验并传给 Desktop。首次迈步前按目标方向决定是否镜像，向原始朝向行进时不翻转，抵达后保留朝向；不再用横向压扁模拟转身。

这是基于现有二维素材的步频与步长估算。正面踏步素材的左右镜像不等于侧面转身；任意斜向路径也不能保证支撑脚完全锁定在地面。严格无滑步需要对应方向的走路素材和足部接触标定。

查询 `GET /api/desktop-pet/roles/:roleId/motion/:requestId`，成功返回 `code=0`、`data` 回执：

- `accepted`：Manager 已接受，尚未由 Desktop 领取。
- `running`：Desktop 已领取，可能在准备动画或正在移动。
- `succeeded`：Desktop 报告抵达，包含实际 `position`、解析后的 `destination` 和 `travelKind`（`move` 或 `teleport`）。已经站在目标附近时可直接成功。
- `failed`：禁用、隐藏、锁定、拖动、已有移动、缺少动画、无法解析目标或 Desktop 未领取等失败。
- `cancelled`：移动被点击、拖动、隐藏、关闭或屏幕变更打断。
- `uncertain`：Desktop 领取后超过 30 秒没有抵达或实际移动进度确认，不能假定未移动。慢走期间只有位置确实变化，Desktop 才每五秒用当前 claim 续报 `running`；进度不等于抵达，停滞不会无限续期。

同一人格同时只接受一条 Agent 移动。显式移动可以唤醒睡眠，鼠标操作与隐藏/锁定仍优先；正在闲逛时返回失败，等待其结束再发新请求。动作包须具备走路 `move` 或传送 `teleport-out`、`teleport-in` 动画，准备时间最多 10 秒。

相同 ID 与相同参数只返回原回执，不重复移动；相同 ID 不同参数返回 `409`。受理返回 `202` 不代表抵达。请求结果不确定时先查询原 ID；禁止改 ID 自动重发。

回执只保留在当前 Manager 代际的内存中，终态保留一小时，最多 1000 条。重启、过期或切代后的 `404` 表示结果不可恢复，不能据此推断未移动。未领取超过 20 秒标为失败。Desktop 内部 claim/result 接口不开放给 Agent，回执不包含 claim token。
