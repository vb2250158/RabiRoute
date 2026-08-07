import type { RolePlan } from "./types";

export type PlanPresentationPalette = RolePlan["presentation"]["palette"];
export type PlanKnowledgeView = "plans" | "recent_memory" | "archived";
export type PlanListSortMode = "status" | "updated";

export const FALLBACK_PLAN_PRESENTATION_PALETTE: PlanPresentationPalette = {
  accent: "#8795a1",
  background: "#eef1f4",
  foreground: "#687786"
};

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

function normalizedColor(value: unknown, fallback: string): string {
  return typeof value === "string" && HEX_COLOR.test(value) ? value.toLowerCase() : fallback;
}

export function normalizePlanPresentationPalette(value: Partial<PlanPresentationPalette> | undefined): PlanPresentationPalette {
  return {
    accent: normalizedColor(value?.accent, FALLBACK_PLAN_PRESENTATION_PALETTE.accent),
    background: normalizedColor(value?.background, FALLBACK_PLAN_PRESENTATION_PALETTE.background),
    foreground: normalizedColor(value?.foreground, FALLBACK_PLAN_PRESENTATION_PALETTE.foreground)
  };
}

export function planCardStyle(palette: PlanPresentationPalette): Record<string, string> {
  return { "--plan-tone": palette.accent };
}

export function planStatusStyle(palette: PlanPresentationPalette): Record<string, string> {
  return {
    backgroundColor: palette.background,
    color: palette.foreground
  };
}

export function planDescriptionForDisplay(plan: Pick<RolePlan, "title" | "focus">): string {
  const description = String(plan.focus || "").trim();
  const title = String(plan.title || "").trim();
  return description && description !== title ? description : "";
}

export function planTitleForDirectory(title: string): string {
  const normalized = String(title || "").trim();
  const withoutLeadingTags = normalized.replace(/^(?:\[[^\]\r\n]+\]\s*)+/, "").trim();
  return withoutLeadingTags || normalized;
}

export function formatPlanRelativeTime(value: string, now = Date.now(), locale: "zh" | "en" = "zh"): string {
  const updatedAt = new Date(value).getTime();
  if (!Number.isFinite(updatedAt)) return locale === "en" ? "Unknown" : "未知";
  const elapsed = Math.max(0, now - updatedAt);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (elapsed < minute) return locale === "en" ? "Just now" : "刚刚";
  if (elapsed < hour) {
    const minutes = Math.floor(elapsed / minute);
    return locale === "en" ? `${minutes} min ago` : `${minutes}分钟前`;
  }
  if (elapsed < day) {
    const hours = Math.floor(elapsed / hour);
    return locale === "en" ? `${hours} hr ago` : `${hours}小时前`;
  }
  const days = Math.floor(elapsed / day);
  if (days < 30) return locale === "en" ? `${days} day${days === 1 ? "" : "s"} ago` : `${days}天前`;
  if (days < 365) {
    const months = Math.floor(days / 30);
    return locale === "en" ? `${months} mo ago` : `${months}个月前`;
  }
  const years = Math.floor(days / 365);
  return locale === "en" ? `${years} yr ago` : `${years}年前`;
}

export function formatPlanVideoDuration(duration: number | undefined): string {
  if (!Number.isFinite(duration)) return "--:--";
  const seconds = Math.max(0, Math.round(duration || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

export function plansForKnowledgeView(plans: RolePlan[], view: PlanKnowledgeView): RolePlan[] {
  if (view === "recent_memory") return [];
  return plans.filter((plan) => plan.presentation.views.includes(view));
}
