import type { VacuumVideoSession } from "./homeDeviceClient";

/** Presentation only: the server session remains the source of connection state. */
export function vacuumVideoPresentation(input: {
 session?: VacuumVideoSession; starting: boolean; stopping: boolean;
 passwordSaved: boolean; editingPassword: boolean; rendered: boolean;
}) {
 const sessionOpen = Boolean(input.session?.sessionId && input.session.state !== "stopped");
 const passwordManagement = !input.starting && !input.stopping && !sessionOpen;
 const phase = input.stopping ? "stopping" : input.starting ? "starting"
  : input.session?.state === "streaming" ? "streaming"
  : input.session?.state === "connecting" ? "connecting"
  : input.session?.state === "failed" ? "failed" : "idle";
 const label = { idle: "视频未开启", starting: "正在验证并连接", connecting: "正在连接摄像头",
  streaming: input.rendered ? "实时画面" : "正在加载画面", failed: "视频连接失败", stopping: "正在退出视频" }[phase];
 return { sessionOpen, passwordManagement, passwordEntry: passwordManagement && (!input.passwordSaved || input.editingPassword), phase, label };
}
