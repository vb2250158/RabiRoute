import type { MessageAdapterScanResult } from "../types";

export type MessageEndpointCardContext = Readonly<{
  messageEndpointType: string;
  routeId: string;
  active?: boolean;
  scan?: MessageAdapterScanResult;
  scanError?: string;
  scanLoading?: boolean;
  refreshScan?: () => void | Promise<void>;
}>;
