// Dates as local YYYY-MM-DD strings, and the month grid of the hold calendar.

export const isoDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export function parseDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(iso: string, days: number): string {
  const d = parseDate(iso);
  d.setDate(d.getDate() + days);
  return isoDate(d);
}

/** The 6 weeks that show a month, from the Sunday on or before its first day. */
export function monthGrid(year: number, month: number): string[] {
  const first = new Date(year, month, 1);
  const start = isoDate(new Date(year, month, 1 - first.getDay()));
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

/** The next date after `today` that falls on `weekday` (0 is Sunday), at least one day later. */
export function nextWeekday(today: string, weekday: number): string {
  const ahead = (weekday - parseDate(today).getDay() + 7) % 7 || 7;
  return addDays(today, ahead);
}

/** Quick picks for the date on which a hold ends. */
export function quickDates(today: string): { label: string; date: string }[] {
  const monday = nextWeekday(today, 1);
  return [
    { label: "Tomorrow", date: addDays(today, 1) },
    { label: "Next Monday", date: monday },
    { label: "In 1 week", date: addDays(today, 7) },
    { label: "Monday after next", date: addDays(monday, 7) },
  ];
}

/** "Mon, Dec 7 · in 10 days". */
export function dateSummary(date: string, today: string): string {
  const days = Math.round((parseDate(date).getTime() - parseDate(today).getTime()) / 86_400_000);
  const label = parseDate(date).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const when = days === 0 ? "today" : days === 1 ? "tomorrow" : days > 0 ? `in ${days} days` : `${-days} days ago`;
  return `${label} · ${when}`;
}
