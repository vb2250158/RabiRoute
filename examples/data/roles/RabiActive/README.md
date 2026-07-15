# Rabi Active 人格模板

这是 RabiLink 前台连续转录场景的主动智能人格模板。它把“主动”定义为持续维护用户意图模型、主动准备和选择时机，不是逐句回答。模板要求 Agent 不只理解用户说了什么，还持续推测当前任务、真正目标、障碍、下一步、机会和认知状态，并优先使用本地 Agent 把帮助落地。

模板使用 L0 静默观察到 L5 紧急介入的等级，并综合用户收益、意图置信度、时效、打扰成本和行动风险。Codex/Rabi 的主动下行与眼镜上行记录相互独立：没有新转录、没有来源 `taskId` 时，也能因计划、定时事件或工具结果向眼镜投递；所有成功投递仍写回同一会话账本。

## 使用

把当前 Route 的 `agentRoleId` 指向 `RabiActive`，并确保该 Route 启用了：

- `rabilink` 消息端。
- `codex` Agent adapter。
- RabiLink Relay 全局连接。

可在 Route 变量中调整：

```json
{
  "rabilinkAutoReview": "true",
  "rabilinkContinuousReflection": "true",
  "rabilinkReviewIntervalMs": "5000",
  "rabilinkReviewSettleMs": "4000",
  "rabilinkReflectionIntervalMinutes": "30",
  "rabilinkConversationSplitAfterHours": "6"
}
```

- `rabilinkAutoReview`：是否在线程空闲时自动审阅新增观察。
- `rabilinkContinuousReflection`：没有新转录时，是否仍在线程空闲后按周期重新检查目标、计划、承诺和本地工作状态。
- `rabilinkReviewIntervalMs`：检查固定 Codex 线程是否空闲的周期。
- `rabilinkReviewSettleMs`：最后一段转录后等待多久再合并审阅。
- `rabilinkReflectionIntervalMinutes`：连续反思周期，默认 30 分钟；反思可以静默准备，不等于每次都向眼镜说话。
- `rabilinkConversationSplitAfterHours`：多长空档后把旧会话机械归档。跨本地日期也会分卷。

统一会话数据位于当前人格目录：

```text
rabilink-conversation.jsonl
rabilink-conversation-review-state.json
rabilink-conversations/
  index.json
  2026-07-13.jsonl
  2026-07-13-02.jsonl
```

归档只移动原始 JSONL，不调用 Agent 总结。`index.json` 只记录文件名、开始时间、结束时间和条数。

## 真实边界

AIUI 可以在页面前台持续启动单轮 ASR、自动续接并将文本同步到 PC 账本。它不是 Android 前台服务：退出页面、锁屏、系统回收 AIUI 后，不能承诺仍在录音。离线时页面最多保留最近 48 小时、2000 段待同步文本；恢复网络后继续上传。
