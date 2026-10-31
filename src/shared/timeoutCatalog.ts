import type { TimeoutCatalogEntry } from "./timeoutSettings.js";

/** Configurable operation deadlines; dynamic plugin operations register with their owner. */
export const timeoutCatalog: readonly TimeoutCatalogEntry[] = [
  {
    "key": "agent.client.discovery",
    "defaultMs": 5000,
    "label": "Agent 发现与身份核验",
    "scope": "agent-client",
    "effect": "下一次操作；首次发现使用已验证缓存或默认值"
  },
  {
    "key": "agent.client.download",
    "defaultMs": 120000,
    "label": "Agent 下载",
    "scope": "agent-client",
    "effect": "下一次操作；首次发现使用已验证缓存或默认值"
  },
  {
    "key": "agent.client.localControl",
    "defaultMs": 15000,
    "label": "Agent 本机投递控制",
    "scope": "agent-client",
    "effect": "下一次操作；首次发现使用已验证缓存或默认值"
  },
  {
    "key": "agent.client.request",
    "defaultMs": 30000,
    "label": "Agent 请求",
    "scope": "agent-client",
    "effect": "下一次操作；首次发现使用已验证缓存或默认值"
  },
  {
    "key": "agent.client.send",
    "defaultMs": 1800000,
    "label": "Agent 发送",
    "scope": "agent-client",
    "effect": "下一次操作；首次发现使用已验证缓存或默认值"
  },
  {
    "key": "agent.client.upload",
    "defaultMs": 1800000,
    "label": "Agent 上传",
    "scope": "agent-client",
    "effect": "下一次操作；首次发现使用已验证缓存或默认值"
  },
  {
    "key": "agent.client.websocket",
    "defaultMs": 30000,
    "label": "远端CLI WebSocket观察预算",
    "scope": "remote-agent",
    "effect": "新CLI操作，显式--timeout-ms仍优先"
  },
  {
    "key": "agent.codex.catalog",
    "defaultMs": 8000,
    "label": "Codex 任务目录请求",
    "scope": "src/agentAdapters/managerApi.ts",
    "effect": "next-request"
  },
  {
    "key": "agent.codex.catalogIpc",
    "defaultMs": 1200,
    "label": "Codex 目录 IPC 请求",
    "scope": "src/agentAdapters/managerApi.ts",
    "effect": "next-request"
  },
  {
    "key": "agent.codex.hookRead",
    "defaultMs": 45000,
    "label": "Codex Hook 读取",
    "scope": "src/manager/controlPlaneRoutes.ts",
    "effect": "next-request"
  },
  {
    "key": "agent.codex.ipc",
    "defaultMs": 30000,
    "label": "Codex Desktop IPC 请求",
    "scope": "src/codexDesktopBridge.ts",
    "effect": "next-request"
  },
  {
    "key": "agent.codex.metadataMutation",
    "defaultMs": 180000,
    "label": "Codex 元数据写入",
    "scope": "src/codexAppServerClient.ts",
    "effect": "next-request"
  },
  {
    "key": "agent.codex.metadataRead",
    "defaultMs": 60000,
    "label": "Codex 元数据读取",
    "scope": "src/codexAppServerClient.ts",
    "effect": "next-request"
  },
  {
    "key": "agent.codex.models",
    "defaultMs": 8000,
    "label": "Codex 模型目录请求",
    "scope": "src/codexRuntime.ts",
    "effect": "next-request"
  },
  {
    "key": "agent.computer.process",
    "defaultMs": 30000,
    "label": "远端电脑操作进程",
    "scope": "remote-agent",
    "effect": "远端Agent身份核验更新缓存后；托盘下次启动/退出时读取已验证缓存"
  },
  {
    "key": "agent.connection.close",
    "defaultMs": 5000,
    "label": "远端连接关闭",
    "scope": "remote-agent",
    "effect": "远端Agent重新连接刷新缓存；新操作读取，已开始操作保持原预算"
  },
  {
    "key": "agent.copilot.command",
    "defaultMs": 600000,
    "label": "Copilot 命令执行",
    "scope": "src/copilotCli.ts",
    "effect": "next-request"
  },
  {
    "key": "agent.dependencies.install",
    "defaultMs": 120000,
    "label": "远端更新安装依赖",
    "scope": "remote-agent",
    "effect": "下一次连接器依赖安装或验证，使用已验证缓存"
  },
  {
    "key": "agent.dependencies.repair",
    "defaultMs": 20000,
    "label": "远端终端依赖修复",
    "scope": "remote-agent",
    "effect": "下一次连接器依赖安装或验证，使用已验证缓存"
  },
  {
    "key": "agent.dependencies.verify",
    "defaultMs": 5000,
    "label": "远端原生终端依赖验证",
    "scope": "remote-agent",
    "effect": "下一次连接器依赖安装或验证，使用已验证缓存"
  },
  {
    "key": "agent.desktop.ipc",
    "defaultMs": 30000,
    "label": "远端 Desktop IPC 请求",
    "scope": "remote-agent",
    "effect": "远端Agent身份核验更新缓存后；托盘下次启动/退出时读取已验证缓存"
  },
  {
    "key": "agent.deviceWait",
    "defaultMs": 12000,
    "label": "设备 Agent 等待结果",
    "scope": "src/agentAdapters/deviceAgentOwner.ts",
    "effect": "next-request"
  },
  {
    "key": "agent.dsh.connection",
    "defaultMs": 90000,
    "label": "DSH 连接管理请求",
    "scope": "src/manager/dshConnectionRoutes.ts",
    "effect": "next-request"
  },
  {
    "key": "agent.dsh.launch",
    "defaultMs": 10000,
    "label": "DSH 登录入口请求",
    "scope": "src/dshHttpAuth.ts",
    "effect": "next-request"
  },
  {
    "key": "agent.dsh.probe",
    "defaultMs": 10000,
    "label": "DSH 连接探测",
    "scope": "src/agentAdapters/managerApi.ts",
    "effect": "next-request"
  },
  {
    "key": "agent.dsh.recoveryConnect",
    "defaultMs": 12000,
    "label": "DSH 恢复连接",
    "scope": "src/dshOwnerRecovery.ts",
    "effect": "next-request"
  },
  {
    "key": "agent.dsh.recoveryProbe",
    "defaultMs": 2000,
    "label": "DSH 恢复探测",
    "scope": "src/dshOwnerRecovery.ts",
    "effect": "next-request"
  },
  {
    "key": "agent.dsh.recoverySessions",
    "defaultMs": 5000,
    "label": "DSH 恢复会话查询",
    "scope": "src/dshOwnerRecovery.ts",
    "effect": "next-request"
  },
  {
    "key": "agent.dsh.request",
    "defaultMs": 30000,
    "label": "DSH 认证请求",
    "scope": "src/dshHttpAuth.ts",
    "effect": "next-request"
  },
  {
    "key": "agent.dsh.verify",
    "defaultMs": 60000,
    "label": "DSH 凭据核验",
    "scope": "src/dshHttpAuth.ts",
    "effect": "next-request"
  },
  {
    "key": "agent.endpointProbe",
    "defaultMs": 1200,
    "label": "处理端连通性探测",
    "scope": "src/manager/controlPlaneRoutes.ts",
    "effect": "next-request"
  },
  {
    "key": "agent.grok.profile",
    "defaultMs": 30000,
    "label": "Grok 登录资料读取",
    "scope": "src/agentAdapters/grokBotClient.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "agent.grok.request",
    "defaultMs": 20000,
    "label": "Grok 接口请求",
    "scope": "src/agentAdapters/grokBotClient.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "agent.hookProbe",
    "defaultMs": 20000,
    "label": "Agent Hook 自检",
    "scope": "src/agentAdapters/hookInstallation.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "agent.launcher.command",
    "defaultMs": 12000,
    "label": "远端启动器命令",
    "scope": "remote-agent",
    "effect": "远端Agent重新连接刷新缓存；新操作读取，已开始操作保持原预算"
  },
  {
    "key": "agent.launcher.delivery",
    "defaultMs": 12000,
    "label": "远端启动器投递受理",
    "scope": "remote-agent",
    "effect": "远端Agent重新连接刷新缓存；新操作读取，已开始操作保持原预算"
  },
  {
    "key": "agent.launcher.handshake",
    "defaultMs": 10000,
    "label": "远端启动器握手",
    "scope": "remote-agent",
    "effect": "远端Agent重新连接刷新缓存；新操作读取，已开始操作保持原预算"
  },
  {
    "key": "agent.launcher.stop",
    "defaultMs": 5000,
    "label": "远端启动器退出",
    "scope": "remote-agent",
    "effect": "远端Agent重新连接刷新缓存；新操作读取，已开始操作保持原预算"
  },
  {
    "key": "agent.localMessage",
    "defaultMs": 45000,
    "label": "本机 Agent 消息进程",
    "scope": "src/manager/localAgentMessageProcess.ts",
    "effect": "next-request"
  },
  {
    "key": "agent.localMessageKillGrace",
    "defaultMs": 2000,
    "label": "本机 Agent 终止宽限",
    "scope": "src/manager/localAgentMessageProcess.ts",
    "effect": "next-request"
  },
  {
    "key": "agent.providerLogin",
    "defaultMs": 15000,
    "label": "处理端登录等待",
    "scope": "src/manager/agentProviderControlService.ts",
    "effect": "next-request"
  },
  {
    "key": "agent.release.request",
    "defaultMs": 30000,
    "label": "远端发行包请求",
    "scope": "remote-agent",
    "effect": "远端Agent重新连接刷新缓存；新操作读取，已开始操作保持原预算"
  },
  {
    "key": "agent.remote.acceptance",
    "defaultMs": 12000,
    "label": "远端 Agent 接受等待",
    "scope": "src/manager/lanAgentRegistry.ts",
    "effect": "next-request"
  },
  {
    "key": "agent.remote.authentication",
    "defaultMs": 10000,
    "label": "远端 Agent WebSocket 鉴权",
    "scope": "src/manager/lanAgentConnectionOperation.ts",
    "effect": "next-connection"
  },
  {
    "key": "agent.remote.closeGrace",
    "defaultMs": 2000,
    "label": "远端 Agent WebSocket 关闭宽限",
    "scope": "src/manager/lanAgentConnectionOperation.ts",
    "effect": "next-close"
  },
  {
    "key": "agent.remote.management",
    "defaultMs": 15000,
    "label": "远端 Agent 管理",
    "scope": "src/manager/lanAgentRegistry.ts",
    "effect": "next-request"
  },
  {
    "key": "agent.startup.command",
    "defaultMs": 10000,
    "label": "Agent：开机启动安装命令",
    "scope": "agent-client",
    "effect": "下次创建终端/执行操作读取对应Agent或手机的已验证配置缓存"
  },
  {
    "key": "agent.startup.serviceStop",
    "defaultMs": 10000,
    "label": "Agent：用户服务停止",
    "scope": "agent-client",
    "effect": "下次安装当前用户开机启动配置生效；重新生成systemd服务停止期限"
  },
  {
    "key": "agent.storageContract",
    "defaultMs": 12000,
    "label": "Agent存储操作指引预算",
    "scope": "src/shared/roleStorageMutationContract.ts",
    "effect": "next-operation"
  },
  {
    "key": "agent.terminal.forceClose",
    "defaultMs": 500,
    "label": "Agent：POSIX终端强制关闭等待",
    "scope": "agent-client",
    "effect": "下次创建终端/执行操作读取对应Agent或手机的已验证配置缓存"
  },
  {
    "key": "agent.terminal.nativeStop",
    "defaultMs": 5000,
    "label": "Agent：Windows终端进程退出",
    "scope": "agent-client",
    "effect": "下次创建终端/执行操作读取对应Agent或手机的已验证配置缓存"
  },
  {
    "key": "agent.terminal.processScan",
    "defaultMs": 2000,
    "label": "Agent：终端子进程查询",
    "scope": "agent-client",
    "effect": "下次创建终端/执行操作读取对应Agent或手机的已验证配置缓存"
  },
  {
    "key": "agent.terminal.start",
    "defaultMs": 30000,
    "label": "远端终端启动",
    "scope": "remote-agent",
    "effect": "远端Agent身份核验更新缓存后；托盘下次启动/退出时读取已验证缓存"
  },
  {
    "key": "agent.terminal.stop",
    "defaultMs": 3000,
    "label": "远端终端退出",
    "scope": "remote-agent",
    "effect": "远端Agent身份核验更新缓存后；托盘下次启动/退出时读取已验证缓存"
  },
  {
    "key": "agent.terminalWait",
    "defaultMs": 25000,
    "label": "远端终端长等待上限",
    "scope": "src/manager/lanAgentTerminals.ts",
    "effect": "next-request"
  },
  {
    "key": "agent.tray.start",
    "defaultMs": 15000,
    "label": "远端托盘启动",
    "scope": "remote-agent",
    "effect": "远端Agent身份核验更新缓存后；托盘下次启动/退出时读取已验证缓存"
  },
  {
    "key": "agent.tray.stop",
    "defaultMs": 3000,
    "label": "远端托盘退出",
    "scope": "remote-agent",
    "effect": "远端Agent身份核验更新缓存后；托盘下次启动/退出时读取已验证缓存"
  },
  {
    "key": "agent.update.candidate",
    "defaultMs": 30000,
    "label": "远端更新候选启动",
    "scope": "remote-agent",
    "effect": "远端Agent重新连接刷新缓存；新操作读取，已开始操作保持原预算"
  },
  {
    "key": "agent.update.commit",
    "defaultMs": 90000,
    "label": "远端更新提交",
    "scope": "remote-agent",
    "effect": "远端Agent重新连接刷新缓存；新操作读取，已开始操作保持原预算"
  },
  {
    "key": "agent.update.drain",
    "defaultMs": 30000,
    "label": "远端更新排空",
    "scope": "remote-agent",
    "effect": "远端Agent重新连接刷新缓存；新操作读取，已开始操作保持原预算"
  },
  {
    "key": "agent.update.exit",
    "defaultMs": 5000,
    "label": "远端更新候选退出",
    "scope": "remote-agent",
    "effect": "远端Agent重新连接刷新缓存；新操作读取，已开始操作保持原预算"
  },
  {
    "key": "agent.upload",
    "defaultMs": 1800000,
    "label": "Agent 文件上传",
    "scope": "src/manager/agentUploadRoutes.ts",
    "effect": "next-request"
  },
  {
    "key": "aiui.http.request",
    "defaultMs": 45000,
    "label": "眼镜通用 HTTP 请求",
    "scope": "AIUI",
    "effect": "设备profile刷新后，同一目标PC的后续请求；不同调用默认8/12/30/45秒均受覆盖控制"
  },
  {
    "key": "aiui.model.available",
    "defaultMs": 10000,
    "label": "眼镜：模型可用性检查",
    "scope": "mobile-client",
    "effect": "手机/眼镜收到对应PC配置并缓存后，下次操作生效；离线沿用该账户和PC缓存"
  },
  {
    "key": "aiui.model.configuration",
    "defaultMs": 15000,
    "label": "眼镜：模型配置理解",
    "scope": "mobile-client",
    "effect": "手机/眼镜收到对应PC配置并缓存后，下次操作生效；离线沿用该账户和PC缓存"
  },
  {
    "key": "aiui.model.create",
    "defaultMs": 15000,
    "label": "眼镜：模型会话创建",
    "scope": "mobile-client",
    "effect": "手机/眼镜收到对应PC配置并缓存后，下次操作生效；离线沿用该账户和PC缓存"
  },
  {
    "key": "aiui.model.probe",
    "defaultMs": 15000,
    "label": "眼镜：模型探测",
    "scope": "mobile-client",
    "effect": "下一次操作读取已验证连接缓存；未接收配置时使用原有默认值"
  },
  {
    "key": "aiui.model.request",
    "defaultMs": 30000,
    "label": "眼镜：模型单次响应",
    "scope": "mobile-client",
    "effect": "手机/眼镜收到对应PC配置并缓存后，下次操作生效；离线沿用该账户和PC缓存"
  },
  {
    "key": "aiui.model.turn",
    "defaultMs": 180000,
    "label": "眼镜：模型整轮处理",
    "scope": "mobile-client",
    "effect": "手机/眼镜收到对应PC配置并缓存后，下次操作生效；离线沿用该账户和PC缓存"
  },
  {
    "key": "aiui.phone.request",
    "defaultMs": 60000,
    "label": "眼镜手机桥 HTTP 请求",
    "scope": "AIUI",
    "effect": "设备profile刷新后，同一目标PC的后续手机桥请求"
  },
  {
    "key": "aiui.playback",
    "defaultMs": 800,
    "label": "眼镜：播放结束等待",
    "scope": "mobile-client",
    "effect": "下一次操作读取已验证连接缓存；未接收配置时使用原有默认值；未覆盖时默认随实际音频时长增加"
  },
  {
    "key": "android.audio.drain",
    "defaultMs": 10000,
    "label": "手机：录音持久化收尾",
    "scope": "mobile-client",
    "effect": "下一次操作读取已验证连接缓存；未接收配置时使用原有默认值"
  },
  {
    "key": "android.audio.stall",
    "defaultMs": 45000,
    "label": "手机：手机麦克风无数据",
    "scope": "mobile-client",
    "effect": "下一次操作读取已验证连接缓存；未接收配置时使用原有默认值"
  },
  {
    "key": "android.avatar.connect",
    "defaultMs": 10000,
    "label": "手机：头像下载连接",
    "scope": "mobile-client",
    "effect": "手机/眼镜收到对应PC配置并缓存后，下次操作生效；离线沿用该账户和PC缓存"
  },
  {
    "key": "android.avatar.read",
    "defaultMs": 20000,
    "label": "手机：头像下载读取",
    "scope": "mobile-client",
    "effect": "手机/眼镜收到对应PC配置并缓存后，下次操作生效；离线沿用该账户和PC缓存"
  },
  {
    "key": "android.device.wake",
    "defaultMs": 15000,
    "label": "手机：眼镜唤醒回执",
    "scope": "mobile-client",
    "effect": "手机/眼镜收到对应PC配置并缓存后，下次操作生效；离线沿用该账户和PC缓存"
  },
  {
    "key": "android.discovery.resolve",
    "defaultMs": 1500,
    "label": "手机：单地址解析",
    "scope": "mobile-client",
    "effect": "下次设备发现使用已验证当前账户/PC缓存；首次无缓存使用原默认值；scan未覆盖时随候选数计算"
  },
  {
    "key": "android.discovery.resolveTotal",
    "defaultMs": 6000,
    "label": "手机：地址解析总等待",
    "scope": "mobile-client",
    "effect": "下次设备发现使用已验证当前账户/PC缓存；首次无缓存使用原默认值；scan未覆盖时随候选数计算"
  },
  {
    "key": "android.discovery.scan",
    "defaultMs": 1500,
    "label": "手机：并行发现总等待",
    "scope": "mobile-client",
    "effect": "下次设备发现使用已验证当前账户/PC缓存；首次无缓存使用原默认值；scan未覆盖时随候选数计算"
  },
  {
    "key": "android.discovery.start",
    "defaultMs": 5000,
    "label": "手机：发现启动回执",
    "scope": "mobile-client",
    "effect": "下次设备发现使用已验证当前账户/PC缓存；首次无缓存使用原默认值；scan未覆盖时随候选数计算"
  },
  {
    "key": "android.discovery.stop",
    "defaultMs": 1500,
    "label": "手机：发现停止回执",
    "scope": "mobile-client",
    "effect": "下次设备发现使用已验证当前账户/PC缓存；首次无缓存使用原默认值；scan未覆盖时随候选数计算"
  },
  {
    "key": "android.discovery.window",
    "defaultMs": 1500,
    "label": "手机：DNS-SD发现窗口",
    "scope": "mobile-client",
    "effect": "下次设备发现使用已验证当前账户/PC缓存；首次无缓存使用原默认值；scan未覆盖时随候选数计算"
  },
  {
    "key": "android.glass.text",
    "defaultMs": 25000,
    "label": "手机：眼镜文字显示回执",
    "scope": "mobile-client",
    "effect": "手机/眼镜收到对应PC配置并缓存后，下次操作生效；离线沿用该账户和PC缓存"
  },
  {
    "key": "android.glass.videoStart",
    "defaultMs": 90000,
    "label": "手机：眼镜录像启动",
    "scope": "mobile-client",
    "effect": "手机/眼镜收到对应PC配置并缓存后，下次操作生效；离线沿用该账户和PC缓存"
  },
  {
    "key": "android.location.http",
    "defaultMs": 10000,
    "label": "手机：定位HTTP请求",
    "scope": "mobile-client",
    "effect": "手机/眼镜收到对应PC配置并缓存后，下次操作生效；离线沿用该账户和PC缓存"
  },
  {
    "key": "android.location.lookup",
    "defaultMs": 20000,
    "label": "手机：定位结果等待",
    "scope": "mobile-client",
    "effect": "手机/眼镜收到对应PC配置并缓存后，下次操作生效；离线沿用该账户和PC缓存"
  },
  {
    "key": "android.manager.identity",
    "defaultMs": 12000,
    "label": "手机 Manager 身份核验",
    "scope": "Android",
    "effect": "下一次身份核验，缓存按账号和目标PC隔离"
  },
  {
    "key": "android.manager.request",
    "defaultMs": 45000,
    "label": "手机 Manager 请求",
    "scope": "Android",
    "effect": "身份核验或首次连接后，后续请求使用缓存；重连或写操作刷新"
  },
  {
    "key": "android.phone.connect",
    "defaultMs": 5000,
    "label": "手机：眼镜桥接连接",
    "scope": "mobile-client",
    "effect": "手机/眼镜收到对应PC配置并缓存后，下次操作生效；离线沿用该账户和PC缓存"
  },
  {
    "key": "android.phone.incoming",
    "defaultMs": 15000,
    "label": "手机：眼镜桥接读取请求",
    "scope": "mobile-client",
    "effect": "下一次操作读取已验证连接缓存；未接收配置时使用原有默认值"
  },
  {
    "key": "android.phone.request",
    "defaultMs": 30000,
    "label": "手机：眼镜桥接请求",
    "scope": "mobile-client",
    "effect": "手机/眼镜收到对应PC配置并缓存后，下次操作生效；离线沿用该账户和PC缓存"
  },
  {
    "key": "android.preview.connect",
    "defaultMs": 12000,
    "label": "手机：语音预览连接",
    "scope": "mobile-client",
    "effect": "下一次操作读取已验证连接缓存；未接收配置时使用原有默认值"
  },
  {
    "key": "android.preview.request",
    "defaultMs": 70000,
    "label": "手机：语音预览请求",
    "scope": "mobile-client",
    "effect": "下一次操作读取已验证连接缓存；未接收配置时使用原有默认值"
  },
  {
    "key": "android.recording.archiveStop",
    "defaultMs": 5000,
    "label": "手机：录像归档退出",
    "scope": "mobile-client",
    "effect": "手机/眼镜收到对应PC配置并缓存后，下次操作生效；离线沿用该账户和PC缓存"
  },
  {
    "key": "android.recording.stop",
    "defaultMs": 10000,
    "label": "手机：录像进程退出",
    "scope": "mobile-client",
    "effect": "手机/眼镜收到对应PC配置并缓存后，下次操作生效；离线沿用该账户和PC缓存"
  },
  {
    "key": "android.relay.connect",
    "defaultMs": 15000,
    "label": "手机：Relay连接",
    "scope": "mobile-client",
    "effect": "下一次操作读取已验证连接缓存；未接收配置时使用原有默认值"
  },
  {
    "key": "android.relay.eventIdle",
    "defaultMs": 45000,
    "label": "手机：Relay事件流无数据",
    "scope": "mobile-client",
    "effect": "下一次操作读取已验证连接缓存；未接收配置时使用原有默认值"
  },
  {
    "key": "android.relay.request",
    "defaultMs": 20000,
    "label": "手机：Relay业务请求",
    "scope": "mobile-client",
    "effect": "下一次操作读取已验证连接缓存；未接收配置时使用原有默认值"
  },
  {
    "key": "android.sdk.connect",
    "defaultMs": 650,
    "label": "Android SDK 直连连接",
    "scope": "Android SDK",
    "effect": "直连Manager发现身份后，同一baseUrl请求生效；首次发现保留默认"
  },
  {
    "key": "android.sdk.read",
    "defaultMs": 650,
    "label": "Android SDK 直连读取",
    "scope": "Android SDK",
    "effect": "直连Manager发现身份后，同一baseUrl请求生效；首次发现保留默认"
  },
  {
    "key": "android.tunnel.close",
    "defaultMs": 1000,
    "label": "手机：隧道写入线程退出",
    "scope": "mobile-client",
    "effect": "下一次操作读取已验证连接缓存；未接收配置时使用原有默认值"
  },
  {
    "key": "android.tunnel.connect",
    "defaultMs": 5000,
    "label": "手机：隧道连接",
    "scope": "mobile-client",
    "effect": "手机/眼镜收到对应PC配置并缓存后，下次操作生效；离线沿用该账户和PC缓存"
  },
  {
    "key": "android.tunnel.handshake",
    "defaultMs": 5000,
    "label": "手机：隧道身份握手",
    "scope": "mobile-client",
    "effect": "手机/眼镜收到对应PC配置并缓存后，下次操作生效；离线沿用该账户和PC缓存"
  },
  {
    "key": "android.tunnel.ice",
    "defaultMs": 5000,
    "label": "手机：P2P地址收集",
    "scope": "mobile-client",
    "effect": "手机/眼镜收到对应PC配置并缓存后，下次操作生效；离线沿用该账户和PC缓存"
  },
  {
    "key": "android.tunnel.idle",
    "defaultMs": 65000,
    "label": "手机：Relay隧道无数据",
    "scope": "mobile-client",
    "effect": "下次创建终端/执行操作读取对应Agent或手机的已验证配置缓存"
  },
  {
    "key": "android.tunnel.lanConnect",
    "defaultMs": 700,
    "label": "手机：局域网隧道连接",
    "scope": "mobile-client",
    "effect": "手机/眼镜收到对应PC配置并缓存后，下次操作生效；离线沿用该账户和PC缓存"
  },
  {
    "key": "android.tunnel.lanDiscovery",
    "defaultMs": 2000,
    "label": "手机：局域网隧道发现",
    "scope": "mobile-client",
    "effect": "手机/眼镜收到对应PC配置并缓存后，下次操作生效；离线沿用该账户和PC缓存"
  },
  {
    "key": "android.tunnel.request",
    "defaultMs": 190000,
    "label": "手机：隧道请求",
    "scope": "mobile-client",
    "effect": "手机/眼镜收到对应PC配置并缓存后，下次操作生效；离线沿用该账户和PC缓存"
  },
  {
    "key": "android.tunnel.sdp",
    "defaultMs": 3000,
    "label": "手机：P2P会话描述",
    "scope": "mobile-client",
    "effect": "手机/眼镜收到对应PC配置并缓存后，下次操作生效；离线沿用该账户和PC缓存"
  },
  {
    "key": "android.tunnel.signal",
    "defaultMs": 15000,
    "label": "手机：隧道信令请求",
    "scope": "mobile-client",
    "effect": "手机/眼镜收到对应PC配置并缓存后，下次操作生效；离线沿用该账户和PC缓存"
  },
  {
    "key": "android.tunnel.stream",
    "defaultMs": 86400000,
    "label": "手机：隧道长流",
    "scope": "mobile-client",
    "effect": "手机/眼镜收到对应PC配置并缓存后，下次操作生效；离线沿用该账户和PC缓存"
  },
  {
    "key": "android.voice.audioAfterVideo",
    "defaultMs": 7000,
    "label": "手机：视频后音频握手",
    "scope": "mobile-client",
    "effect": "手机/眼镜收到对应PC配置并缓存后，下次操作生效；离线沿用该账户和PC缓存"
  },
  {
    "key": "android.voice.audioHandshake",
    "defaultMs": 5000,
    "label": "手机：原生音频握手",
    "scope": "mobile-client",
    "effect": "手机/眼镜收到对应PC配置并缓存后，下次操作生效；离线沿用该账户和PC缓存"
  },
  {
    "key": "android.voice.localPlayback",
    "defaultMs": 5000,
    "label": "手机：本机语音播放完成",
    "scope": "mobile-client",
    "effect": "下一次操作读取已验证连接缓存；未接收配置时使用原有默认值；未覆盖时默认随实际音频时长增加"
  },
  {
    "key": "android.voice.p2pProbe",
    "defaultMs": 15000,
    "label": "手机：原生P2P探测",
    "scope": "mobile-client",
    "effect": "手机/眼镜收到对应PC配置并缓存后，下次操作生效；离线沿用该账户和PC缓存"
  },
  {
    "key": "android.voice.playback",
    "defaultMs": 15000,
    "label": "手机：原生语音播放完成",
    "scope": "mobile-client",
    "effect": "手机/眼镜收到对应PC配置并缓存后，下次操作生效；离线沿用该账户和PC缓存；未覆盖时默认随实际音频时长增加"
  },
  {
    "key": "android.voice.stop",
    "defaultMs": 500,
    "label": "手机：录音线程退出",
    "scope": "mobile-client",
    "effect": "下一次操作读取已验证连接缓存；未接收配置时使用原有默认值"
  },
  {
    "key": "android.voice.systemInfo",
    "defaultMs": 5000,
    "label": "手机：原生系统信息",
    "scope": "mobile-client",
    "effect": "手机/眼镜收到对应PC配置并缓存后，下次操作生效；离线沿用该账户和PC缓存"
  },
  {
    "key": "android.voice.videoHandshake",
    "defaultMs": 10000,
    "label": "手机：原生视频握手",
    "scope": "mobile-client",
    "effect": "手机/眼镜收到对应PC配置并缓存后，下次操作生效；离线沿用该账户和PC缓存"
  },
  {
    "key": "api.contractCompile",
    "defaultMs": 1000,
    "label": "接口合同编译",
    "scope": "src/manager/managerPluginRouteRegistry.ts",
    "effect": "next-registration"
  },
  {
    "key": "backend.adapters.rabilinkRelayWorker.RELAY_WRITE_TIMEOUT_MS",
    "defaultMs": 5000,
    "label": "服务运行 · fetchRelayJsonReliably / RELAY_WRITE_TIMEOUT_MS",
    "scope": "src/adapters/rabilinkRelayWorker.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.agentAdapters.deviceAgentAdapter.createDeviceAgentAdapter.AbortSignal.timeout.request",
    "defaultMs": 15000,
    "label": "Agent 接口 · createDeviceAgentAdapter / request",
    "scope": "src/agentAdapters/deviceAgentAdapter.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.agentAdapters.hookInstallation.updateAgentHooks.execute.timeout",
    "defaultMs": 60000,
    "label": "Agent 接口 · updateAgentHooks / timeout",
    "scope": "src/agentAdapters/hookInstallation.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.agentAdapters.instanceClient.instanceRequest.AbortSignal.timeout.request",
    "defaultMs": 35000,
    "label": "Agent 接口 · instanceRequest / request",
    "scope": "src/agentAdapters/instanceClient.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.agentAdapters.lanAgentAdapter.notifyInstanceAgent.AbortSignal.timeout.request",
    "defaultMs": 15000,
    "label": "Agent 接口 · notifyInstanceAgent / request",
    "scope": "src/agentAdapters/lanAgentAdapter.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.agentAdapters.managerApi.detectCopilotBins.execFileAsync.timeout",
    "defaultMs": 2000,
    "label": "Agent 接口 · detectCopilotBins / timeout",
    "scope": "src/agentAdapters/managerApi.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.agentAdapters.managerApi.getCopilotStatus.execFileAsync.timeout",
    "defaultMs": 2000,
    "label": "Agent 接口 · getCopilotStatus / timeout",
    "scope": "src/agentAdapters/managerApi.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.agentAdapters.managerApi.scanAstrbotLocalDb.execFileAsync.timeout",
    "defaultMs": 3000,
    "label": "Agent 接口 · scanAstrbotLocalDb / timeout",
    "scope": "src/agentAdapters/managerApi.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.agentRequests.rolloutReceipt.readRolloutUserMessages.AbortSignal.timeout.request",
    "defaultMs": 30000,
    "label": "Agent 接口 · readRolloutUserMessages / request",
    "scope": "src/agentRequests/rolloutReceipt.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.agentRequests.store.owner.timeoutMs",
    "defaultMs": 60000,
    "label": "Agent 接口 · owner / timeoutMs",
    "scope": "src/agentRequests/store.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.antigravityBridge.DEFAULT_CONFIG_TIMEOUT_MS",
    "defaultMs": 15000,
    "label": "Agent 接口 · discoverAntigravityLsAddress / DEFAULT_CONFIG_TIMEOUT_MS",
    "scope": "src/antigravityBridge.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.antigravityBridge.DEFAULT_DELIVERY_TIMEOUT_MS",
    "defaultMs": 90000,
    "label": "Agent 接口 · runAgentApi / DEFAULT_DELIVERY_TIMEOUT_MS",
    "scope": "src/antigravityBridge.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.antigravityReceipt.DEFAULT_TIMEOUT_MS",
    "defaultMs": 8000,
    "label": "Agent 接口 · readAntigravityReceipt / DEFAULT_TIMEOUT_MS",
    "scope": "src/antigravityReceipt.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.antigravitySessionStore.probeHostViaProcessTable.execFileSync.timeout",
    "defaultMs": 5000,
    "label": "Agent 接口 · probeHostViaProcessTable / timeout",
    "scope": "src/antigravitySessionStore.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.antigravitySessionStore.READ_TIMEOUT_MS",
    "defaultMs": 10000,
    "label": "Agent 接口 · readAntigravitySessions / READ_TIMEOUT_MS",
    "scope": "src/antigravitySessionStore.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.codexDesktopBridge.owner.requestTimeoutMs",
    "defaultMs": 30000,
    "label": "Agent 接口 · owner / requestTimeoutMs",
    "scope": "src/codexDesktopBridge.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.feishu.sendFeishuText.AbortSignal.timeout.request",
    "defaultMs": 10000,
    "label": "消息平台 · sendFeishuText / request",
    "scope": "src/feishu.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.integrations.xiaomiHome.clipCapture.owner.Number.cameraClipRequestTimeoutMs",
    "defaultMs": 10000,
    "label": "家庭设备 · owner / cameraClipRequestTimeoutMs",
    "scope": "src/integrations/xiaomiHome/clipCapture.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.integrations.xiaomiHome.homeAssistantDeployment.ready.AbortSignal.timeout.request",
    "defaultMs": 3000,
    "label": "家庭设备 · ready / request",
    "scope": "src/integrations/xiaomiHome/homeAssistantDeployment.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.integrations.xiaomiHome.homeAssistantDeployment.run.runFile.timeout",
    "defaultMs": 30000,
    "label": "家庭设备 · run / timeout",
    "scope": "src/integrations/xiaomiHome/homeAssistantDeployment.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.integrations.xiaomiHome.homeAssistantOs.run.execute.timeout",
    "defaultMs": 1800000,
    "label": "家庭设备 · run / timeout",
    "scope": "src/integrations/xiaomiHome/homeAssistantOs.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.integrations.xiaomiHome.managerApi.resolveXiaomiHomeManagerConfig.Number.requestTimeoutMs",
    "defaultMs": 5000,
    "label": "家庭设备 · resolveXiaomiHomeManagerConfig / requestTimeoutMs",
    "scope": "src/integrations/xiaomiHome/managerApi.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.integrations.xiaomiHome.vacuumCloud.accountRequest.timeoutMs",
    "defaultMs": 12000,
    "label": "家庭设备 · accountRequest / timeoutMs",
    "scope": "src/integrations/xiaomiHome/vacuumCloud.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.integrations.xiaomiHome.vacuumCloud.call.AbortSignal.timeout.request",
    "defaultMs": 12000,
    "label": "家庭设备 · call / request",
    "scope": "src/integrations/xiaomiHome/vacuumCloud.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.integrations.xiaomiHome.vacuumCloud.pluginPackage.AbortSignal.timeout.request",
    "defaultMs": 30000,
    "label": "家庭设备 · pluginPackage / request",
    "scope": "src/integrations/xiaomiHome/vacuumCloud.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.integrations.xiaomiHome.vacuumCloud.readMap.AbortSignal.timeout.request",
    "defaultMs": 15000,
    "label": "家庭设备 · readMap / request",
    "scope": "src/integrations/xiaomiHome/vacuumCloud.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.integrations.xiaomiHome.vacuumCs2Relay.connect.timeoutMs",
    "defaultMs": 30000,
    "label": "家庭设备 · connect / timeoutMs",
    "scope": "src/integrations/xiaomiHome/vacuumCs2Relay.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.integrations.xiaomiHome.vacuumCs2Relay.connectLocal.timeoutMs",
    "defaultMs": 3000,
    "label": "家庭设备 · connectLocal / timeoutMs",
    "scope": "src/integrations/xiaomiHome/vacuumCs2Relay.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.integrations.xiaomiHome.vacuumVideo.connect.AbortSignal.timeout.request",
    "defaultMs": 1000,
    "label": "家庭设备 · connect / request",
    "scope": "src/integrations/xiaomiHome/vacuumVideo.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.integrations.xiaomiHome.vacuumVideo.openStream.AbortSignal.timeout.request",
    "defaultMs": 25000,
    "label": "家庭设备 · openStream / request",
    "scope": "src/integrations/xiaomiHome/vacuumVideo.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.integrations.yeyuGamer.managerApi.normalizeYeYuGamerManagerConfig.requestTimeoutMs",
    "defaultMs": 3000,
    "label": "服务运行 · normalizeYeYuGamerManagerConfig / requestTimeoutMs",
    "scope": "src/integrations/yeyuGamer/managerApi.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.linuxProcessLease.acquireLinuxProcessLease.spawnSync.timeout",
    "defaultMs": 5000,
    "label": "服务运行 · acquireLinuxProcessLease / timeout",
    "scope": "src/linuxProcessLease.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.agentAdapterCatalogWorkerPool.owner.Math.floor.timeoutMs",
    "defaultMs": 300000,
    "label": "Agent 接口 · owner / timeoutMs",
    "scope": "src/manager/agentAdapterCatalogWorkerPool.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.agentCompletionDelivery.completionProjectIdentity.execute.timeout",
    "defaultMs": 5000,
    "label": "Agent 接口 · completionProjectIdentity / timeout",
    "scope": "src/manager/agentCompletionDelivery.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.agentDeliveryAccountIdentity.DEADLINE_MS",
    "defaultMs": 3000,
    "label": "Agent 接口 · readQqVerificationAccountIdentity / DEADLINE_MS",
    "scope": "src/manager/agentDeliveryAccountIdentity.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.agentProviderControlService.install.execFile.timeout",
    "defaultMs": 120000,
    "label": "Agent 接口 · install / timeout",
    "scope": "src/manager/agentProviderControlService.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.agentProviderControlService.locateCopilot.execFileAsync.timeout",
    "defaultMs": 2000,
    "label": "Agent 接口 · locateCopilot / timeout",
    "scope": "src/manager/agentProviderControlService.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.allDayRecordingRoutes.audio.requestLocalSpeech.timeoutMs",
    "defaultMs": 15000,
    "label": "服务运行 · audio / timeoutMs",
    "scope": "src/manager/allDayRecordingRoutes.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.allDayRecordingRoutes.audioFile.requestLocalSpeech.timeoutMs",
    "defaultMs": 15000,
    "label": "服务运行 · audioFile / timeoutMs",
    "scope": "src/manager/allDayRecordingRoutes.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.allDayRecordingRoutes.createAllDayRecording.timeoutMs",
    "defaultMs": 600000,
    "label": "服务运行 · createAllDayRecording / timeoutMs",
    "scope": "src/manager/allDayRecordingRoutes.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.allDayRecordingRoutes.run.managerKnowledgePageWorkerPool.run.timeoutMs",
    "defaultMs": 60000,
    "label": "服务运行 · run / timeoutMs",
    "scope": "src/manager/allDayRecordingRoutes.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.allDayRecordingRoutes.speech.requestLocalSpeechJson.timeoutMs",
    "defaultMs": 30000,
    "label": "服务运行 · speech / timeoutMs",
    "scope": "src/manager/allDayRecordingRoutes.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.configWatchSnapshot.collectWatchedConfigFiles.Math.max.timeoutMs",
    "defaultMs": 1500,
    "label": "服务运行 · collectWatchedConfigFiles / timeoutMs",
    "scope": "src/manager/configWatchSnapshot.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.configWatchSnapshot.configFilesSnapshot.timeoutMs",
    "defaultMs": 1500,
    "label": "服务运行 · configFilesSnapshot / timeoutMs",
    "scope": "src/manager/configWatchSnapshot.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.controlPlaneRoutes.activeGatewayDiagnosticsSnapshotService.timeoutMs",
    "defaultMs": 60000,
    "label": "服务运行 · activeGatewayDiagnosticsSnapshotService / timeoutMs",
    "scope": "src/manager/controlPlaneRoutes.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.controlPlaneRoutes.cancelSpeech.requestLocalSpeechJson.timeoutMs",
    "defaultMs": 5000,
    "label": "服务运行 · cancelSpeech / timeoutMs",
    "scope": "src/manager/controlPlaneRoutes.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.controlPlaneRoutes.currentPlanFeedback.application.queries.planFeedback.timeoutMs",
    "defaultMs": 30000,
    "label": "服务运行 · currentPlanFeedback / timeoutMs",
    "scope": "src/manager/controlPlaneRoutes.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.controlPlaneRoutes.evaluate.evaluateMemoryConsolidationSchedule.timeoutMs",
    "defaultMs": 30000,
    "label": "服务运行 · evaluate / timeoutMs",
    "scope": "src/manager/controlPlaneRoutes.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.controlPlaneRoutes.load.managerReadWorkerPool.run.timeoutMs",
    "defaultMs": 12000,
    "label": "服务运行 · load / timeoutMs",
    "scope": "src/manager/controlPlaneRoutes.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.controlPlaneRoutes.NAPCAT_HEALTH_SCAN_DEADLINE_MS",
    "defaultMs": 6500,
    "label": "服务运行 · napcatScanHealthPayload / NAPCAT_HEALTH_SCAN_DEADLINE_MS",
    "scope": "src/manager/controlPlaneRoutes.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.controlPlaneRoutes.onSuccess.currentRoleStorageApplication__.commands.markMemoryConsolidationDelivered.timeoutMs",
    "defaultMs": 30000,
    "label": "服务运行 · onSuccess / timeoutMs",
    "scope": "src/manager/controlPlaneRoutes.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.controlPlaneRoutes.planFeedbackMutationContext.timeoutMs",
    "defaultMs": 30000,
    "label": "服务运行 · planFeedbackMutationContext / timeoutMs",
    "scope": "src/manager/controlPlaneRoutes.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.controlPlaneRoutes.prewarmRolePlanCatalogs.managerCatalogWorkerPool.queryRoleKnowledgeCatalogSnapshot.timeoutMs",
    "defaultMs": 300000,
    "label": "服务运行 · prewarmRolePlanCatalogs / timeoutMs",
    "scope": "src/manager/controlPlaneRoutes.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.controlPlaneRoutes.prewarmRolePlanCatalogs.managerCatalogWorkerPool.run.timeoutMs",
    "defaultMs": 30000,
    "label": "服务运行 · prewarmRolePlanCatalogs / timeoutMs",
    "scope": "src/manager/controlPlaneRoutes.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.controlPlaneRoutes.query.application.queries.planFeedback.timeoutMs",
    "defaultMs": 30000,
    "label": "服务运行 · query / timeoutMs",
    "scope": "src/manager/controlPlaneRoutes.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.controlPlaneRoutes.rabiLinkRequestLocal.AbortSignal.timeout.request",
    "defaultMs": 30000,
    "label": "服务运行 · rabiLinkRequestLocal / request",
    "scope": "src/manager/controlPlaneRoutes.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.controlPlaneRoutes.readAccountIdentity.getLoginInfo.timeoutMs",
    "defaultMs": 2000,
    "label": "服务运行 · readAccountIdentity / timeoutMs",
    "scope": "src/manager/controlPlaneRoutes.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.controlPlaneRoutes.readConnections.AbortSignal.timeout.request",
    "defaultMs": 5000,
    "label": "服务运行 · readConnections / request",
    "scope": "src/manager/controlPlaneRoutes.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.controlPlaneRoutes.readDelta.managerCatalogWorkerPool.run.timeoutMs",
    "defaultMs": 300000,
    "label": "服务运行 · readDelta / timeoutMs",
    "scope": "src/manager/controlPlaneRoutes.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.controlPlaneRoutes.readTarget.AbortSignal.timeout.request",
    "defaultMs": 30000,
    "label": "服务运行 · readTarget / request",
    "scope": "src/manager/controlPlaneRoutes.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.controlPlaneRoutes.reconcilePersistedPlanSecretaryWorkspaces.currentRoleStorageApplication__.commands.updatePlanSecretaryBinding.timeoutMs",
    "defaultMs": 30000,
    "label": "服务运行 · reconcilePersistedPlanSecretaryWorkspaces / timeoutMs",
    "scope": "src/manager/controlPlaneRoutes.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.controlPlaneRoutes.reconcilePersistedPlanSecretaryWorkspaces.currentRoleStorageApplication__.queries.plan.timeoutMs",
    "defaultMs": 30000,
    "label": "服务运行 · reconcilePersistedPlanSecretaryWorkspaces / timeoutMs",
    "scope": "src/manager/controlPlaneRoutes.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.controlPlaneRoutes.reconcilePersistedPlanSecretaryWorkspaces.currentRoleStorageApplication__.queries.recaptureCatalog.timeoutMs",
    "defaultMs": 30000,
    "label": "服务运行 · reconcilePersistedPlanSecretaryWorkspaces / timeoutMs",
    "scope": "src/manager/controlPlaneRoutes.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.controlPlaneRoutes.request.operationTimeoutMs",
    "defaultMs": 1500,
    "label": "服务运行 · request / operationTimeoutMs",
    "scope": "src/manager/controlPlaneRoutes.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.controlPlaneRoutes.requestDeviceAgentPeerApi.AbortSignal.timeout.request",
    "defaultMs": 30000,
    "label": "服务运行 · requestDeviceAgentPeerApi / request",
    "scope": "src/manager/controlPlaneRoutes.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.controlPlaneRoutes.requestDueRun.currentRoleStorageApplication__.commands.requestMemoryConsolidation.timeoutMs",
    "defaultMs": 30000,
    "label": "服务运行 · requestDueRun / timeoutMs",
    "scope": "src/manager/controlPlaneRoutes.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.controlPlaneRoutes.requestRoleKnowledgeCatalogRefresh.managerCatalogWorkerPool.queryRoleKnowledgeCatalogSnapshot.timeoutMs",
    "defaultMs": 300000,
    "label": "服务运行 · requestRoleKnowledgeCatalogRefresh / timeoutMs",
    "scope": "src/manager/controlPlaneRoutes.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.controlPlaneRoutes.resolvePlanSecretaryDeliveryTarget.currentRoleStorageApplication__.queries.plan.timeoutMs",
    "defaultMs": 30000,
    "label": "服务运行 · resolvePlanSecretaryDeliveryTarget / timeoutMs",
    "scope": "src/manager/controlPlaneRoutes.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.controlPlaneRoutes.sendPlanFeedbackToTask.currentRoleStorageApplication__.queries.plan.timeoutMs",
    "defaultMs": 30000,
    "label": "服务运行 · sendPlanFeedbackToTask / timeoutMs",
    "scope": "src/manager/controlPlaneRoutes.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.controlPlaneRoutes.speak.requestLocalSpeech.timeoutMs",
    "defaultMs": 120000,
    "label": "服务运行 · speak / timeoutMs",
    "scope": "src/manager/controlPlaneRoutes.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.controlPlaneRoutes.submitAgentPlanFeedback.application.commands.submitPlanFeedback.timeoutMs",
    "defaultMs": 30000,
    "label": "服务运行 · submitAgentPlanFeedback / timeoutMs",
    "scope": "src/manager/controlPlaneRoutes.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.controlPlaneRoutes.submitAgentPlanFeedback.application.queries.planFeedback.timeoutMs",
    "defaultMs": 30000,
    "label": "服务运行 · submitAgentPlanFeedback / timeoutMs",
    "scope": "src/manager/controlPlaneRoutes.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.controlPlaneRoutes.waitForGatewayChildExit.timeoutMs",
    "defaultMs": 5000,
    "label": "服务运行 · waitForGatewayChildExit / timeoutMs",
    "scope": "src/manager/controlPlaneRoutes.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.deviceIdentity.readOsMachineIdentity.execFileSync.timeout",
    "defaultMs": 5000,
    "label": "服务运行 · readOsMachineIdentity / timeout",
    "scope": "src/manager/deviceIdentity.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.durableDeliveryIdempotency.RECEIPT_HEARTBEAT_WAIT_TIMEOUT_MS",
    "defaultMs": 10000,
    "label": "服务运行 · waitForReceiptHeartbeatTransition / RECEIPT_HEARTBEAT_WAIT_TIMEOUT_MS",
    "scope": "src/manager/durableDeliveryIdempotency.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.durableDeliveryIdempotency.withReceiptMutationLock.withFileLockSync.timeoutMs",
    "defaultMs": 1000,
    "label": "服务运行 · withReceiptMutationLock / timeoutMs",
    "scope": "src/manager/durableDeliveryIdempotency.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.gatewayDiagnosticsSnapshot.owner.Math.floor.timeoutMs",
    "defaultMs": 30000,
    "label": "服务运行 · owner / timeoutMs",
    "scope": "src/manager/gatewayDiagnosticsSnapshot.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.identityResetRoutes.enqueue.execFile.timeout",
    "defaultMs": 15000,
    "label": "服务运行 · enqueue / timeout",
    "scope": "src/manager/identityResetRoutes.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.managerLanDiscoveryConsumer.verifyManagerDiscoveryEndpoint.fetchWellKnownJson.timeoutMs",
    "defaultMs": 3000,
    "label": "服务运行 · verifyManagerDiscoveryEndpoint / timeoutMs",
    "scope": "src/manager/managerLanDiscoveryConsumer.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.managerPluginRequestTracker.owner.drainTimeoutMs",
    "defaultMs": 30000,
    "label": "服务运行 · owner / drainTimeoutMs",
    "scope": "src/manager/managerPluginRequestTracker.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.managerReadWorkerPool.createPlanPageCatalogService.buildTimeoutMs",
    "defaultMs": 300000,
    "label": "服务运行 · createPlanPageCatalogService / buildTimeoutMs",
    "scope": "src/manager/managerReadWorkerPool.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.managerReadWorkerPool.owner.Math.floor.timeoutMs",
    "defaultMs": 30000,
    "label": "服务运行 · owner / timeoutMs",
    "scope": "src/manager/managerReadWorkerPool.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.managerReadWorkerPool.prepare.pool.run.timeoutMs",
    "defaultMs": 300000,
    "label": "服务运行 · prepare / timeoutMs",
    "scope": "src/manager/managerReadWorkerPool.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.managerRuntimeOwner.DEFAULT_MANAGER_RUNTIME_TEARDOWN_TIMEOUT_MS",
    "defaultMs": 120000,
    "label": "服务运行 · owner / DEFAULT_MANAGER_RUNTIME_TEARDOWN_TIMEOUT_MS",
    "scope": "src/manager/managerRuntimeOwner.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.managerWatchBroker.owner.Math.max.attemptTimeoutMs",
    "defaultMs": 30000,
    "label": "服务运行 · owner / attemptTimeoutMs",
    "scope": "src/manager/managerWatchBroker.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.managerWatchBroker.owner.Math.max.forceTerminationCloseTimeoutMs",
    "defaultMs": 1000,
    "label": "服务运行 · owner / forceTerminationCloseTimeoutMs",
    "scope": "src/manager/managerWatchBroker.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.managerWatchBroker.owner.Math.max.terminationCloseTimeoutMs",
    "defaultMs": 250,
    "label": "服务运行 · owner / terminationCloseTimeoutMs",
    "scope": "src/manager/managerWatchBroker.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.managerWatchBrokerWorker.configSnapshot.Math.max.operationTimeoutMs",
    "defaultMs": 1500,
    "label": "服务运行 · configSnapshot / operationTimeoutMs",
    "scope": "src/manager/managerWatchBrokerWorker.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.managerWatchBrokerWorker.pluginTreeSnapshot.Math.max.operationTimeoutMs",
    "defaultMs": 1500,
    "label": "服务运行 · pluginTreeSnapshot / operationTimeoutMs",
    "scope": "src/manager/managerWatchBrokerWorker.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.messageAdapterControl.MESSAGE_ADAPTER_SCAN_DEADLINE_MS",
    "defaultMs": 6000,
    "label": "服务运行 · owner / MESSAGE_ADAPTER_SCAN_DEADLINE_MS",
    "scope": "src/manager/messageAdapterControl.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.napcatProcessDriver.napcatProcessSnapshot.execute.timeout",
    "defaultMs": 60000,
    "label": "消息平台 · napcatProcessSnapshot / timeout",
    "scope": "src/manager/napcatProcessDriver.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.napcatProcessDriver.requestExit.execute.timeout",
    "defaultMs": 5000,
    "label": "消息平台 · requestExit / timeout",
    "scope": "src/manager/napcatProcessDriver.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.planAgentStatus.PLAN_AGENT_STATUS_TIMEOUT_MS",
    "defaultMs": 2800,
    "label": "Agent 接口 · timeoutMs / PLAN_AGENT_STATUS_TIMEOUT_MS",
    "scope": "src/manager/planAgentStatus.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.planAgentStatus.PLAN_DSH_AGENT_STATUS_TIMEOUT_MS",
    "defaultMs": 10000,
    "label": "Agent 接口 · timeoutMs / PLAN_DSH_AGENT_STATUS_TIMEOUT_MS",
    "scope": "src/manager/planAgentStatus.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.planBindingStorageMutation.QUERY_TIMEOUT_MS",
    "defaultMs": 30000,
    "label": "服务运行 · replacePlanSecretaryBindingForEvent / QUERY_TIMEOUT_MS",
    "scope": "src/manager/planBindingStorageMutation.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.planFeedbackRecoveryService.owner.Math.max.attemptTimeoutMs",
    "defaultMs": 300000,
    "label": "服务运行 · owner / attemptTimeoutMs",
    "scope": "src/manager/planFeedbackRecoveryService.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.planQaFeedback.consumePlanQaFeedback.options.storage.query.timeoutMs",
    "defaultMs": 30000,
    "label": "服务运行 · consumePlanQaFeedback / timeoutMs",
    "scope": "src/manager/planQaFeedback.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.planQaFeedback.mutationContext.timeoutMs",
    "defaultMs": 30000,
    "label": "服务运行 · mutationContext / timeoutMs",
    "scope": "src/manager/planQaFeedback.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.progressivePlanStorageStartup.attempt.batchTimeoutMs",
    "defaultMs": 150000,
    "label": "服务运行 · attempt / batchTimeoutMs",
    "scope": "src/manager/progressivePlanStorageStartup.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.progressivePlanStorageStartup.attempt.itemTimeoutMs",
    "defaultMs": 60000,
    "label": "服务运行 · attempt / itemTimeoutMs",
    "scope": "src/manager/progressivePlanStorageStartup.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.rabiLinkHome.DEADLINE_MS",
    "defaultMs": 3000,
    "label": "服务运行 · readRabiLinkHome / DEADLINE_MS",
    "scope": "src/manager/rabiLinkHome.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.rabiLinkRelayRuntime.DEFAULT_LOCAL_REQUEST_TIMEOUT_MS",
    "defaultMs": 5000,
    "label": "服务运行 · owner / DEFAULT_LOCAL_REQUEST_TIMEOUT_MS",
    "scope": "src/manager/rabiLinkRelayRuntime.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.rabiLinkRelayRuntime.DEFAULT_LOCAL_SPEECH_REQUEST_TIMEOUT_MS",
    "defaultMs": 180000,
    "label": "服务运行 · owner / DEFAULT_LOCAL_SPEECH_REQUEST_TIMEOUT_MS",
    "scope": "src/manager/rabiLinkRelayRuntime.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.rabiLinkRelayRuntime.DEFAULT_RELAY_WRITE_TIMEOUT_MS",
    "defaultMs": 5000,
    "label": "服务运行 · owner / DEFAULT_RELAY_WRITE_TIMEOUT_MS",
    "scope": "src/manager/rabiLinkRelayRuntime.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.rabiLinkRelayRuntime.probeSpeechAdvertisement.AbortSignal.timeout.request",
    "defaultMs": 3000,
    "label": "服务运行 · probeSpeechAdvertisement / request",
    "scope": "src/manager/rabiLinkRelayRuntime.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.recordingArchiveAsrRuntime.compute.requestLocalSpeech.timeoutMs",
    "defaultMs": 190000,
    "label": "服务运行 · compute / timeoutMs",
    "scope": "src/manager/recordingArchiveAsrRuntime.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.recordingArchiveAsrRuntime.readJson.requestLocalSpeechJson.timeoutMs",
    "defaultMs": 15000,
    "label": "服务运行 · readJson / timeoutMs",
    "scope": "src/manager/recordingArchiveAsrRuntime.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.remotePersonaRoutes.resolveRemotePersonaSnapshot.AbortSignal.timeout.request",
    "defaultMs": 20000,
    "label": "服务运行 · resolveRemotePersonaSnapshot / request",
    "scope": "src/manager/remotePersonaRoutes.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.remotePersonaRoutes.validateRemotePersonaLanguageStyle.AbortSignal.timeout.request",
    "defaultMs": 20000,
    "label": "服务运行 · validateRemotePersonaLanguageStyle / request",
    "scope": "src/manager/remotePersonaRoutes.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.speechModelSettings.validateModelRoot.execFileSync.timeout",
    "defaultMs": 5000,
    "label": "语音服务 · validateModelRoot / timeout",
    "scope": "src/manager/speechModelSettings.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.speechRuntimeControl.inspectWindowsRuntimeOwner.execFileAsync.timeout",
    "defaultMs": 8000,
    "label": "语音服务 · inspectWindowsRuntimeOwner / timeout",
    "scope": "src/manager/speechRuntimeControl.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.speechRuntimeControl.killWindowsProcessTree.execFileAsync.timeout",
    "defaultMs": 8000,
    "label": "语音服务 · killWindowsProcessTree / timeout",
    "scope": "src/manager/speechRuntimeControl.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.speechRuntimeControl.owner.startTimeoutMs",
    "defaultMs": 120000,
    "label": "语音服务 · owner / startTimeoutMs",
    "scope": "src/manager/speechRuntimeControl.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.speechRuntimeControl.owner.stopTimeoutMs",
    "defaultMs": 15000,
    "label": "语音服务 · owner / stopTimeoutMs",
    "scope": "src/manager/speechRuntimeControl.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.storageStartupProcess.createStorageStartupProcess.terminateTimeoutMs",
    "defaultMs": 5000,
    "label": "服务运行 · createStorageStartupProcess / terminateTimeoutMs",
    "scope": "src/manager/storageStartupProcess.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.videoRuntime.validateLocalModelRoot.promisify_execFile_.timeout",
    "defaultMs": 5000,
    "label": "服务运行 · validateLocalModelRoot / timeout",
    "scope": "src/manager/videoRuntime.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.manager.wearableCompanionWorkerService.DEFAULT_HANDOFF_TIMEOUT_MS",
    "defaultMs": 15000,
    "label": "服务运行 · owner / DEFAULT_HANDOFF_TIMEOUT_MS",
    "scope": "src/manager/wearableCompanionWorkerService.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.markdownImage.pageWebSocketUrl.AbortSignal.timeout.request",
    "defaultMs": 1000,
    "label": "服务运行 · pageWebSocketUrl / request",
    "scope": "src/markdownImage.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.messageAgentPool.requestMessageAgentManager.timeoutMs",
    "defaultMs": 30000,
    "label": "Agent 接口 · requestMessageAgentManager / timeoutMs",
    "scope": "src/messageAgentPool.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.messageContextStore.LOCK_TIMEOUT_MS",
    "defaultMs": 5000,
    "label": "服务运行 · acquireLock / LOCK_TIMEOUT_MS",
    "scope": "src/messageContextStore.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.messageEndpoints.napcatManager.detectNapcatProcesses.execFileAsync.timeout",
    "defaultMs": 3000,
    "label": "消息平台 · detectNapcatProcesses / timeout",
    "scope": "src/messageEndpoints/napcatManager.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.messageEndpoints.napcatManager.fetchNapcatOneBotAction.timeoutMs",
    "defaultMs": 1500,
    "label": "消息平台 · fetchNapcatOneBotAction / timeoutMs",
    "scope": "src/messageEndpoints/napcatManager.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.messageEndpoints.napcatManager.listeningPidsForPorts.execFileAsync.timeout",
    "defaultMs": 3000,
    "label": "消息平台 · listeningPidsForPorts / timeout",
    "scope": "src/messageEndpoints/napcatManager.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.messageEndpoints.napcatManager.napcatHttpOk.timeoutMs",
    "defaultMs": 4000,
    "label": "消息平台 · napcatHttpOk / timeoutMs",
    "scope": "src/messageEndpoints/napcatManager.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.messageEndpoints.napcatManager.napcatStatusEndpointOk.timeoutMs",
    "defaultMs": 3000,
    "label": "消息平台 · napcatStatusEndpointOk / timeoutMs",
    "scope": "src/messageEndpoints/napcatManager.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.messageEndpoints.napcatManager.recheckNapcatUntilReady.timeoutMs",
    "defaultMs": 30000,
    "label": "消息平台 · recheckNapcatUntilReady / timeoutMs",
    "scope": "src/messageEndpoints/napcatManager.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.messageEndpoints.napcatManager.requestNapcatBotExit.AbortSignal.timeout.request",
    "defaultMs": 2500,
    "label": "消息平台 · requestNapcatBotExit / request",
    "scope": "src/messageEndpoints/napcatManager.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.messageEndpoints.napcatManager.waitForNapcatReady.timeoutMs",
    "defaultMs": 35000,
    "label": "消息平台 · waitForNapcatReady / timeoutMs",
    "scope": "src/messageEndpoints/napcatManager.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.messageEndpoints.napcatManager.waitForPortsReleased.timeoutMs",
    "defaultMs": 3000,
    "label": "消息平台 · waitForPortsReleased / timeoutMs",
    "scope": "src/messageEndpoints/napcatManager.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.messageEndpoints.napcatManager.windowsNapcatParentPids.execFileAsync.timeout",
    "defaultMs": 5000,
    "label": "消息平台 · windowsNapcatParentPids / timeout",
    "scope": "src/messageEndpoints/napcatManager.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.messageEndpoints.napcatManager.windowsNapcatPidsForBotUserId.execFileAsync.timeout",
    "defaultMs": 5000,
    "label": "消息平台 · windowsNapcatPidsForBotUserId / timeout",
    "scope": "src/messageEndpoints/napcatManager.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.messageEndpoints.napcatManager.windowsPidsForCommandLineNeedle.execFileAsync.timeout",
    "defaultMs": 5000,
    "label": "消息平台 · windowsPidsForCommandLineNeedle / timeout",
    "scope": "src/messageEndpoints/napcatManager.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.messageEndpoints.napcatWebuiSession.authorize.AbortSignal.timeout.request",
    "defaultMs": 5000,
    "label": "消息平台 · authorize / request",
    "scope": "src/messageEndpoints/napcatWebuiSession.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.messageEndpoints.napcatWebuiSession.request.AbortSignal.timeout.request",
    "defaultMs": 5000,
    "label": "消息平台 · request / request",
    "scope": "src/messageEndpoints/napcatWebuiSession.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.messageEndpoints.remoteAgentManager.connectDevice.setTimeout.connectionTimeoutMs",
    "defaultMs": 6000,
    "label": "Agent 接口 · connectDevice / connectionTimeoutMs",
    "scope": "src/messageEndpoints/remoteAgentManager.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.messageEndpoints.remoteAgentManager.scanLan.timeoutMs",
    "defaultMs": 1400,
    "label": "Agent 接口 · scanLan / timeoutMs",
    "scope": "src/messageEndpoints/remoteAgentManager.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.messageHistoryIndexLifecycle.collectMessageIndexGenerations.acquireFileLockSync.timeoutMs",
    "defaultMs": 1000,
    "label": "服务运行 · collectMessageIndexGenerations / timeoutMs",
    "scope": "src/messageHistoryIndexLifecycle.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.messageHistoryIndexLifecycle.refreshManagedMessageIndex.acquireFileLockSync.timeoutMs",
    "defaultMs": 1000,
    "label": "服务运行 · refreshManagedMessageIndex / timeoutMs",
    "scope": "src/messageHistoryIndexLifecycle.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.messageHistoryIndexLifecycle.rollbackMessageIndex.acquireFileLockSync.timeoutMs",
    "defaultMs": 1000,
    "label": "服务运行 · rollbackMessageIndex / timeoutMs",
    "scope": "src/messageHistoryIndexLifecycle.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.messageProcessing.managerClient.findReferencedAgentSenders.timeoutMs",
    "defaultMs": 5000,
    "label": "服务运行 · findReferencedAgentSenders / timeoutMs",
    "scope": "src/messageProcessing/managerClient.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.messageProcessing.managerClient.sendMessageProcessingManagerCommand.timeoutMs",
    "defaultMs": 10000,
    "label": "服务运行 · sendMessageProcessingManagerCommand / timeoutMs",
    "scope": "src/messageProcessing/managerClient.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.napcat.getMessage.callNapCat.timeoutMs",
    "defaultMs": 3000,
    "label": "消息平台 · getMessage / timeoutMs",
    "scope": "src/napcat.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.napcat.readNapCatGroupFiles.AbortSignal.timeout.request",
    "defaultMs": 3000,
    "label": "消息平台 · readNapCatGroupFiles / request",
    "scope": "src/napcat.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.napcatMedia.NAPCAT_MEDIA_TIMEOUT_MS",
    "defaultMs": 12000,
    "label": "消息平台 · download / NAPCAT_MEDIA_TIMEOUT_MS",
    "scope": "src/napcatMedia.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.outbox.observeQqUploadOwner.getLoginInfo.timeoutMs",
    "defaultMs": 2000,
    "label": "服务运行 · observeQqUploadOwner / timeoutMs",
    "scope": "src/outbox.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.peerTunnel.channel.connectWebsocket.handshakeTimeout",
    "defaultMs": 5000,
    "label": "设备连接 · connectWebsocket / handshakeTimeout",
    "scope": "src/peerTunnel/channel.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.peerTunnel.session.ping.timeoutMs",
    "defaultMs": 3000,
    "label": "设备连接 · ping / timeoutMs",
    "scope": "src/peerTunnel/session.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.peerTunnel.speechAdapter.binary.requestLocalSpeech.timeoutMs",
    "defaultMs": 15000,
    "label": "设备连接 · binary / timeoutMs",
    "scope": "src/peerTunnel/speechAdapter.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.peerTunnel.speechAdapter.binary.timeoutMs",
    "defaultMs": 190000,
    "label": "设备连接 · binary / timeoutMs",
    "scope": "src/peerTunnel/speechAdapter.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.plan-storage.internal.lease.PLAN_LOCK_TIMEOUT_MS",
    "defaultMs": 10000,
    "label": "服务运行 · withPlanStorageLeaseAsync / PLAN_LOCK_TIMEOUT_MS",
    "scope": "src/plan-storage/internal/lease.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.plan-storage.internal.lease.SYNC_HEARTBEAT_WAIT_TIMEOUT_MS",
    "defaultMs": 10000,
    "label": "服务运行 · waitForHeartbeatTransition / SYNC_HEARTBEAT_WAIT_TIMEOUT_MS",
    "scope": "src/plan-storage/internal/lease.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.plugin-kernel.effectScope.waitForRetirement.timeoutMs",
    "defaultMs": 15000,
    "label": "插件运行 · waitForRetirement / timeoutMs",
    "scope": "src/plugin-kernel/effectScope.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.plugin-kernel.generationRuntime.DEFAULT_PLUGIN_SHUTDOWN_TIMEOUT_MS",
    "defaultMs": 15000,
    "label": "插件运行 · shutdown / DEFAULT_PLUGIN_SHUTDOWN_TIMEOUT_MS",
    "scope": "src/plugin-kernel/generationRuntime.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.plugin-kernel.generationRuntime.owner.Math.floor.activationTimeoutMs",
    "defaultMs": 30000,
    "label": "插件运行 · owner / activationTimeoutMs",
    "scope": "src/plugin-kernel/generationRuntime.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.plugin-kernel.hotPatchProcess.owner.startupTimeoutMs",
    "defaultMs": 15000,
    "label": "插件运行 · owner / startupTimeoutMs",
    "scope": "src/plugin-kernel/hotPatchProcess.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.plugin-kernel.hotPatchProcess.owner.timeoutMs",
    "defaultMs": 15000,
    "label": "插件运行 · owner / timeoutMs",
    "scope": "src/plugin-kernel/hotPatchProcess.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.plugin-kernel.hotPatchProcess.request.setTimeout.startupTimeoutMs",
    "defaultMs": 15000,
    "label": "插件运行 · request / startupTimeoutMs",
    "scope": "src/plugin-kernel/hotPatchProcess.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.plugin-kernel.hotPatchProcess.request.setTimeout.timeoutMs",
    "defaultMs": 15000,
    "label": "插件运行 · request / timeoutMs",
    "scope": "src/plugin-kernel/hotPatchProcess.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.plugin-kernel.synchronousExecution.DEFAULT_PLUGIN_SYNCHRONOUS_TIMEOUT_MS",
    "defaultMs": 100,
    "label": "插件运行 · runPluginSynchronousWork / DEFAULT_PLUGIN_SYNCHRONOUS_TIMEOUT_MS",
    "scope": "src/plugin-kernel/synchronousExecution.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.plugin-runtime-host.executor._activate.shutdownTimeoutMs",
    "defaultMs": 5000,
    "label": "插件运行 · #activate / shutdownTimeoutMs",
    "scope": "src/plugin-runtime-host/executor.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.plugin-runtime-host.executor.owner.heartbeatTimeoutMs",
    "defaultMs": 3000,
    "label": "插件运行 · owner / heartbeatTimeoutMs",
    "scope": "src/plugin-runtime-host/executor.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.plugin-runtime-host.executor.owner.terminationTimeoutMs",
    "defaultMs": 5000,
    "label": "插件运行 · owner / terminationTimeoutMs",
    "scope": "src/plugin-runtime-host/executor.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.plugin-runtime-host.executor.request.timeoutMs",
    "defaultMs": 60000,
    "label": "插件运行 · request / timeoutMs",
    "scope": "src/plugin-runtime-host/executor.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.rabilinkConversationLedger.RABILINK_CONVERSATION_LOCK_TIMEOUT_MS",
    "defaultMs": 5000,
    "label": "服务运行 · acquireConversationLock / RABILINK_CONVERSATION_LOCK_TIMEOUT_MS",
    "scope": "src/rabilinkConversationLedger.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.rabiPeerDirect.owner.timeoutMs",
    "defaultMs": 12000,
    "label": "服务运行 · owner / timeoutMs",
    "scope": "src/rabiPeerDirect.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.rabiPeerDiscovery.discoverRabiPeers.AbortSignal.timeout.request",
    "defaultMs": 5000,
    "label": "服务运行 · discoverRabiPeers / request",
    "scope": "src/rabiPeerDiscovery.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.routing.remotePersonaClient.fetchRemotePersonaSnapshot.setTimeout.timeoutMs",
    "defaultMs": 25000,
    "label": "服务运行 · fetchRemotePersonaSnapshot / timeoutMs",
    "scope": "src/routing/remotePersonaClient.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.runtime.processLeaseRegistry.owner.Math.floor.terminationTimeoutMs",
    "defaultMs": 5000,
    "label": "服务运行 · owner / terminationTimeoutMs",
    "scope": "src/runtime/processLeaseRegistry.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.shared.filePersistence.acquireFileLockSync.Math.floor.timeoutMs",
    "defaultMs": 5000,
    "label": "服务运行 · acquireFileLockSync / timeoutMs",
    "scope": "src/shared/filePersistence.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.shared.localSecretProtection.powerShellDpapi.spawnSync.timeout",
    "defaultMs": 15000,
    "label": "服务运行 · powerShellDpapi / timeout",
    "scope": "src/shared/localSecretProtection.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.weixinOpenClaw.pollWeixinQrSession.requestJson.timeoutMs",
    "defaultMs": 35000,
    "label": "消息平台 · pollWeixinQrSession / timeoutMs",
    "scope": "src/weixinOpenClaw.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.weixinOpenClaw.pollWeixinUpdates.requestJson.timeoutMs",
    "defaultMs": 35000,
    "label": "消息平台 · pollWeixinUpdates / timeoutMs",
    "scope": "src/weixinOpenClaw.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.weixinOpenClaw.requestJson.setTimeout.timeoutMs",
    "defaultMs": 35000,
    "label": "消息平台 · requestJson / timeoutMs",
    "scope": "src/weixinOpenClaw.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.weixinOpenClaw.requestWeixinQrSession.requestJson.timeoutMs",
    "defaultMs": 15000,
    "label": "消息平台 · requestWeixinQrSession / timeoutMs",
    "scope": "src/weixinOpenClaw.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.weixinOpenClaw.sendWeixinMedia.requestJson.timeoutMs",
    "defaultMs": 15000,
    "label": "消息平台 · sendWeixinMedia / timeoutMs",
    "scope": "src/weixinOpenClaw.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.workbuddySessionBridge.DEFAULT_SETTLE_TIMEOUT_MS",
    "defaultMs": 120000,
    "label": "Agent 接口 · waitForWorkbuddyTurn / DEFAULT_SETTLE_TIMEOUT_MS",
    "scope": "src/workbuddySessionBridge.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "backend.workbuddySessionBridge.REQUEST_TIMEOUT_MS",
    "defaultMs": 30000,
    "label": "Agent 接口 · waitForWorkbuddyTurn / REQUEST_TIMEOUT_MS",
    "scope": "src/workbuddySessionBridge.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "deadline.agentAdapters.hookInstallation.probeWorkbuddyHook",
    "defaultMs": 1000,
    "label": "执行等待 · probeWorkbuddyHook",
    "scope": "src/agentAdapters/hookInstallation.ts",
    "effect": "next-operation"
  },
  {
    "key": "deadline.agentAdapters.managerApi.loginAstrbotDashboard",
    "defaultMs": 4200,
    "label": "执行等待 · loginAstrbotDashboard",
    "scope": "src/agentAdapters/managerApi.ts",
    "effect": "next-operation"
  },
  {
    "key": "deadline.agentAdapters.managerApi.testAstrbotLogin",
    "defaultMs": 5000,
    "label": "执行等待 · testAstrbotLogin",
    "scope": "src/agentAdapters/managerApi.ts",
    "effect": "next-operation"
  },
  {
    "key": "deadline.dshOwnerRecovery.localDshRecoveryPorts",
    "defaultMs": 90000,
    "label": "执行等待 · localDshRecoveryPorts",
    "scope": "src/dshOwnerRecovery.ts",
    "effect": "next-operation"
  },
  {
    "key": "deadline.integrations.xiaomiHome.clipCapture.probeDuration",
    "defaultMs": 10000,
    "label": "执行等待 · probeDuration",
    "scope": "src/integrations/xiaomiHome/clipCapture.ts",
    "effect": "next-operation"
  },
  {
    "key": "deadline.integrations.xiaomiHome.vacuumVideo.connect",
    "defaultMs": 25000,
    "label": "执行等待 · connect",
    "scope": "src/integrations/xiaomiHome/vacuumVideo.ts",
    "effect": "next-operation"
  },
  {
    "key": "deadline.integrations.xiaomiHome.vacuumVideoWorker.close",
    "defaultMs": 1000,
    "label": "执行等待 · close",
    "scope": "src/integrations/xiaomiHome/vacuumVideoWorker.ts",
    "effect": "next-operation"
  },
  {
    "key": "deadline.manager.agentDeliveryVerification.verifyQqFileCurrentPresence",
    "defaultMs": 3000,
    "label": "执行等待 · verifyQqFileCurrentPresence",
    "scope": "src/manager/agentDeliveryVerification.ts",
    "effect": "next-operation"
  },
  {
    "key": "deadline.manager.automaticCodeService.compile",
    "defaultMs": 120000,
    "label": "执行等待 · compile",
    "scope": "src/manager/automaticCodeService.ts",
    "effect": "next-operation"
  },
  {
    "key": "deadline.manager.companionActivity.armLease",
    "defaultMs": 20000,
    "label": "执行等待 · armLease",
    "scope": "src/manager/companionActivity.ts",
    "effect": "next-operation"
  },
  {
    "key": "deadline.manager.controlPlaneRoutes.deliverWearableAlertViaGateway",
    "defaultMs": 600000,
    "label": "执行等待 · deliverWearableAlertViaGateway",
    "scope": "src/manager/controlPlaneRoutes.ts",
    "effect": "next-operation"
  },
  {
    "key": "deadline.manager.controlPlaneRoutes.deliverXiaomiHomeEventViaGateway",
    "defaultMs": 600000,
    "label": "执行等待 · deliverXiaomiHomeEventViaGateway",
    "scope": "src/manager/controlPlaneRoutes.ts",
    "effect": "next-operation"
  },
  {
    "key": "deadline.manager.controlPlaneRoutes.testGatewayAgentDelivery",
    "defaultMs": 60000,
    "label": "执行等待 · testGatewayAgentDelivery",
    "scope": "src/manager/controlPlaneRoutes.ts",
    "effect": "next-operation"
  },
  {
    "key": "deadline.manager.controlPlaneRoutes.triggerGatewayDirectAgentMessage",
    "defaultMs": 30000,
    "label": "执行等待 · triggerGatewayDirectAgentMessage",
    "scope": "src/manager/controlPlaneRoutes.ts",
    "effect": "next-operation"
  },
  {
    "key": "deadline.manager.controlPlaneRoutes.triggerGatewaySpeechMessage",
    "defaultMs": 40000,
    "label": "执行等待 · triggerGatewaySpeechMessage",
    "scope": "src/manager/controlPlaneRoutes.ts",
    "effect": "next-operation"
  },
  {
    "key": "deadline.manager.controlPlaneRoutes.xiaomiHomeHealthForScan",
    "defaultMs": 2000,
    "label": "执行等待 · xiaomiHomeHealthForScan",
    "scope": "src/manager/controlPlaneRoutes.ts",
    "effect": "next-operation"
  },
  {
    "key": "deadline.manager.identityResetRoutes.waitStatus",
    "defaultMs": 10000,
    "label": "执行等待 · waitStatus",
    "scope": "src/manager/identityResetRoutes.ts",
    "effect": "next-operation"
  },
  {
    "key": "deadline.manager.managerLanDiscoveryPublisher.defaultBonjourFactory",
    "defaultMs": 1000,
    "label": "执行等待 · defaultBonjourFactory",
    "scope": "src/manager/managerLanDiscoveryPublisher.ts",
    "effect": "next-operation"
  },
  {
    "key": "deadline.manager.managerLanDiscoveryPublisher.releasePublication",
    "defaultMs": 1000,
    "label": "执行等待 · releasePublication",
    "scope": "src/manager/managerLanDiscoveryPublisher.ts",
    "effect": "next-operation"
  },
  {
    "key": "deadline.manager.managerPluginRouteRegistry.rejectApiUpgrade",
    "defaultMs": 2000,
    "label": "执行等待 · rejectApiUpgrade",
    "scope": "src/manager/managerPluginRouteRegistry.ts",
    "effect": "next-operation"
  },
  {
    "key": "deadline.manager.recordingArchiveAsrRuntime.dispose",
    "defaultMs": 5000,
    "label": "执行等待 · dispose",
    "scope": "src/manager/recordingArchiveAsrRuntime.ts",
    "effect": "next-operation"
  },
  {
    "key": "deadline.manager.videoRuntime.inspectAsset",
    "defaultMs": 20000,
    "label": "执行等待 · inspectAsset",
    "scope": "src/manager/videoRuntime.ts",
    "effect": "next-operation"
  },
  {
    "key": "deadline.managerInstanceLock.readOsLeaseOwner",
    "defaultMs": 1000,
    "label": "执行等待 · readOsLeaseOwner",
    "scope": "src/managerInstanceLock.ts",
    "effect": "next-operation"
  },
  {
    "key": "deadline.messageEndpoints.napcatManager.testNapcatHealth",
    "defaultMs": 5000,
    "label": "执行等待 · testNapcatHealth",
    "scope": "src/messageEndpoints/napcatManager.ts",
    "effect": "next-operation"
  },
  {
    "key": "deadline.messageEndpoints.remoteAgentManager.closeWebSocketAndWait",
    "defaultMs": 2000,
    "label": "执行等待 · closeWebSocketAndWait",
    "scope": "src/messageEndpoints/remoteAgentManager.ts",
    "effect": "next-operation"
  },
  {
    "key": "deadline.weixinOpenClaw.downloadWeixinImages",
    "defaultMs": 20000,
    "label": "执行等待 · downloadWeixinImages",
    "scope": "src/weixinOpenClaw.ts",
    "effect": "next-operation"
  },
  {
    "key": "delivery.receiptWait",
    "defaultMs": 5000,
    "label": "投递回执完成等待",
    "scope": "src/manager/durableDeliveryIdempotency.ts",
    "effect": "next-operation"
  },
  {
    "key": "desktop.host.command",
    "defaultMs": 35000,
    "label": "托盘等待Host操作结果",
    "scope": "desktop",
    "effect": "new-request"
  },
  {
    "key": "desktop.manager.mutation",
    "defaultMs": 45000,
    "label": "托盘配置变更等待",
    "scope": "desktop",
    "effect": "new-request"
  },
  {
    "key": "desktop.manager.operation",
    "defaultMs": 120000,
    "label": "托盘长操作等待",
    "scope": "desktop",
    "effect": "new-request"
  },
  {
    "key": "desktop.manager.request",
    "defaultMs": 3000,
    "label": "托盘常规请求",
    "scope": "desktop",
    "effect": "new-request"
  },
  {
    "key": "desktop.media.inspect",
    "defaultMs": 1500,
    "label": "桌面媒体信息读取",
    "scope": "desktop",
    "effect": "new-request"
  },
  {
    "key": "desktop.observation.stop",
    "defaultMs": 100,
    "label": "桌面观察线程退出",
    "scope": "desktop",
    "effect": "new-request"
  },
  {
    "key": "desktop.pet.companion",
    "defaultMs": 12000,
    "label": "桌宠陪伴请求",
    "scope": "desktop",
    "effect": "new-request"
  },
  {
    "key": "desktop.pet.dialogue",
    "defaultMs": 5000,
    "label": "桌宠对话与记录请求",
    "scope": "desktop",
    "effect": "new-request"
  },
  {
    "key": "desktop.pet.eventsIdle",
    "defaultMs": 65000,
    "label": "桌宠事件连接空闲等待",
    "scope": "desktop",
    "effect": "new-request"
  },
  {
    "key": "desktop.pet.eventsStop",
    "defaultMs": 2000,
    "label": "桌宠事件线程退出",
    "scope": "desktop",
    "effect": "new-request"
  },
  {
    "key": "desktop.pet.motion",
    "defaultMs": 5000,
    "label": "桌宠动作请求",
    "scope": "desktop",
    "effect": "new-request"
  },
  {
    "key": "desktop.pet.request",
    "defaultMs": 10000,
    "label": "桌宠配置与资源请求",
    "scope": "desktop",
    "effect": "new-request"
  },
  {
    "key": "desktop.pet.speech",
    "defaultMs": 12000,
    "label": "桌宠语音请求",
    "scope": "desktop",
    "effect": "new-request"
  },
  {
    "key": "desktop.plan.feedback",
    "defaultMs": 5000,
    "label": "托盘计划反馈提交",
    "scope": "desktop",
    "effect": "new-request"
  },
  {
    "key": "desktop.qt.stop",
    "defaultMs": 5000,
    "label": "桌面后台任务退出",
    "scope": "desktop",
    "effect": "new-request"
  },
  {
    "key": "desktop.screenshot.stop",
    "defaultMs": 1500,
    "label": "截图线程退出",
    "scope": "desktop",
    "effect": "new-request"
  },
  {
    "key": "desktop.selection.capture",
    "defaultMs": 900,
    "label": "桌面选区捕获",
    "scope": "desktop",
    "effect": "new-request"
  },
  {
    "key": "desktop.selection.stop",
    "defaultMs": 1500,
    "label": "选区线程退出",
    "scope": "desktop",
    "effect": "new-request"
  },
  {
    "key": "desktop.voice.discovery",
    "defaultMs": 2000,
    "label": "桌面语音服务发现",
    "scope": "desktop",
    "effect": "next-client-start"
  },
  {
    "key": "desktop.voice.handshake",
    "defaultMs": 10000,
    "label": "桌面语音连接握手",
    "scope": "desktop",
    "effect": "next-client-start"
  },
  {
    "key": "desktop.voice.ping",
    "defaultMs": 20000,
    "label": "桌面语音连接保活等待",
    "scope": "desktop",
    "effect": "next-client-start"
  },
  {
    "key": "history.execution",
    "defaultMs": 1800,
    "label": "消息检索执行",
    "scope": "src/manager/messageHistorySearchService.ts",
    "effect": "next-request"
  },
  {
    "key": "history.queue",
    "defaultMs": 500,
    "label": "消息检索排队",
    "scope": "src/manager/messageHistorySearchService.ts",
    "effect": "next-request"
  },
  {
    "key": "history.request",
    "defaultMs": 2500,
    "label": "消息检索总等待",
    "scope": "src/manager/messageHistorySearchService.ts",
    "effect": "next-request"
  },
  {
    "key": "history.sqliteReadWait",
    "defaultMs": 50,
    "label": "消息索引数据库读锁等待",
    "scope": "src/messageHistorySearchIndex.ts",
    "effect": "next-operation"
  },
  {
    "key": "history.sqliteWriteWait",
    "defaultMs": 100,
    "label": "消息索引数据库写锁等待",
    "scope": "src/messageHistorySearchIndex.ts",
    "effect": "next-operation"
  },
  {
    "scope": "消息记录",
    "effect": "next-request",
    "defaultMs": 3000,
    "key": "history.transport",
    "label": "消息记录 · 中继与点对点传输预算"
  },
  {
    "key": "history.visibility",
    "defaultMs": 1500,
    "label": "消息索引可见性等待",
    "scope": "src/manager/messageHistorySearchService.ts",
    "effect": "next-request"
  },
  {
    "key": "home.cloudPage",
    "defaultMs": 40000,
    "label": "家庭设备云连接页面请求",
    "scope": "src/integrations/xiaomiHome/vacuumCloudPage.ts",
    "effect": "next-page-load"
  },
  {
    "key": "home.deploymentReady",
    "defaultMs": 60000,
    "label": "家庭设备服务部署就绪",
    "scope": "src/integrations/xiaomiHome/homeAssistantDeployment.ts",
    "effect": "next-operation"
  },
  {
    "key": "home.videoLocalReady",
    "defaultMs": 10000,
    "label": "摄像头本地就绪",
    "scope": "src/integrations/xiaomiHome/vacuumVideo.ts",
    "effect": "next-operation"
  },
  {
    "key": "home.videoRelayReady",
    "defaultMs": 45000,
    "label": "摄像头中转就绪",
    "scope": "src/integrations/xiaomiHome/vacuumVideo.ts",
    "effect": "next-operation"
  },
  {
    "key": "hooks.dsh.discovery",
    "defaultMs": 3000,
    "label": "DSH Hook宿主发现",
    "scope": "hooks",
    "effect": "next-hook-start"
  },
  {
    "key": "hooks.manager.discovery",
    "defaultMs": 8000,
    "label": "Agent Hook实例发现",
    "scope": "hooks",
    "effect": "next-hook-start"
  },
  {
    "key": "hooks.manager.request",
    "defaultMs": 8000,
    "label": "Agent Hook上下文请求",
    "scope": "hooks",
    "effect": "new-request"
  },
  {
    "key": "host.command.request",
    "defaultMs": 30000,
    "label": "Windows Host：控制命令等待",
    "scope": "windows-host",
    "effect": "next-host-start"
  },
  {
    "key": "host.command.startGrace",
    "defaultMs": 90000,
    "label": "Windows Host：启动命令额外等待",
    "scope": "windows-host",
    "effect": "next-host-start"
  },
  {
    "key": "host.control.exit",
    "defaultMs": 7000,
    "label": "Windows Host：控制服务退出",
    "scope": "windows-host",
    "effect": "next-host-start"
  },
  {
    "key": "host.control.read",
    "defaultMs": 5000,
    "label": "Windows Host：控制请求读取",
    "scope": "windows-host",
    "effect": "next-host-start"
  },
  {
    "key": "host.identityReset.execute",
    "defaultMs": 60000,
    "label": "Windows Host：身份重置执行",
    "scope": "windows-host",
    "effect": "next-host-start"
  },
  {
    "key": "host.identityReset.exit",
    "defaultMs": 10000,
    "label": "Windows Host：身份重置进程退出",
    "scope": "windows-host",
    "effect": "next-host-start"
  },
  {
    "key": "host.log.flush",
    "defaultMs": 2000,
    "label": "Windows Host：日志退出写入",
    "scope": "windows-host",
    "effect": "next-host-start"
  },
  {
    "key": "host.manager.exit",
    "defaultMs": 12000,
    "label": "Windows Host：Manager退出",
    "scope": "windows-host",
    "effect": "next-host-start"
  },
  {
    "key": "host.manager.probe",
    "defaultMs": 30000,
    "label": "Windows Host：Manager健康请求",
    "scope": "windows-host",
    "effect": "next-host-start"
  },
  {
    "key": "host.manager.ready",
    "defaultMs": 180000,
    "label": "Windows Host：Manager启动就绪",
    "scope": "windows-host",
    "effect": "next-host-start"
  },
  {
    "key": "host.manager.shutdownRequest",
    "defaultMs": 3000,
    "label": "Windows Host：Manager停机请求",
    "scope": "windows-host",
    "effect": "next-host-start"
  },
  {
    "key": "host.patch.request",
    "defaultMs": 20000,
    "label": "Windows Host：补丁请求",
    "scope": "windows-host",
    "effect": "next-host-start"
  },
  {
    "key": "host.process.admission",
    "defaultMs": 30000,
    "label": "Windows Host：进程启动接纳",
    "scope": "windows-host",
    "effect": "next-host-start"
  },
  {
    "key": "host.process.exit",
    "defaultMs": 10000,
    "label": "Windows Host：子进程退出",
    "scope": "windows-host",
    "effect": "next-host-start"
  },
  {
    "key": "host.status.probe",
    "defaultMs": 2000,
    "label": "Windows Host：状态查询",
    "scope": "windows-bootstrap",
    "effect": "next-host-start"
  },
  {
    "key": "host.tray.exit",
    "defaultMs": 5000,
    "label": "Windows Host：托盘退出",
    "scope": "windows-host",
    "effect": "next-host-start"
  },
  {
    "key": "host.tray.ready",
    "defaultMs": 120000,
    "label": "Windows Host：托盘启动就绪",
    "scope": "windows-host",
    "effect": "next-host-start"
  },
  {
    "key": "host.tray.shutdownRequest",
    "defaultMs": 3000,
    "label": "Windows Host：托盘停机请求",
    "scope": "windows-host",
    "effect": "next-host-start"
  },
  {
    "key": "http.headers",
    "defaultMs": 10000,
    "label": "HTTP 请求头接收",
    "scope": "src/manager/controlPlaneRoutes.ts",
    "effect": "next-server-start"
  },
  {
    "key": "http.keepAlive",
    "defaultMs": 5000,
    "label": "HTTP 空闲连接",
    "scope": "src/manager/controlPlaneRoutes.ts",
    "effect": "next-server-start"
  },
  {
    "key": "http.outerRequest",
    "defaultMs": 1800000,
    "label": "HTTP 外层请求接收",
    "scope": "src/manager/controlPlaneRoutes.ts",
    "effect": "next-server-start"
  },
  {
    "key": "http.request",
    "defaultMs": 30000,
    "label": "HTTP 普通请求",
    "scope": "src/manager/controlPlaneRoutes.ts",
    "effect": "next-request"
  },
  {
    "key": "legacyAgent.authentication",
    "defaultMs": 5000,
    "label": "旧远程Agent连接鉴权等待",
    "scope": "legacyAgent",
    "effect": "next-process-start"
  },
  {
    "key": "legacyAgent.health",
    "defaultMs": 1000,
    "label": "旧远程Agent健康请求",
    "scope": "legacyAgent",
    "effect": "next-process-start"
  },
  {
    "key": "legacyAgent.rpc.mutation",
    "defaultMs": 180000,
    "label": "旧远程Agent变更请求",
    "scope": "legacyAgent",
    "effect": "next-process-start"
  },
  {
    "key": "legacyAgent.rpc.read",
    "defaultMs": 60000,
    "label": "旧远程Agent读取请求",
    "scope": "legacyAgent",
    "effect": "next-process-start"
  },
  {
    "key": "legacyAgent.task.resume",
    "defaultMs": 30000,
    "label": "旧远程Agent恢复等待",
    "scope": "legacyAgent",
    "effect": "next-process-start"
  },
  {
    "key": "legacyAgent.task.terminal",
    "defaultMs": 1800000,
    "label": "旧远程Agent任务终态等待",
    "scope": "legacyAgent",
    "effect": "next-process-start"
  },
  {
    "key": "linux.host.command",
    "defaultMs": 10000,
    "label": "Linux Host 普通命令",
    "scope": "Linux Host",
    "effect": "下次Host启动；命令客户端下次调用读取同一Config.json"
  },
  {
    "key": "linux.host.http.headers",
    "defaultMs": 5000,
    "label": "Linux Host 接收请求头",
    "scope": "Linux Host",
    "effect": "下次Host启动；命令客户端下次调用读取同一Config.json"
  },
  {
    "key": "linux.host.http.request",
    "defaultMs": 10000,
    "label": "Linux Host 接收请求",
    "scope": "Linux Host",
    "effect": "下次Host启动；命令客户端下次调用读取同一Config.json"
  },
  {
    "key": "linux.host.launch",
    "defaultMs": 125000,
    "label": "Linux Host 启动等待",
    "scope": "Linux Host",
    "effect": "下次Host启动；命令客户端下次调用读取同一Config.json"
  },
  {
    "key": "linux.host.request",
    "defaultMs": 5000,
    "label": "Linux Host HTTP 请求",
    "scope": "Linux Host",
    "effect": "下次Host启动；命令客户端下次调用读取同一Config.json"
  },
  {
    "key": "linux.host.restart",
    "defaultMs": 90000,
    "label": "Linux Host 重启命令",
    "scope": "Linux Host",
    "effect": "下次Host启动；命令客户端下次调用读取同一Config.json"
  },
  {
    "key": "linux.host.startup",
    "defaultMs": 60000,
    "label": "Linux Manager 启动",
    "scope": "Linux Host",
    "effect": "下次Host启动；命令客户端下次调用读取同一Config.json"
  },
  {
    "key": "linux.host.stop",
    "defaultMs": 12000,
    "label": "Linux Manager 退出",
    "scope": "Linux Host",
    "effect": "下次Host启动；命令客户端下次调用读取同一Config.json"
  },
  {
    "key": "manager.instances.discovery",
    "defaultMs": 450,
    "label": "发现其他实例",
    "scope": "manager",
    "effect": "next-request"
  },
  {
    "key": "manager.instances.discoveryMaximum",
    "defaultMs": 3000,
    "label": "实例发现单次等待上限",
    "scope": "manager",
    "effect": "next-request"
  },
  {
    "key": "manager.instances.proxy",
    "defaultMs": 3000,
    "label": "跨实例代理请求",
    "scope": "manager",
    "effect": "next-request"
  },
  {
    "key": "manager.resourceStop",
    "defaultMs": 10000,
    "label": "Manager 资源停止",
    "scope": "src/manager/managerRuntimeOwner.ts",
    "effect": "next-owner-initialization"
  },
  {
    "key": "markdown.browser",
    "defaultMs": 15000,
    "label": "Markdown图片浏览器执行",
    "scope": "src/markdownImage.ts",
    "effect": "next-operation"
  },
  {
    "key": "mcp.host.discovery",
    "defaultMs": 5000,
    "label": "MCP：Host发现与身份核验",
    "scope": "mcp-client",
    "effect": "MCP启动时读取环境快照，已验证Host/meta后后续操作读取最新快照"
  },
  {
    "key": "mcp.http.headers",
    "defaultMs": 10000,
    "label": "MCP：HTTP请求头接收",
    "scope": "mcp-client",
    "effect": "下次启动MCP HTTP服务时生效"
  },
  {
    "key": "mcp.http.keepAlive",
    "defaultMs": 1000,
    "label": "MCP：HTTP连接保活",
    "scope": "mcp-client",
    "effect": "下次启动MCP HTTP服务时生效"
  },
  {
    "key": "mcp.http.request",
    "defaultMs": 15000,
    "label": "MCP：HTTP请求接收",
    "scope": "mcp-client",
    "effect": "下次启动MCP HTTP服务时生效"
  },
  {
    "key": "mcp.knowledge.request",
    "defaultMs": 12000,
    "label": "MCP：知识工具请求",
    "scope": "mcp-client",
    "effect": "MCP启动时读取环境快照，已验证Host/meta后后续操作读取最新快照"
  },
  {
    "key": "memory.scheduleRead",
    "defaultMs": 30000,
    "label": "记忆整理排程读取",
    "scope": "src/manager/memoryConsolidationScheduleWorkerClient.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "memory.scheduleTerminate",
    "defaultMs": 5000,
    "label": "记忆整理工作线程终止",
    "scope": "src/manager/memoryConsolidationScheduleWorkerClient.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "napcat.existingOwnerReady",
    "defaultMs": 5000,
    "label": "QQ已有进程就绪等待",
    "scope": "src/messageEndpoints/napcatManager.ts",
    "effect": "next-operation"
  },
  {
    "key": "patch.compile",
    "defaultMs": 30000,
    "label": "源码补丁编译",
    "scope": "src/manager/sourcePatchCompiler.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "patch.journalLock",
    "defaultMs": 5000,
    "label": "补丁日志锁等待",
    "scope": "src/plugin-kernel/hotPatchBundleJournal.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "peer.handshake",
    "defaultMs": 5000,
    "label": "跨设备隧道握手",
    "scope": "src/peerTunnel/runtime.ts",
    "effect": "next-request"
  },
  {
    "key": "peer.httpHeaders",
    "defaultMs": 10000,
    "label": "设备连接 HTTP headersTimeout",
    "scope": "src/manager/peerLanServer.ts",
    "effect": "next-server-start"
  },
  {
    "key": "peer.httpKeepAlive",
    "defaultMs": 5000,
    "label": "设备连接 HTTP keepAliveTimeout",
    "scope": "src/manager/peerLanServer.ts",
    "effect": "next-server-start"
  },
  {
    "key": "peer.httpRequest",
    "defaultMs": 30000,
    "label": "设备连接 HTTP requestTimeout",
    "scope": "src/manager/peerLanServer.ts",
    "effect": "next-server-start"
  },
  {
    "key": "peer.idle",
    "defaultMs": 60000,
    "label": "设备连接空闲回收",
    "scope": "src/peerTunnel/connections.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "peer.lanConnect",
    "defaultMs": 2000,
    "label": "局域网设备连接",
    "scope": "src/peerTunnel/connections.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "peer.p2pConnect",
    "defaultMs": 10000,
    "label": "P2P设备连接",
    "scope": "src/peerTunnel/connections.ts",
    "effect": "next-connection"
  },
  {
    "key": "peer.proxyHandshake",
    "defaultMs": 10000,
    "label": "跨设备 WebSocket 代理握手",
    "scope": "src/peerTunnel/http.ts",
    "effect": "next-connection"
  },
  {
    "key": "peer.relayConnect",
    "defaultMs": 5000,
    "label": "中转设备连接",
    "scope": "src/peerTunnel/connections.ts",
    "effect": "next-connection"
  },
  {
    "key": "peer.responseHeaders",
    "defaultMs": 190000,
    "label": "跨设备响应头等待",
    "scope": "src/peerTunnel/http.ts",
    "effect": "next-request"
  },
  {
    "key": "peer.rtcClose",
    "defaultMs": 15000,
    "label": "RTC 连接关闭等待",
    "scope": "src/peerTunnel/rtc.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "peer.rtcOpen",
    "defaultMs": 10000,
    "label": "RTC 通道打开等待",
    "scope": "src/peerTunnel/rtc.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "peer.signal",
    "defaultMs": 20000,
    "label": "跨设备连接信令",
    "scope": "src/peerTunnel/runtime.ts",
    "effect": "next-request"
  },
  {
    "key": "persona.context",
    "defaultMs": 2500,
    "label": "人格上下文读取",
    "scope": "src/manager/roleContextProjection.ts",
    "effect": "next-request"
  },
  {
    "key": "persona.skillDownload",
    "defaultMs": 30000,
    "label": "技能下载传输",
    "scope": "src/manager/roleSkillDownloadRoutes.ts",
    "effect": "next-request"
  },
  {
    "key": "persona.taskMetadata",
    "defaultMs": 3000,
    "label": "人格聊天任务元数据",
    "scope": "src/manager/personaChatTaskMetadata.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "plugin.disposal",
    "defaultMs": 5000,
    "label": "插件运行 · #disposeEffect / disposalTimeoutMs",
    "scope": "src/plugin-kernel/effectScope.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "plugin.drain",
    "defaultMs": 30000,
    "label": "插件在途请求排空",
    "scope": "src/manager/managerPluginRequestTracker.ts",
    "effect": "next-request"
  },
  {
    "key": "plugin.operation",
    "defaultMs": 30000,
    "label": "插件运行 · run / operationTimeoutMs",
    "scope": "src/plugin-kernel/effectScope.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "plugin.packageCleanup",
    "defaultMs": 5000,
    "label": "插件包加载清理",
    "scope": "src/plugin-kernel/pluginPackageLoader.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "plugin.packageLoad",
    "defaultMs": 30000,
    "label": "插件包加载",
    "scope": "src/plugin-kernel/pluginPackageLoader.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "process.manualForceTerminate",
    "defaultMs": 2000,
    "label": "手动执行进程终止等待",
    "scope": "src/manager/manualTriggerProcess.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "process.manualTerminate",
    "defaultMs": 2000,
    "label": "手动执行进程终止等待",
    "scope": "src/manager/manualTriggerProcess.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "qq.media",
    "defaultMs": 30000,
    "label": "QQ 媒体下载",
    "scope": "src/shared/qqReadSettings.ts",
    "effect": "next-request"
  },
  {
    "key": "qq.preview",
    "defaultMs": 10000,
    "label": "QQ 表情预览",
    "scope": "src/shared/qqReadSettings.ts",
    "effect": "next-request"
  },
  {
    "key": "qq.read",
    "defaultMs": 8000,
    "label": "QQ 消息读取",
    "scope": "src/shared/qqReadSettings.ts",
    "effect": "next-request"
  },
  {
    "key": "relay.history.query",
    "defaultMs": 3000,
    "label": "独立Relay：消息历史查询",
    "scope": "relay-standalone",
    "effect": "独立Relay启动时读取 RABIROUTE_TIMEOUT_OVERRIDES 快照；PC保存不会直接改变远程服务"
  },
  {
    "key": "relay.http.headers",
    "defaultMs": 60000,
    "label": "独立Relay：HTTP请求头接收",
    "scope": "relay-standalone",
    "effect": "独立Relay启动时读取 RABIROUTE_TIMEOUT_OVERRIDES 快照；PC保存不会直接改变远程服务"
  },
  {
    "key": "relay.http.keepAlive",
    "defaultMs": 5000,
    "label": "独立Relay：HTTP连接保活",
    "scope": "relay-standalone",
    "effect": "独立Relay启动时读取 RABIROUTE_TIMEOUT_OVERRIDES 快照；PC保存不会直接改变远程服务"
  },
  {
    "key": "relay.http.request",
    "defaultMs": 300000,
    "label": "独立Relay：HTTP请求接收",
    "scope": "relay-standalone",
    "effect": "独立Relay启动时读取 RABIROUTE_TIMEOUT_OVERRIDES 快照；PC保存不会直接改变远程服务"
  },
  {
    "key": "relay.outboxWait",
    "defaultMs": 60000,
    "label": "独立Relay：消息长轮询",
    "scope": "relay-standalone",
    "effect": "独立Relay启动时读取 RABIROUTE_TIMEOUT_OVERRIDES 快照；PC保存不会直接改变远程服务"
  },
  {
    "key": "relay.reply",
    "defaultMs": 60000,
    "label": "独立Relay：任务答复等待",
    "scope": "relay-standalone",
    "effect": "独立Relay启动时读取 RABIROUTE_TIMEOUT_OVERRIDES 快照；PC保存不会直接改变远程服务"
  },
  {
    "key": "relay.speechWait",
    "defaultMs": 180000,
    "label": "独立Relay：语音代理请求",
    "scope": "relay-standalone",
    "effect": "独立Relay启动时读取 RABIROUTE_TIMEOUT_OVERRIDES 快照；PC保存不会直接改变远程服务"
  },
  {
    "key": "relay.tunnel.idle",
    "defaultMs": 65000,
    "label": "独立Relay：隧道无数据",
    "scope": "relay-standalone",
    "effect": "独立Relay启动时读取 RABIROUTE_TIMEOUT_OVERRIDES 快照；PC保存不会直接改变远程服务"
  },
  {
    "key": "relay.tunnel.pair",
    "defaultMs": 10000,
    "label": "独立Relay：隧道对端加入",
    "scope": "relay-standalone",
    "effect": "独立Relay启动时读取 RABIROUTE_TIMEOUT_OVERRIDES 快照；PC保存不会直接改变远程服务"
  },
  {
    "key": "relay.webguiWait",
    "defaultMs": 30000,
    "label": "独立Relay：WebGUI代理请求",
    "scope": "relay-standalone",
    "effect": "独立Relay启动时读取 RABIROUTE_TIMEOUT_OVERRIDES 快照；PC保存不会直接改变远程服务"
  },
  {
    "key": "relay.workerWait",
    "defaultMs": 60000,
    "label": "独立Relay：处理端领取长轮询",
    "scope": "relay-standalone",
    "effect": "独立Relay启动时读取 RABIROUTE_TIMEOUT_OVERRIDES 快照；PC保存不会直接改变远程服务"
  },
  {
    "key": "scripts.history.query",
    "defaultMs": 3000,
    "label": "脚本：消息历史查询总期限",
    "scope": "scripts",
    "effect": "下一次操作读取已验证连接缓存；未接收配置时使用原有默认值"
  },
  {
    "key": "scripts.manager.discovery",
    "defaultMs": 5000,
    "label": "脚本 Manager 发现",
    "scope": "scripts",
    "effect": "新子进程，继承 RABIROUTE_TIMEOUT_OVERRIDES"
  },
  {
    "key": "scripts.manager.ready",
    "defaultMs": 10000,
    "label": "脚本 Host 就绪等待",
    "scope": "scripts",
    "effect": "新子进程，继承 RABIROUTE_TIMEOUT_OVERRIDES"
  },
  {
    "key": "scripts.relay.pair",
    "defaultMs": 15000,
    "label": "脚本：Relay电脑配对",
    "scope": "scripts",
    "effect": "下一次操作读取已验证连接缓存；未接收配置时使用原有默认值"
  },
  {
    "key": "speech.apiAsr.connect",
    "defaultMs": 15000,
    "label": "语音 apiAsr 连接等待",
    "scope": "speech",
    "effect": "next-speech-start"
  },
  {
    "key": "speech.apiAsr.request",
    "defaultMs": 180000,
    "label": "语音 apiAsr 请求等待",
    "scope": "speech",
    "effect": "next-speech-start"
  },
  {
    "key": "speech.apiTts.connect",
    "defaultMs": 15000,
    "label": "语音 apiTts 连接等待",
    "scope": "speech",
    "effect": "next-speech-start"
  },
  {
    "key": "speech.apiTts.request",
    "defaultMs": 180000,
    "label": "语音 apiTts 请求等待",
    "scope": "speech",
    "effect": "next-speech-start"
  },
  {
    "key": "speech.audio.convert",
    "defaultMs": 120000,
    "label": "音频转换等待",
    "scope": "speech",
    "effect": "next-speech-start"
  },
  {
    "key": "speech.benchmark.asr",
    "defaultMs": 900000,
    "label": "语音基准ASR任务等待",
    "scope": "speech-cli",
    "effect": "next-process-start"
  },
  {
    "key": "speech.benchmark.gpuProbe",
    "defaultMs": 5000,
    "label": "语音基准GPU探测",
    "scope": "speech-cli",
    "effect": "next-process-start"
  },
  {
    "key": "speech.benchmark.health",
    "defaultMs": 10000,
    "label": "语音基准健康检查",
    "scope": "speech-cli",
    "effect": "next-process-start"
  },
  {
    "key": "speech.benchmark.job",
    "defaultMs": 900000,
    "label": "语音基准TTS任务等待",
    "scope": "speech-cli",
    "effect": "next-process-start"
  },
  {
    "key": "speech.benchmark.join",
    "defaultMs": 3000,
    "label": "语音基准采样线程退出",
    "scope": "speech-cli",
    "effect": "next-process-start"
  },
  {
    "key": "speech.benchmark.request",
    "defaultMs": 30000,
    "label": "语音基准接口请求",
    "scope": "speech-cli",
    "effect": "next-process-start"
  },
  {
    "key": "speech.benchmark.workerAfter",
    "defaultMs": 5000,
    "label": "语音基准测试后模型检查",
    "scope": "speech-cli",
    "effect": "next-process-start"
  },
  {
    "key": "speech.benchmark.workerBefore",
    "defaultMs": 3000,
    "label": "语音基准测试前模型检查",
    "scope": "speech-cli",
    "effect": "next-process-start"
  },
  {
    "key": "speech.camera.lease",
    "defaultMs": 120000,
    "label": "摄像头无请求退出等待",
    "scope": "speech",
    "effect": "next-speech-start"
  },
  {
    "key": "speech.camera.snapshot",
    "defaultMs": 15000,
    "label": "摄像头快照等待",
    "scope": "speech",
    "effect": "next-speech-start"
  },
  {
    "key": "speech.camera.stop",
    "defaultMs": 2000,
    "label": "摄像头进程退出等待",
    "scope": "speech",
    "effect": "next-speech-start"
  },
  {
    "key": "speech.capture.snapshot",
    "defaultMs": 15000,
    "label": "全天采集截图等待",
    "scope": "speech",
    "effect": "next-speech-start"
  },
  {
    "key": "speech.dashscope.connect",
    "defaultMs": 15000,
    "label": "语音 dashscope 连接等待",
    "scope": "speech",
    "effect": "next-speech-start"
  },
  {
    "key": "speech.dashscope.request",
    "defaultMs": 180000,
    "label": "语音 dashscope 请求等待",
    "scope": "speech",
    "effect": "next-speech-start"
  },
  {
    "key": "speech.health",
    "defaultMs": 5000,
    "label": "语音健康检查",
    "scope": "src/manager/speechServiceStatus.ts",
    "effect": "next-request"
  },
  {
    "key": "speech.httpAsr.connect",
    "defaultMs": 10000,
    "label": "语音 httpAsr 连接等待",
    "scope": "speech",
    "effect": "next-speech-start"
  },
  {
    "key": "speech.httpAsr.request",
    "defaultMs": 180000,
    "label": "语音 httpAsr 请求等待",
    "scope": "speech",
    "effect": "next-speech-start"
  },
  {
    "key": "speech.install.download",
    "defaultMs": 180000,
    "label": "语音模型下载等待",
    "scope": "speech-cli",
    "effect": "next-process-start"
  },
  {
    "key": "speech.install.metadata",
    "defaultMs": 60000,
    "label": "语音模型版本信息读取",
    "scope": "speech-cli",
    "effect": "next-process-start"
  },
  {
    "key": "speech.localTts.connect",
    "defaultMs": 10000,
    "label": "语音 localTts 连接等待",
    "scope": "speech",
    "effect": "next-speech-start"
  },
  {
    "key": "speech.localTts.request",
    "defaultMs": 180000,
    "label": "语音 localTts 请求等待",
    "scope": "speech",
    "effect": "next-speech-start"
  },
  {
    "key": "speech.manager.request",
    "defaultMs": 45000,
    "label": "语音服务向本机请求",
    "scope": "speech",
    "effect": "next-speech-start"
  },
  {
    "key": "speech.onnx.stop",
    "defaultMs": 5000,
    "label": "ONNX语音服务退出等待",
    "scope": "speech",
    "effect": "next-speech-start"
  },
  {
    "key": "speech.peer.request",
    "defaultMs": 190000,
    "label": "远程语音算力请求",
    "scope": "speech",
    "effect": "next-speech-start"
  },
  {
    "key": "speech.peer.selection",
    "defaultMs": 5000,
    "label": "远程语音算力选择读取",
    "scope": "speech",
    "effect": "next-speech-start"
  },
  {
    "key": "speech.remoteAudio.database",
    "defaultMs": 10000,
    "label": "远程音频数据库锁等待",
    "scope": "speech",
    "effect": "next-speech-start"
  },
  {
    "key": "speech.remoteAudio.handshake",
    "defaultMs": 10000,
    "label": "远程音频握手等待",
    "scope": "speech",
    "effect": "next-speech-start"
  },
  {
    "key": "speech.remoteAudio.ping",
    "defaultMs": 20000,
    "label": "远程音频连接保活等待",
    "scope": "speech",
    "effect": "next-speech-start"
  },
  {
    "key": "speech.remoteAudio.playback",
    "defaultMs": 200,
    "label": "远程音频播放确认等待",
    "scope": "speech",
    "effect": "next-speech-start"
  },
  {
    "key": "speech.remoteAudio.stale",
    "defaultMs": 90000,
    "label": "远程音频失联等待",
    "scope": "speech",
    "effect": "next-speech-start"
  },
  {
    "key": "speech.request",
    "defaultMs": 190000,
    "label": "本机语音请求",
    "scope": "src/speech/localSpeechClient.ts",
    "effect": "next-request"
  },
  {
    "key": "speech.speaker.probe",
    "defaultMs": 120000,
    "label": "声纹模型探测等待",
    "scope": "speech",
    "effect": "next-speech-start"
  },
  {
    "key": "speech.start",
    "defaultMs": 120000,
    "label": "语音服务启动等待",
    "scope": "src/manager/speechRuntimeControl.ts",
    "effect": "next-request"
  },
  {
    "key": "speech.stop",
    "defaultMs": 15000,
    "label": "语音服务停止等待",
    "scope": "src/manager/speechRuntimeControl.ts",
    "effect": "next-request"
  },
  {
    "key": "speech.windowsAudio.join",
    "defaultMs": 500,
    "label": "Windows音频策略线程退出",
    "scope": "speech",
    "effect": "next-speech-start"
  },
  {
    "key": "speech.windowsAudio.start",
    "defaultMs": 2500,
    "label": "Windows音频会话启动",
    "scope": "speech",
    "effect": "next-speech-start"
  },
  {
    "key": "speech.windowsAudio.stop",
    "defaultMs": 2000,
    "label": "Windows音频会话退出",
    "scope": "speech",
    "effect": "next-speech-start"
  },
  {
    "key": "speech.worker.health",
    "defaultMs": 1000,
    "label": "语音模型健康请求",
    "scope": "speech",
    "effect": "next-speech-start"
  },
  {
    "key": "speech.worker.healthConnect",
    "defaultMs": 500,
    "label": "语音模型健康连接",
    "scope": "speech",
    "effect": "next-speech-start"
  },
  {
    "key": "speech.worker.kill",
    "defaultMs": 5000,
    "label": "语音模型进程终止确认",
    "scope": "speech",
    "effect": "next-speech-start"
  },
  {
    "key": "speech.worker.start",
    "defaultMs": 240000,
    "label": "语音模型启动等待",
    "scope": "speech",
    "effect": "next-speech-start"
  },
  {
    "key": "speech.worker.stop",
    "defaultMs": 10000,
    "label": "语音模型进程退出等待",
    "scope": "speech",
    "effect": "next-speech-start"
  },
  {
    "key": "startup.planStorage",
    "defaultMs": 180000,
    "label": "计划存储启动",
    "scope": "src/manager/planStorageStartupLifecycle.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "startup.routeCatalog",
    "defaultMs": 120000,
    "label": "路由目录启动",
    "scope": "src/manager/routeCatalogStartupLifecycle.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "startup.routeTerminate",
    "defaultMs": 5000,
    "label": "路由目录启动终止",
    "scope": "src/manager/routeCatalogStartupLifecycle.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "startup.storageBatch",
    "defaultMs": 30000,
    "label": "存储启动批次",
    "scope": "src/manager/boundedStorageStartup.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "startup.storageItem",
    "defaultMs": 10000,
    "label": "存储启动单项",
    "scope": "src/manager/boundedStorageStartup.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "storage.deliveryOwnerLock",
    "defaultMs": 1000,
    "label": "投递存储工作线程归属锁",
    "scope": "src/agentRequests/persistenceWorker.ts",
    "effect": "next-worker-start"
  },
  {
    "key": "storage.generationProbe",
    "defaultMs": 5000,
    "label": "存储写入代际核验",
    "scope": "src/runtime/planStorageGenerationFence.ts",
    "effect": "next-request"
  },
  {
    "key": "storage.mutation",
    "defaultMs": 30000,
    "label": "存储写入工作线程",
    "scope": "src/manager/managerStorageMutationPool.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "storage.mutationForceTerminate",
    "defaultMs": 5000,
    "label": "存储工作线程强制终止",
    "scope": "src/manager/managerStorageMutationPool.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "storage.mutationReceiptWait",
    "defaultMs": 250,
    "label": "存储写入回执等待",
    "scope": "src/manager/managerStorageMutationChild.ts",
    "effect": "next-operation"
  },
  {
    "key": "storage.mutationTerminate",
    "defaultMs": 1000,
    "label": "存储工作线程终止",
    "scope": "src/manager/managerStorageMutationPool.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "style.fetch",
    "defaultMs": 5000,
    "label": "语言风格远端读取",
    "scope": "src/languageStyleValidation.ts",
    "effect": "next-operation-or-owner-initialization"
  },
  {
    "key": "video.asset.upload",
    "defaultMs": 120000,
    "label": "视频参考素材上传",
    "scope": "video",
    "effect": "new-request"
  },
  {
    "key": "video.directConnect",
    "defaultMs": 45000,
    "label": "视频直连建立",
    "scope": "src/manager/rabiDirectVideo.ts",
    "effect": "next-request"
  },
  {
    "key": "video.directIdle",
    "defaultMs": 15000,
    "label": "视频直连空闲",
    "scope": "src/manager/rabiDirectVideo.ts",
    "effect": "next-idle-period"
  },
  {
    "key": "video.generation",
    "defaultMs": 7200000,
    "label": "视频生成总等待",
    "scope": "video",
    "effect": "new-request"
  },
  {
    "key": "video.model.download",
    "defaultMs": 14400000,
    "label": "视频模型文件下载",
    "scope": "video",
    "effect": "new-request"
  },
  {
    "key": "video.peer.events",
    "defaultMs": 7200000,
    "label": "远程视频任务事件等待",
    "scope": "video",
    "effect": "new-request"
  },
  {
    "key": "video.peer.request",
    "defaultMs": 120000,
    "label": "远程视频算力请求",
    "scope": "video",
    "effect": "new-request"
  },
  {
    "key": "video.runtime.request",
    "defaultMs": 20000,
    "label": "视频运行环境请求",
    "scope": "video",
    "effect": "new-request"
  },
  {
    "key": "video.runtime.start",
    "defaultMs": 120000,
    "label": "视频运行环境启动",
    "scope": "video",
    "effect": "new-request"
  },
  {
    "key": "webgui.apiReference.read",
    "defaultMs": 15000,
    "label": "接口文档读取",
    "scope": "webgui",
    "effect": "new-request"
  },
  {
    "key": "webgui.companion.last",
    "defaultMs": 12000,
    "label": "最近陪伴活动读取",
    "scope": "webgui",
    "effect": "new-request"
  },
  {
    "key": "webgui.companion.recordingMax",
    "defaultMs": 30000,
    "label": "陪伴活动单次录音时限",
    "scope": "webgui",
    "effect": "new-request"
  },
  {
    "key": "webgui.companion.request",
    "defaultMs": 15000,
    "label": "陪伴活动请求",
    "scope": "webgui",
    "effect": "new-request"
  },
  {
    "key": "webgui.companion.review",
    "defaultMs": 50000,
    "label": "陪伴活动回顾",
    "scope": "webgui",
    "effect": "new-request"
  },
  {
    "key": "webgui.delivery.read",
    "defaultMs": 15000,
    "label": "投递记录读取",
    "scope": "webgui",
    "effect": "new-request"
  },
  {
    "key": "webgui.device.identity",
    "defaultMs": 12000,
    "label": "家庭设备连接身份检查",
    "scope": "webgui",
    "effect": "new-request"
  },
  {
    "key": "webgui.device.request",
    "defaultMs": 30000,
    "label": "家庭设备请求",
    "scope": "webgui",
    "effect": "new-request"
  },
  {
    "key": "webgui.gateway.mutation",
    "defaultMs": 35000,
    "label": "消息路线配置保存",
    "scope": "webgui",
    "effect": "new-request"
  },
  {
    "key": "webgui.identity.read",
    "defaultMs": 5000,
    "label": "实例身份读取",
    "scope": "webgui",
    "effect": "new-request"
  },
  {
    "key": "webgui.identity.reset",
    "defaultMs": 45000,
    "label": "实例身份重置与结果确认",
    "scope": "webgui",
    "effect": "new-request"
  },
  {
    "key": "webgui.knowledge.request",
    "defaultMs": 12000,
    "label": "计划与记忆请求",
    "scope": "webgui",
    "effect": "new-request"
  },
  {
    "key": "webgui.performance.submit",
    "defaultMs": 2000,
    "label": "界面性能记录提交",
    "scope": "webgui",
    "effect": "new-request"
  },
  {
    "key": "webgui.persona.document",
    "defaultMs": 25000,
    "label": "人格文档请求",
    "scope": "webgui",
    "effect": "new-request"
  },
  {
    "key": "webgui.persona.remote",
    "defaultMs": 25000,
    "label": "远程人格请求",
    "scope": "webgui",
    "effect": "new-request"
  },
  {
    "key": "webgui.plan.agentStatus",
    "defaultMs": 3000,
    "label": "计划执行任务状态读取",
    "scope": "webgui",
    "effect": "new-request"
  },
  {
    "key": "webgui.plan.initialization",
    "defaultMs": 300000,
    "label": "计划目录初始化总等待",
    "scope": "webgui",
    "effect": "new-request"
  },
  {
    "key": "webgui.recording.cache",
    "defaultMs": 4000,
    "label": "录像预览本地缓存等待",
    "scope": "webgui",
    "effect": "new-request"
  },
  {
    "key": "webgui.recording.history",
    "defaultMs": 60000,
    "label": "全天记录历史目录读取",
    "scope": "webgui",
    "effect": "new-request"
  },
  {
    "key": "webgui.recording.mutation",
    "defaultMs": 45000,
    "label": "全天记录配置保存",
    "scope": "webgui",
    "effect": "new-request"
  },
  {
    "key": "webgui.recording.preview",
    "defaultMs": 15000,
    "label": "录像预览读取",
    "scope": "webgui",
    "effect": "new-request"
  },
  {
    "key": "webgui.recording.read",
    "defaultMs": 12000,
    "label": "记录资源读取",
    "scope": "webgui",
    "effect": "new-request"
  },
  {
    "key": "webgui.role.configuration",
    "defaultMs": 30000,
    "label": "角色配置请求",
    "scope": "webgui",
    "effect": "new-request"
  },
  {
    "key": "webgui.route.load",
    "defaultMs": 12000,
    "label": "页面模块加载",
    "scope": "webgui",
    "effect": "new-request"
  },
  {
    "key": "webgui.timeouts.request",
    "defaultMs": 5000,
    "label": "超时设置读取和保存",
    "scope": "webgui",
    "effect": "new-request"
  },
  {
    "key": "webgui.vacuum.identity",
    "defaultMs": 10000,
    "label": "扫地机连接身份检查",
    "scope": "webgui",
    "effect": "new-request"
  },
  {
    "key": "webgui.video.decode",
    "defaultMs": 10000,
    "label": "视频数据处理等待",
    "scope": "webgui",
    "effect": "new-request"
  },
  {
    "key": "worker.agentCatalog",
    "defaultMs": 300000,
    "label": "Agent 目录扫描工作线程",
    "scope": "src/manager/agentAdapterCatalogWorkerPool.ts",
    "effect": "next-request"
  },
  {
    "key": "worker.catalog",
    "defaultMs": 300000,
    "label": "目录构建工作线程",
    "scope": "src/manager/managerReadWorkerPool.ts",
    "effect": "next-request"
  },
  {
    "key": "worker.forceTerminate",
    "defaultMs": 5000,
    "label": "读取工作线程强制终止等待",
    "scope": "src/manager/managerReadWorkerPool.ts",
    "effect": "next-request"
  },
  {
    "key": "worker.knowledgeIndex",
    "defaultMs": 30000,
    "label": "知识索引工作线程",
    "scope": "src/manager/managerReadWorkerPool.ts",
    "effect": "next-request"
  },
  {
    "key": "worker.knowledgePage",
    "defaultMs": 30000,
    "label": "知识页面工作线程",
    "scope": "src/manager/managerReadWorkerPool.ts",
    "effect": "next-request"
  },
  {
    "key": "worker.memoryCatalog",
    "defaultMs": 35000,
    "label": "记忆目录工作线程",
    "scope": "src/manager/managerReadWorkerPool.ts",
    "effect": "next-request"
  },
  {
    "key": "worker.messageIndex",
    "defaultMs": 300000,
    "label": "消息索引工作线程",
    "scope": "src/manager/managerReadWorkerPool.ts",
    "effect": "next-request"
  },
  {
    "key": "worker.messageSearch",
    "defaultMs": 2300,
    "label": "消息检索工作线程",
    "scope": "src/manager/managerReadWorkerPool.ts",
    "effect": "next-request"
  },
  {
    "key": "worker.performance",
    "defaultMs": 60000,
    "label": "性能统计工作线程",
    "scope": "src/manager/managerReadWorkerPool.ts",
    "effect": "next-request"
  },
  {
    "key": "worker.read",
    "defaultMs": 30000,
    "label": "Manager 工作线程默认读取",
    "scope": "src/manager/managerReadWorkerPool.ts",
    "effect": "next-request"
  },
  {
    "key": "worker.terminate",
    "defaultMs": 1000,
    "label": "读取工作线程终止宽限",
    "scope": "src/manager/managerReadWorkerPool.ts",
    "effect": "next-request"
  },
  {
    "key": "xiaoai.ssh.auth",
    "defaultMs": 10000,
    "label": "小爱反向隧道 SSH 认证",
    "scope": "plugin-adapters/xiaoai-rabiroute/reverse-tunnel.py",
    "effect": "next-process-start"
  },
  {
    "key": "xiaoai.ssh.banner",
    "defaultMs": 10000,
    "label": "小爱反向隧道 SSH 协议握手",
    "scope": "plugin-adapters/xiaoai-rabiroute/reverse-tunnel.py",
    "effect": "next-process-start"
  },
  {
    "key": "xiaoai.ssh.connect",
    "defaultMs": 10000,
    "label": "小爱反向隧道 SSH 连接",
    "scope": "plugin-adapters/xiaoai-rabiroute/reverse-tunnel.py",
    "effect": "next-process-start"
  }
];
