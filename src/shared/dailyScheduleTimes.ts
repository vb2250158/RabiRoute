export type TimeOfDay = {
  hours: number;
  minutes: number;
  seconds: number;
};

export function parseTimeOfDay(value: string | undefined): TimeOfDay | null {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(value || "").trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] ?? "0");
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59 || seconds < 0 || seconds > 59) {
    return null;
  }
  return { hours, minutes, seconds };
}

/** Resolve a complete daily list, returning null for invalid input without partial execution. */
export function normalizeDailyScheduleTimes(schedule: { timeOfDays?: unknown; timeOfDay?: unknown }): string[] | null {
  const values = Object.hasOwn(schedule, "timeOfDays") ? schedule.timeOfDays : [schedule.timeOfDay];
  if (!Array.isArray(values) || values.length === 0) return null;
  const times = new Set<string>();
  const pad = (value: number) => String(value).padStart(2, "0");
  for (const value of values) {
    if (typeof value !== "string") return null;
    const time = parseTimeOfDay(value);
    if (!time) return null;
    times.add(`${pad(time.hours)}:${pad(time.minutes)}${time.seconds ? `:${pad(time.seconds)}` : ""}`);
  }
  return [...times].sort();
}
