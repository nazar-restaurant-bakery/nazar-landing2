import React from "react";
import TurnstileWidget from "./TurnstileWidget";
import { useLang } from "./Language";
import { turnstileSiteKey } from "../lib/formConfig";

type Selection = { id: string; size: 10 | 20 | 30 | 50; title: string; price: number };
const COPY = {
  en: { title: "Pay for standard catering", intro: "Pickup only. Please order at least 3 days ahead. Custom dishes still need a quote.",
    name: "Name", email: "Email for receipt", phone: "Phone (optional)", date: "Pickup date", time: "Pickup time (New York)", note: "Preparation note (optional)",
    pay: "Continue to secure payment", waiting: "Preparing secure payment…", error: "Payment could not be opened. Please contact Nazar before trying again; no confirmed payment is shown here.",
    selection: "Select a priced tray above to continue.", verify: "Complete the security check first.", tax: "Tax and final total are shown on Clover's secure payment page." },
  tr: { title: "Standart catering için ödeme", intro: "Yalnız restorandan teslim. En az 3 gün önceden sipariş verin. Özel yemekler için teklif gerekir.",
    name: "Ad", email: "Makbuz için e-posta", phone: "Telefon (isteğe bağlı)", date: "Teslim tarihi", time: "Teslim saati (New York)", note: "Hazırlık notu (isteğe bağlı)",
    pay: "Güvenli ödemeye geç", waiting: "Güvenli ödeme hazırlanıyor…", error: "Ödeme açılamadı. Yeniden denemeden önce Nazar ile görüşün; burada onaylı ödeme görünmüyor.",
    selection: "Devam etmek için yukarıdan fiyatlı bir tepsi seçin.", verify: "Önce güvenlik doğrulamasını tamamlayın.", tax: "Vergi ve son toplam Clover'ın güvenli ödeme sayfasında gösterilir." },
  ar: { title: "ادفع لطلب الطعام القياسي", intro: "الاستلام من المطعم فقط. اطلب قبل 3 أيام على الأقل. الأطباق الخاصة تحتاج إلى عرض سعر.",
    name: "الاسم", email: "البريد الإلكتروني للإيصال", phone: "الهاتف (اختياري)", date: "تاريخ الاستلام", time: "وقت الاستلام (نيويورك)", note: "ملاحظات التحضير (اختياري)",
    pay: "متابعة الدفع الآمن", waiting: "جارٍ إعداد الدفع…", error: "تعذر فتح الدفع. يرجى الاتصال بنزار قبل المحاولة مجددًا؛ لا يظهر هنا دفع مؤكد.",
    selection: "اختر صينية بسعر محدد أعلاه للمتابعة.", verify: "أكمل التحقق الأمني أولاً.", tax: "تظهر الضريبة والمبلغ النهائي في صفحة الدفع الآمنة من Clover." },
} as const;

function newYorkPickup(date: string, time: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
  // 11:00–19:00 has no DST ambiguity. Check both offsets against the actual
  // New York civil time so a customer's own timezone cannot shift pickup.
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit",
    minute: "2-digit", hourCycle: "h23" });
  for (const offset of ["-04:00", "-05:00"]) {
    const candidate = new Date(`${date}T${time}:00${offset}`);
    if (!Number.isFinite(candidate.getTime())) continue;
    const parts = Object.fromEntries(formatter.formatToParts(candidate).map(({ type, value }) => [type, value]));
    if (`${parts.year}-${parts.month}-${parts.day}` === date &&
        `${parts.hour}:${parts.minute}` === time) return candidate.toISOString();
  }
  return null;
}

export default function CateringCheckoutForm({ selections }: { selections: Selection[] }) {
  const { lang } = useLang();
  const copy = COPY[lang];
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [date, setDate] = React.useState("");
  const [time, setTime] = React.useState("");
  const [note, setNote] = React.useState("");
  const [token, setToken] = React.useState("");
  const [resetSignal, setResetSignal] = React.useState(0);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const inFlight = React.useRef(false);
  const onToken = React.useCallback((value: string) => setToken(value), []);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || !selections.length) return;
    if (!token || !turnstileSiteKey) { setMessage(copy.verify); return; }
    const pickupAt = newYorkPickup(date, time);
    if (!pickupAt) { setMessage(copy.error); return; }
    inFlight.current = true;
    setBusy(true);
    setMessage("");
    try {
      const requestId = crypto.randomUUID();
      const response = await fetch("/api/catering/checkout", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, requestKind: "standard", fulfillmentMethod: "pickup",
          name, email, phone, preparationNote: note, pickupAt, turnstileToken: token,
          selections: selections.map(({ id, size }) => ({ id, size, quantity: 1 })) }),
      });
      const result = await response.json() as { code?: string; orderId?: string;
        requestId?: string; checkoutUrl?: string };
      if (!response.ok || result.code !== "checkout_ready" ||
          !result.orderId || !result.requestId ||
          !/^https:\/\/([a-z0-9-]+\.)*clover\.com\//i.test(result.checkoutUrl ?? "")) {
        setMessage(copy.error);
        return;
      }
      sessionStorage.setItem("nazar-site-order-reference-v1", JSON.stringify({
        orderId: result.orderId, requestId: result.requestId,
      }));
      window.location.assign(result.checkoutUrl!);
    } catch { setMessage(copy.error); }
    finally {
      setBusy(false);
      setToken("");
      setResetSignal((value) => value + 1);
      inFlight.current = false;
    }
  }

  return <section className="mt-6 rounded-2xl border border-emerald-300 bg-white p-5" aria-labelledby="catering-checkout-title">
    <h4 id="catering-checkout-title" className="text-lg font-extrabold">{copy.title}</h4>
    <p className="mt-2 text-sm text-zinc-700">{copy.intro}</p>
    {!selections.length ? <p className="mt-4 text-sm text-zinc-600">{copy.selection}</p> :
      <form onSubmit={submit} className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="text-sm font-semibold">{copy.name}<input required maxLength={150} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} className="mt-1 w-full rounded-lg border p-2" /></label>
        <label className="text-sm font-semibold">{copy.email}<input required type="email" maxLength={254} autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} className="mt-1 w-full rounded-lg border p-2" /></label>
        <label className="text-sm font-semibold">{copy.phone}<input type="tel" maxLength={30} autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} className="mt-1 w-full rounded-lg border p-2" /></label>
        <label className="text-sm font-semibold">{copy.date}<input required type="date" value={date} onChange={(e) => setDate(e.target.value)} className="mt-1 w-full rounded-lg border p-2" /></label>
        <label className="text-sm font-semibold">{copy.time}<select required value={time} onChange={(e) => setTime(e.target.value)} className="mt-1 w-full rounded-lg border p-2"><option value="">—</option>{Array.from({ length: 17 }, (_, index) => { const hour = 11 + Math.floor(index / 2); const minute = index % 2 ? "30" : "00"; const slot = `${String(hour).padStart(2, "0")}:${minute}`; return <option key={slot} value={slot}>{slot}</option>; })}</select></label>
        <label className="text-sm font-semibold sm:col-span-2">{copy.note}<textarea maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} className="mt-1 w-full rounded-lg border p-2" /></label>
        <div className="sm:col-span-2"><TurnstileWidget onToken={onToken} resetSignal={resetSignal} /></div>
        <p className="text-xs text-zinc-600 sm:col-span-2">{copy.tax}</p>
        {message && <p role="alert" className="text-sm text-red-800 sm:col-span-2">{message}</p>}
        <button type="submit" disabled={busy || !token} className="rounded-full bg-[#1E7A3A] px-6 py-3 font-bold text-white disabled:opacity-50 sm:col-span-2">{busy ? copy.waiting : copy.pay}</button>
      </form>}
  </section>;
}
