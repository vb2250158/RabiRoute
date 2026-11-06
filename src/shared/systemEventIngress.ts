import type { VoiceTranscriptEventRecord } from "../history.js";
import type { ForwardRouteKind, ForwardTemplateValues } from "../routing/types.js";

/** Internal Route child-process input. Platform owners normalize their event before crossing stdin. */
export type SystemEventIngress = Readonly<{
  routeKind: ForwardRouteKind;
  record: VoiceTranscriptEventRecord;
  templateValues: ForwardTemplateValues;
}>;

export const SYSTEM_EVENT_STDIN_FLAG = "--system-event-stdin";
export const SYSTEM_EVENT_RESULT_PREFIX = "RABIROUTE_SYSTEM_EVENT_DELIVERY_RESULT:";
