# 手机 / RabiLink

[English](README_en.md)

连接 RabiLink 手机及 Relay 消息。本包拥有配置卡片、入口、协议、消息处理和运行生命周期。宿主只提供路由、历史、配置及 API 监听器等通用端口。

换版时旧 Relay worker 停止领取新任务，并完成已生成结果的原回执。若 Relay 再次交付同一任务，同一 Gateway 进程内的新版可沿原任务编号确认回执。
