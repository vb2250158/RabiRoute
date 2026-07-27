import type { RolePlan } from "./types";

export type PlanPresentationPalette = RolePlan["presentation"]["palette"];
export type PlanKnowledgeView = "current" | "plans" | "recent_memory" | "archived";

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

export function plansForKnowledgeView(plans: RolePlan[], view: PlanKnowledgeView): RolePlan[] {
  if (view === "recent_memory") return [];
  return plans.filter((plan) => plan.presentation.views.includes(view));
}
