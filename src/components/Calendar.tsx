// A month calendar for one date, with quick picks. Past days cannot be chosen.
import { useState } from "react";
import { dateSummary, isoDate, monthGrid, parseDate, quickDates } from "../lib/calendar";

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

export function Calendar({ value, onChange, disabled, label }: {
  value: string | null; onChange: (date: string | null) => void; disabled?: boolean; label: string;
}) {
  const today = isoDate(new Date());
  const [shown, setShown] = useState(() => {
    const d = parseDate(value ?? today);
    return { year: d.getFullYear(), month: d.getMonth() };
  });
  const show = (date: string) => {
    const d = parseDate(date);
    setShown({ year: d.getFullYear(), month: d.getMonth() });
  };
  const pick = (date: string) => { onChange(date); show(date); };
  const move = (by: number) => setShown(({ year, month }) => {
    const d = new Date(year, month + by, 1);
    return { year: d.getFullYear(), month: d.getMonth() };
  });
  const atStart = shown.year * 12 + shown.month <= parseDate(today).getFullYear() * 12 + parseDate(today).getMonth();
  const title = new Date(shown.year, shown.month, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });

  return (
    <div className="cal" role="group" aria-label={label}>
      <div className="cal-quick">
        {quickDates(today).map((q) => (
          <button type="button" key={q.label} className={`toggle${value === q.date ? " is-on" : ""}`} aria-pressed={value === q.date}
            disabled={disabled} onClick={() => pick(q.date)}>{q.label}</button>
        ))}
      </div>
      <div className="cal-month">
        <div className="cal-head">
          <button type="button" className="ghost cal-nav" aria-label="Previous month" disabled={disabled || atStart} onClick={() => move(-1)}>‹</button>
          <span className="cal-title" aria-live="polite">{title}</span>
          <button type="button" className="ghost cal-nav" aria-label="Next month" disabled={disabled} onClick={() => move(1)}>›</button>
        </div>
        <div className="cal-grid">
          {WEEKDAYS.map((d) => <span key={d} className="cal-weekday" aria-hidden>{d}</span>)}
          {monthGrid(shown.year, shown.month).map((date) => {
            const d = parseDate(date);
            const outside = d.getMonth() !== shown.month;
            const past = date < today;
            return (
              <button type="button" key={date} disabled={disabled || past}
                className={["cal-day", outside && "is-outside", date === today && "is-today", date === value && "is-on"].filter(Boolean).join(" ")}
                aria-pressed={date === value}
                aria-label={d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
                onClick={() => pick(date)}>{d.getDate()}</button>
            );
          })}
        </div>
      </div>
      <div className="cal-summary">
        {value ? <>
          <span>Comes back <b>{dateSummary(value, today)}</b></span>
          <button type="button" className="ghost" disabled={disabled} onClick={() => onChange(null)}>Clear</button>
        </> : <span className="account-muted">No date: only the agent check or Resume ends the hold.</span>}
      </div>
    </div>
  );
}
