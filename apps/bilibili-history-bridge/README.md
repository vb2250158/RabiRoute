# RabiRoute Bilibili History Bridge

这是一个固定安装、只读的 Chrome Manifest V3 扩展。安装一次后，它会在后台向本机
RabiRoute Manager 领取历史读取任务，并使用 Chrome 中现有的 Bilibili 登录态调用：

`GET https://api.bilibili.com/x/web-interface/history/cursor`

## 安装

1. 打开 `chrome://extensions/`。
2. 开启“开发者模式”。
3. 选择“加载已解压的扩展程序”，指向本目录。

这三步只需执行一次。此后 Manager 可以创建任意日期窗口的任务，不需要再次点击
`RUN`、复制 Cookie 或逐次授权。Chrome/Bilibili 登录失效时仍需用户重新登录。

## Manager API

```text
POST /api/bilibili-history/jobs
GET  /api/bilibili-history/jobs/:jobId
GET  /api/bilibili-history/status
GET  /api/bilibili-history/roles/:roleId/days
GET  /api/bilibili-history/roles/:roleId/days/:date
```

创建任务示例：

```json
{
  "roleId": "Rabi",
  "since": "2025-07-01T00:00:00+08:00",
  "until": "2026-07-01T00:00:00+08:00"
}
```

扩展专用的 `/bridge/*` 接口仅允许本机访问并使用首次配对生成的随机 Bearer Token。
Token 保存在 Chrome `storage.local` 和 RabiRoute 私有 `data/` 运行目录，不进入仓库。

## 私有逐条记录与生命周期

- 创建任务必须指定 `roleId`。Manager 把窗口内每条记录写入该人格的
  `runtime/bilibili-history/daily/YYYY-MM-DD.jsonl`，不会写入全局运行状态。
- 日期文件是物理分卷，不表示归档、记忆沉淀或到期删除。逐条记录是私有事实真源，
  默认长期保留；删除需要单独、明确授权。
- 稳定身份由内容标识、业务类型和观看时间生成。分页重试或重叠窗口会更新同一条记录，
  不会重复追加。
- `index.json` 是可重建索引；日期文件先原子提交，随后重建索引。只读查询在内存中
  扫描日期文件，不会为了 GET 写盘；Manager 重启后，已提交日期文件仍可恢复。
- Manager 不自动把观看标题转成人格记忆。兴趣偏好只能从跨日稳定信号或用户确认后，
  通过正常记忆接口另行沉淀。

生命周期合同：

| 项目 | 当前约定 |
| --- | --- |
| 记录类型 | 私有原始事实；按日期物理分卷 |
| 稳定身份 | `business + 内容标识 + view_at` 的 SHA-256 |
| `activityAt` / 排序 | `view_at`；日文件内按观看时间倒序 |
| 热窗口 / 触发窗口 | 不适用；页面提交后立即按观看日期分卷，不自动归档、沉淀或过期 |
| 触发器 | 扩展提交一页成功响应时立即写入 |
| 候选范围 | 指定任务窗口内且 `view_at` 有效的每一条记录 |
| 目标与索引 | `daily/YYYY-MM-DD.jsonl`；`index.json` 可重建 |
| 幂等与并发 | 稳定 ID 合并；单 Manager 同步提交；临时文件原子重命名 |
| 原始记录保留 | 默认长期保留；未授权不删除、不自动过期 |
| 崩溃恢复 | 日文件先提交；页面重试再次按稳定 ID 合并；索引从日文件重建 |

## 隐私与停止条件

- 扩展不读取 Cookie API、Local Storage、密码或浏览器 Profile。
- Manager 的全局状态不持久化逐条标题、BVID、URL 或 Cookie；逐条数据只进入任务指定
  人格的私有日分卷，且永不保存 Cookie、Token 或未列入记录契约的响应字段。
- API `-101`（登录失效）或 `-412`（风控）会暂停任务，不自动紧密重试。
- 每页默认间隔 650ms；任务逐页保存游标，Manager 重启后可从断点继续。
