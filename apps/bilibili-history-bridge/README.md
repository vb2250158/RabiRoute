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
```

创建任务示例：

```json
{
  "since": "2025-07-01T00:00:00+08:00",
  "until": "2026-07-01T00:00:00+08:00"
}
```

扩展专用的 `/bridge/*` 接口仅允许本机访问并使用首次配对生成的随机 Bearer Token。
Token 保存在 Chrome `storage.local` 和 RabiRoute 私有 `data/` 运行目录，不进入仓库。

## 隐私与停止条件

- 扩展不读取 Cookie API、Local Storage、密码或浏览器 Profile。
- Manager 不持久化逐条标题、BVID、URL 或 Cookie，只保存游标、状态和聚合计数。
- API `-101`（登录失效）或 `-412`（风控）会暂停任务，不自动紧密重试。
- 每页默认间隔 650ms；任务逐页保存游标，Manager 重启后可从断点继续。
