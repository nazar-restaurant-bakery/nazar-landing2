import React from "react";
import { isPickupClosed, PICKUP_TIMES, pickupError } from "../lib/cateringPickup";

// Native date pickers cannot disable a weekday. Keep the date/min field and use
// an accessible button calendar so closed days are visibly disabled everywhere.
export default function CateringPickupDate({ value, min, now, lang, label, invalid, onChange }: {
  value: string; min: string; now: number; lang: string; label: string; invalid: boolean; onChange: (date: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [month, setMonth] = React.useState(value.slice(0, 7));
  const year = Number(month.slice(0, 4)), m = Number(month.slice(5, 7));
  const start = new Date(Date.UTC(year, m - 1, 1));
  const count = new Date(Date.UTC(year, m, 0)).getUTCDate();
  const locale = lang === "ar" ? "ar" : lang === "tr" ? "tr-TR" : "en-US";
  const monthLabel = new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(start);
  function move(delta: number) {
    setMonth(new Date(Date.UTC(year, m - 1 + delta, 1)).toISOString().slice(0, 7));
  }
  return <div className="text-sm font-semibold">
    <label htmlFor="catering-pickup-date">{label}</label>
    <div className="flex gap-2">
      <input id="catering-pickup-date" required readOnly type="date" aria-invalid={invalid} aria-describedby={invalid ? "catering-pickup-error" : undefined} min={min} value={value}
        onClick={() => { setMonth(value.slice(0, 7)); setOpen(!open); }} className="mt-1 min-w-0 flex-1 rounded-lg border p-2" />
      <button type="button" aria-label={label} aria-expanded={open} aria-controls="catering-pickup-calendar"
        onClick={() => { setMonth(value.slice(0, 7)); setOpen(!open); }} className="mt-1 rounded-lg border p-2">▦</button>
    </div>
    {open && <div id="catering-pickup-calendar" role="group" aria-label={label} className="mt-2 rounded-lg border p-2">
      <div className="flex items-center justify-between" dir="ltr">
        <button type="button" aria-label={lang === "tr" ? "Önceki ay" : lang === "ar" ? "الشهر السابق" : "Previous month"}
          disabled={month <= min.slice(0, 7)} onClick={() => move(-1)} className="p-2 disabled:opacity-30">←</button>
        <span aria-live="polite">{monthLabel}</span>
        <button type="button" aria-label={lang === "tr" ? "Sonraki ay" : lang === "ar" ? "الشهر التالي" : "Next month"}
          onClick={() => move(1)} className="p-2">→</button>
      </div>
      <div className="grid grid-cols-7 gap-1" dir="ltr">
        {Array.from({ length: 7 }, (_, day) => <span key={`weekday-${day}`} className="text-center text-xs">
          {new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 0, 4 + day)))}</span>)}
        {Array.from({ length: start.getUTCDay() }, (_, i) => <span key={`blank-${i}`} />)}
        {Array.from({ length: count }, (_, i) => {
          const date = `${month}-${String(i + 1).padStart(2, "0")}`;
          const disabled = date < min || isPickupClosed(date) || !PICKUP_TIMES.some(time => !pickupError(date, time, now));
          return <button key={date} type="button" aria-label={date} aria-pressed={date === value} disabled={disabled}
            onClick={() => { onChange(date); setOpen(false); }}
            className={`rounded p-2 disabled:cursor-not-allowed disabled:opacity-30 ${date === value ? "bg-emerald-700 text-white" : "border"}`}>{i + 1}</button>;
        })}
      </div>
    </div>}
  </div>;
}
