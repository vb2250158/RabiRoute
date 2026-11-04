const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** Calendar dates, rather than elapsed hours, keep yesterday correct across DST. */
export function qqConversationTime(time: number, now = new Date(), locale = 'zh-CN'): string {
  if (!time) return '';
  const date = new Date(time * 1000);
  if (sameDay(date, now)) return date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
  if (sameDay(date, yesterday)) return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-1, 'day');
  return date.toLocaleDateString(locale, { ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' as const } : {}), month: 'numeric', day: 'numeric' });
}

export function qqTimeBreak(time: number, previous?: number): boolean {
  const date = new Date(time * 1000);
  if (Number.isNaN(date.getTime())) return false;
  return previous === undefined || !sameDay(date, new Date(previous * 1000)) || time - previous >= 300;
}

export function qqMessageTime(time: number, now = new Date(), locale = 'zh-CN'): string {
  const date = new Date(time * 1000), clock = date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  return sameDay(date, now) ? clock : `${qqConversationTime(time, now, locale)} ${clock}`;
}
