// Saat dilimi hesapları (Intl ile; DST dahil)

const WEEKDAY_ISO: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  isoWeekday: number; // 1=Pzt … 7=Paz
}

export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    weekday: 'short',
    hourCycle: 'h23'
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    second: Number(get('second')),
    isoWeekday: WEEKDAY_ISO[get('weekday')]
  };
}

function timeZoneOffsetMs(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  const wallClockAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wallClockAsUtc - Math.floor(date.getTime() / 1000) * 1000;
}

// Verilen saat dilimindeki takvim gününün 00:00'ının UTC karşılığı
export function zonedMidnightUtc(year: number, month: number, day: number, timeZone: string): Date {
  const guess = Date.UTC(year, month - 1, day);
  let ts = guess - timeZoneOffsetMs(new Date(guess), timeZone);
  ts = guess - timeZoneOffsetMs(new Date(ts), timeZone);
  return new Date(ts);
}

// `at` anının, verilen saat dilimindeki takvim gününün başlangıcı (UTC olarak)
export function startOfLocalDay(at: Date, timeZone: string): Date {
  const local = zonedParts(at, timeZone);
  return zonedMidnightUtc(local.year, local.month, local.day, timeZone);
}

// "09:00" / "09:00:00" → gün içindeki dakika
export function timeToMinutes(value: string): number {
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + (minute || 0);
}
