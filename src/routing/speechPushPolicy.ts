import {
  matchSpeechTriggerKeyword,
  normalizeSpeechPushMode,
  normalizeSpeechTriggerKeywords,
  type SpeechPushMode
} from "../shared/gatewayConfigModel.js";

export type SpeechPushDecision = {
  mode: SpeechPushMode;
  shouldNotifyAgent: boolean;
  matchedKeyword?: string;
  reason: "hot" | "keyword_matched" | "keyword_not_matched" | "keyword_not_configured";
};

export function decideSpeechPush(text: string, modeValue: unknown, keywordValue: unknown): SpeechPushDecision {
  const mode = normalizeSpeechPushMode(modeValue);
  if (mode === "hot") return { mode, shouldNotifyAgent: true, reason: "hot" };
  const keywords = normalizeSpeechTriggerKeywords(keywordValue);
  if (keywords.length === 0) return { mode, shouldNotifyAgent: false, reason: "keyword_not_configured" };
  const matchedKeyword = matchSpeechTriggerKeyword(text, keywords);
  return matchedKeyword
    ? { mode, shouldNotifyAgent: true, matchedKeyword, reason: "keyword_matched" }
    : { mode, shouldNotifyAgent: false, reason: "keyword_not_matched" };
}
