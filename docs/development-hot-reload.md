<!-- docs-language-switch -->
<div align="center">
<a href="./development-hot-reload_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# RabiRoute 开发热重载

开发反馈和正式验收分开：

- WebGUI 使用 Vite HMR，入口为 `http://127.0.0.1:8793/`。
- RabiSpeech 可以显式使用 Uvicorn reload；启动前必须先停止占用 `8781` 的正式实例。
- Manager 不进入安全热重载循环。Manager 拥有 Route 子进程，重启会连带抖动 NapCat、RabiLink、个人微信和人格会话，可能使来源会话 token 失效。
- Android 原生代码不支持这套热重载，改动后仍要重新构建 APK。
- 功能定稿后仍必须完整构建、打包并更新已安装运行时，再做正式验收。

常用命令：

```powershell
# 仅 WebGUI，默认且安全
npm run dev:hot

# WebGUI + RabiSpeech；只在 8781 正式实例已经停止时使用
npm run dev:hot:speech

# 仅 RabiSpeech
npm run speech:dev

# Manager 只允许在隔离的数据目录/端口中人工启动
npm run manager:dev:isolated
```

`npm run dev:hot -- --check` 只检查本轮需要的端口，不启动服务。安全启动器拒绝 `--manager`，避免误把常驻消息端纳入文件监视重启。
