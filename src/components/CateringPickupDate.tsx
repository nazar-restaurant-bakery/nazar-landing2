import React from "react";
import { firstPickup, isPickupClosed, newYorkDate, PICKUP_TIMES, pickupError } from "../lib/cateringPickup";

// Native date pickers cannot disable a weekday. Keep the date/min field and use
// an accessible button calendar so closed days are visibly disabled everywhere.
export default function CateringPickupDate({ value, min, now, lang, label, invalid, onChange }: {
  value: string; min: string; now: number; lang: string; label: string; invalid: boolean; onChange: (date: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const today = newYorkDate(new Date(now));
  const todayMonth = today.slice(0, 7);
  const firstAvailable = firstPickup(now).date;
  const [month, setMonth] = React.useState(value.slice(0, 7));
  const locale = lang === "ar" ? "ar" : lang === "tr" ? "tr-TR" : "en-US";
  const t = (en: string, tr: string, ar: string) => lang === "tr" ? tr : lang === "ar" ? ar : en;
  const shift = (ym: string, delta: number) => {
    const [y, mo] = ym.split("-").map(Number);
    return new Date(Date.UTC(y, mo - 1 + delta, 1)).toISOString().slice(0, 7);
  };
  // Show the order day and the preparation days whenever they are next to the
  // viewed month, so the customer sees today, the wait and the pickup together.
  const months = month === todayMonth ? [month] : month === shift(todayMonth, 1) ? [todayMonth, month] : [month];
  function openCalendar() { setMonth(value.slice(0, 7) < todayMonth ? todayMonth : value.slice(0, 7)); setOpen(!open); }
  function grid(ym: string) {
    const year = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7));
    const start = new Date(Date.UTC(year, m - 1, 1));
    const count = new Date(Date.UTC(year, m, 0)).getUTCDate();
    const monthLabel = new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(start);
    return <div key={ym} className="mt-1">
      <div className="text-center" aria-live="polite">{monthLabel}</div>
      <div className="grid grid-cols-7 gap-1" dir="ltr">
        {Array.from({ length: 7 }, (_, day) => <span key={`weekday-${day}`} className="text-center text-xs">
          {new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 0, 4 + day)))}</span>)}
        {Array.from({ length: start.getUTCDay() }, (_, i) => <span key={`blank-${i}`} />)}
        {Array.from({ length: count }, (_, i) => {
          const date = `${ym}-${String(i + 1).padStart(2, "0")}`;
          const closed = isPickupClosed(date);
          const isToday = date === today;
          const waiting = !closed && date > today && date < firstAvailable;
          const disabled = date < min || closed || !PICKUP_TIMES.some(time => !pickupError(date, time, now));
          const selected = date === value;
          const tone = selected ? "bg-emerald-700 text-white"
            : isToday ? "border-2 border-emerald-700 font-bold text-emerald-800"
            : waiting ? "bg-amber-100 text-amber-800"
            : disabled ? "opacity-30" : "border";
          const note = isToday ? t("today, order day", "bugün, sipariş günü", "اليوم، يوم الطلب")
            : waiting ? t("preparation day", "hazırlık günü", "يوم تحضير")
            : closed ? t("closed", "kapalı", "مغلق")
            : selected ? t("pickup day", "teslim alma günü", "يوم الاستلام") : "";
          return <button key={date} type="button" aria-label={note ? `${date} (${note})` : date} title={note || undefined}
            aria-pressed={selected} disabled={disabled}
            onClick={() => { onChange(date); setOpen(false); }}
            className={`rounded p-2 disabled:cursor-not-allowed ${tone}`}>{i + 1}</button>;
        })}
      </div>
    </div>;
  }
  return <div className="text-sm font-semibold">
    <label htmlFor="catering-pickup-date">{label}</label>
    <div className="flex gap-2">
      <input id="catering-pickup-date" required readOnly type="date" aria-invalid={invalid} aria-describedby={invalid ? "catering-pickup-error" : undefined} min={min} value={value}
        onClick={openCalendar} className="mt-1 min-w-0 flex-1 rounded-lg border p-2" />
      <button type="button" aria-label={label} aria-expanded={open} aria-controls="catering-pickup-calendar"
        onClick={openCalendar} className="mt-1 rounded-lg border p-2">▦</button>
    </div>
    {open && <div id="catering-pickup-calendar" role="group" aria-label={label} className="mt-2 rounded-lg border p-2">
      <div className="flex items-center justify-between" dir="ltr">
        <button type="button" aria-label={t("Previous month", "Önceki ay", "الشهر السابق")}
          disabled={month <= todayMonth} onClick={() => setMonth(shift(month, -1))} className="p-2 disabled:opacity-30">←</button>
        <button type="button" aria-label={t("Next month", "Sonraki ay", "الشهر التالي")}
          onClick={() => setMonth(shift(month, 1))} className="p-2">→</button>
      </div>
      {months.map(grid)}
      <div className="mt-2 flex flex-wrap gap-3 text-xs font-normal">
        <span><span className="mr-1 inline-block h-3 w-3 rounded border-2 border-emerald-700 align-middle" />{t("Today (order day)", "Bugün (sipariş günü)", "اليوم (يوم الطلب)")}</span>
        <span><span className="mr-1 inline-block h-3 w-3 rounded bg-amber-100 align-middle" />{t("Preparation days (3 days)", "Hazırlık günleri (3 gün)", "أيام التحضير (3 أيام)")}</span>
        <span><span className="mr-1 inline-block h-3 w-3 rounded bg-emerald-700 align-middle" />{t("Your pickup day", "Teslim alma günün", "يوم الاستلام")}</span>
        <span><span className="mr-1 inline-block h-3 w-3 rounded border opacity-30 align-middle" />{t("Closed (Wednesday)", "Kapalı (Çarşamba)", "مغلق (الأربعاء)")}</span>
      </div>
    </div>}
  </div>;
}
