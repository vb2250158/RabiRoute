export type PlanSortPalette = {
  accent: string;
  background: string;
  foreground: string;
};

export enum PlanImportanceLevel {
  Highest = 0,
  High = 1,
  Medium = 2,
  Low = 3,
  Unset = 4
}

export enum PlanUrgencyLevel {
  Critical = 0,
  High = 1,
  Medium = 2,
  Low = 3,
  Unset = 4
}

export type PlanLevelPresentation = {
  labelZh: string;
  labelEn: string;
  palette: PlanSortPalette;
};

export const PLAN_IMPORTANCE_PRESENTATION: Record<PlanImportanceLevel, PlanLevelPresentation> = {
  [PlanImportanceLevel.Highest]: {
    labelZh: "最高",
    labelEn: "Highest",
    palette: { accent: "#dc2626", background: "#fef2f2", foreground: "#b91c1c" }
  },
  [PlanImportanceLevel.High]: {
    labelZh: "高",
    labelEn: "High",
    palette: { accent: "#f59e0b", background: "#fff7e6", foreground: "#a96008" }
  },
  [PlanImportanceLevel.Medium]: {
    labelZh: "中",
    labelEn: "Medium",
    palette: { accent: "#2563eb", background: "#eff6ff", foreground: "#1d4ed8" }
  },
  [PlanImportanceLevel.Low]: {
    labelZh: "低",
    labelEn: "Low",
    palette: { accent: "#16a34a", background: "#eaf8ef", foreground: "#15803d" }
  },
  [PlanImportanceLevel.Unset]: {
    labelZh: "未设置",
    labelEn: "Not set",
    palette: { accent: "#8795a1", background: "#eef1f4", foreground: "#687786" }
  }
};

export const PLAN_URGENCY_PRESENTATION: Record<PlanUrgencyLevel, PlanLevelPresentation> = {
  [PlanUrgencyLevel.Critical]: {
    labelZh: "紧急",
    labelEn: "Critical",
    palette: { accent: "#dc2626", background: "#fef2f2", foreground: "#b91c1c" }
  },
  [PlanUrgencyLevel.High]: {
    labelZh: "高",
    labelEn: "High",
    palette: { accent: "#f97316", background: "#fff1ed", foreground: "#c2410c" }
  },
  [PlanUrgencyLevel.Medium]: {
    labelZh: "中",
    labelEn: "Medium",
    palette: { accent: "#eab308", background: "#fefce8", foreground: "#a16207" }
  },
  [PlanUrgencyLevel.Low]: {
    labelZh: "低",
    labelEn: "Low",
    palette: { accent: "#2563eb", background: "#eff6ff", foreground: "#1d4ed8" }
  },
  [PlanUrgencyLevel.Unset]: {
    labelZh: "未设置",
    labelEn: "Not set",
    palette: { accent: "#8795a1", background: "#eef1f4", foreground: "#687786" }
  }
};

const LEGACY_IMPORTANCE_LEVELS: Record<string, PlanImportanceLevel> = {
  "0": PlanImportanceLevel.Highest,
  p0: PlanImportanceLevel.Highest,
  critical: PlanImportanceLevel.Highest,
  highest: PlanImportanceLevel.Highest,
  "1:非常重要": PlanImportanceLevel.Highest,
  "1：非常重要": PlanImportanceLevel.Highest,
  最高: PlanImportanceLevel.Highest,
  "1": PlanImportanceLevel.High,
  p1: PlanImportanceLevel.High,
  high: PlanImportanceLevel.High,
  urgent: PlanImportanceLevel.High,
  "2:重要": PlanImportanceLevel.High,
  "2：重要": PlanImportanceLevel.High,
  高: PlanImportanceLevel.High,
  "2": PlanImportanceLevel.Medium,
  p2: PlanImportanceLevel.Medium,
  medium: PlanImportanceLevel.Medium,
  normal: PlanImportanceLevel.Medium,
  "3:一般": PlanImportanceLevel.Medium,
  "3：一般": PlanImportanceLevel.Medium,
  中: PlanImportanceLevel.Medium,
  一般: PlanImportanceLevel.Medium,
  "3": PlanImportanceLevel.Low,
  p3: PlanImportanceLevel.Low,
  p4: PlanImportanceLevel.Low,
  low: PlanImportanceLevel.Low,
  "4:不重要": PlanImportanceLevel.Low,
  "4：不重要": PlanImportanceLevel.Low,
  低: PlanImportanceLevel.Low,
  不重要: PlanImportanceLevel.Low
};

const LEGACY_URGENCY_LEVELS: Record<string, PlanUrgencyLevel> = {
  "0": PlanUrgencyLevel.Critical,
  critical: PlanUrgencyLevel.Critical,
  urgent: PlanUrgencyLevel.Critical,
  紧急: PlanUrgencyLevel.Critical,
  "1": PlanUrgencyLevel.High,
  high: PlanUrgencyLevel.High,
  高: PlanUrgencyLevel.High,
  "2": PlanUrgencyLevel.Medium,
  medium: PlanUrgencyLevel.Medium,
  normal: PlanUrgencyLevel.Medium,
  中: PlanUrgencyLevel.Medium,
  "3": PlanUrgencyLevel.Low,
  low: PlanUrgencyLevel.Low,
  低: PlanUrgencyLevel.Low
};

function normalizedLegacyValue(value: unknown): string {
  return String(value ?? "").trim().toLocaleLowerCase().replace(/\s+/g, "");
}

export function resolvePlanImportanceLevel(value: unknown): PlanImportanceLevel {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= PlanImportanceLevel.Unset) {
    return value as PlanImportanceLevel;
  }
  return LEGACY_IMPORTANCE_LEVELS[normalizedLegacyValue(value)] ?? PlanImportanceLevel.Unset;
}

export function resolvePlanUrgencyLevel(value: unknown, dueAt?: string, now = Date.now()): PlanUrgencyLevel {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= PlanUrgencyLevel.Unset) {
    return value as PlanUrgencyLevel;
  }
  const legacy = LEGACY_URGENCY_LEVELS[normalizedLegacyValue(value)];
  if (legacy !== undefined) return legacy;
  const dueTime = Date.parse(String(dueAt || ""));
  if (!Number.isFinite(dueTime)) return PlanUrgencyLevel.Unset;
  const remainingDays = (dueTime - now) / (24 * 60 * 60_000);
  if (remainingDays <= 1) return PlanUrgencyLevel.Critical;
  if (remainingDays <= 3) return PlanUrgencyLevel.High;
  if (remainingDays <= 7) return PlanUrgencyLevel.Medium;
  return PlanUrgencyLevel.Low;
}
