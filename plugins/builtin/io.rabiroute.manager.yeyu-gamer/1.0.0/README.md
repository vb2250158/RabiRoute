<a href="./README_en.md">English</a> | 简体中文

# YeYu Gamer Manager 插件

该插件提供默认关闭的本机 YeYu Gamer 门面。目标固定为 `http://127.0.0.1:8877/api/v1`；只读 health、meta、snapshot、capabilities，并且只能创建 `mode: "plan"` 的 Agent work item。

插件配置归 Profile，不写入 `data/manager.json`。Bearer Token 只在读取受保护的 snapshot/capabilities 或创建 work item 时从本机 YeYu Gamer 运行目录读取，不进入 Profile、响应或日志。
