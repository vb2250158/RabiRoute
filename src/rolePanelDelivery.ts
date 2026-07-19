import type { ForwardDeliveryStatus } from "./forwarding.js";

export function rolePanelDeliveryExitCode(status: ForwardDeliveryStatus): 0 | 1 | 2 {
  if (status === "delivered") return 0;
  if (status === "failed") return 1;
  return 2;
}
