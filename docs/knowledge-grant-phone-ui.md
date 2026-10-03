# 旧知识授权页面迁移

[English](knowledge-grant-phone-ui_en.md) | 简体中文

从 0.3.22 起，RabiLink 同一应用中已鉴权的设备默认可以使用所选 PC 提供的知识工具和写入，原逐设备角色、工具与写权限编辑器已删除。

旧页面和 grant API 不再保存权限：当前 owner 请求返回 410 `KNOWLEDGE_GRANTS_RETIRED`；跨账号保持 404。旧 grant 历史保留但不用于访问决定。升级客户端不要再请求这些入口，统一使用现有设备鉴权、PC 选择及[知识请求接口](aiui-knowledge-relay.md)。本文件保留原路径供旧链接迁移；受支持客户端完成升级、旧入口调用清零后可移除该迁移页与 410 兼容响应。
