import type { DesktopPetPackSummary } from "./desktopPetClient";

const actionLabels: Record<string, string> = {
  idle: "待机", thinking: "思考", talking: "说话", success: "完成", concerned: "担心",
  attention: "回应", sleep: "睡觉", drag: "拖动", "idle-reading": "读书",
  "idle-wave": "挥手", "idle-pout": "噘嘴", "idle-cover-mouth": "捂嘴",
  move: "走路", "teleport-out": "传送离开", "teleport-in": "传送抵达"
};

export function desktopPetActions(pack: DesktopPetPackSummary) {
  return Object.entries(pack.states).map(([id, animation]) => {
    const uses: string[] = [];
    if (id === "idle") uses.push("默认待机");
    if (id === pack.idleBehavior?.sleepState) uses.push("空闲后休眠");
    if (pack.idleBehavior?.randomStates.includes(id)) uses.push("空闲时随机播放");
    if (id === "attention") uses.push("点击桌宠");
    if (id === "drag") uses.push("拖动桌宠");
    if (id === "move") uses.push("闲逛时走路");
    if (id === "teleport-out" || id === "teleport-in") uses.push("跨屏传送");
    if (id === "success") uses.push("任务完成");
    if (id === "concerned") uses.push("任务未完成或连接中断");
    return {
      id, animation, name: actionLabels[id] || id,
      group: id === "idle" || id === pack.idleBehavior?.sleepState ? "待机与休眠"
        : ["success", "concerned"].includes(id) ? "任务与连接反馈"
        : ["attention", "drag"].includes(id) ? "鼠标交互"
        : ["move", "teleport-out", "teleport-in"].includes(id) ? "移动与传送"
        : pack.idleBehavior?.randomStates.includes(id) ? "空闲随机动作" : "其他动作",
      uses: uses.length ? uses : ["手动播放"],
      staticImage: animation.type === "png-sequence" && animation.assets.length === 1
    };
  });
}
