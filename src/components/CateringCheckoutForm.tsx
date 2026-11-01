import React from "react";
import TurnstileWidget from "./TurnstileWidget";
import { useLang } from "./Language";
import { turnstileSiteKey } from "../lib/formConfig";
import { t } from "./i18n";
import { trackBeginCheckout } from "../lib/analytics";

import CateringPickupDate from "./CateringPickupDate";
import { CATERING_LEAD_TIME_MS, firstPickup, newYorkDate, newYorkPickup, PICKUP_TIMES, pickupError } from "../lib/cateringPickup";

type Selection = { id: string; size: 10 | 20 | 30 | 50; title: string; price: number };
const COPY = {
  en: { title: "Pay for standard catering", intro: "Pickup only. Please order at least 3 days ahead. Custom dishes still need a quote.",
    name: "Name", email: "Email for receipt", phone: "Phone (optional)", date: "Pickup date", time: "Pickup time (New York)", note: "Preparation note (optional)",
    pay: "Continue to secure payment", waiting: "Preparing secure payment…", error: "Payment could not be opened. Please contact Nazar before trying again; no confirmed payment is shown here.",
    pickupErrors: { date: "Choose a valid pickup date and time.", closed: "Pickup is unavailable on Wednesdays. Choose another date.", hours: "Choose a pickup time from 11:00 to 19:00 New York time, in 30-minute steps.", lead: "Pickup requires 72 hours after payment. Choose a later slot; 20 minutes are reserved for checkout." },
    selection: "Select a priced tray above to continue.", verify: "Complete the security check first.", tax: "Tax and final total are shown on Clover's secure payment page.", consentNote: "Optional. Payment does not require it." },
  tr: { title: "Standart catering için ödeme", intro: "Yalnız restorandan teslim. En az 3 gün önceden sipariş verin. Özel yemekler için teklif gerekir.",
    name: "Ad", email: "Makbuz için e-posta", phone: "Telefon (isteğe bağlı)", date: "Teslim tarihi", time: "Teslim saati (New York)", note: "Hazırlık notu (isteğe bağlı)",
    pay: "Güvenli ödemeye geç", waiting: "Güvenli ödeme hazırlanıyor…", error: "Ödeme açılamadı. Yeniden denemeden önce Nazar ile görüşün; burada onaylı ödeme görünmüyor.",
    pickupErrors: { date: "Geçerli bir teslim tarihi ve saati seçin.", closed: "Çarşamba günleri teslim yapılamaz. Başka bir tarih seçin.", hours: "New York saatiyle 11:00–19:00 arasında tam veya buçuk saat seçin.", lead: "Teslim için ödemeden sonra 72 saat gerekir. Daha ileri bir saat seçin; ödeme için 20 dakika ayrılır." },
    selection: "Devam etmek için yukarıdan fiyatlı bir tepsi seçin.", verify: "Önce güvenlik doğrulamasını tamamlayın.", tax: "Vergi ve son toplam Clover'ın güvenli ödeme sayfasında gösterilir.", consentNote: "İsteğe bağlı. Ödeme için gerekmez." },
  ar: { title: "ادفع لطلب الطعام القياسي", intro: "الاستلام من المطعم فقط. اطلب قبل 3 أيام على الأقل. الأطباق الخاصة تحتاج إلى عرض سعر.",
    name: "الاسم", email: "البريد الإلكتروني للإيصال", phone: "الهاتف (اختياري)", date: "تاريخ الاستلام", time: "وقت الاستلام (نيويورك)", note: "ملاحظات التحضير (اختياري)",
    pay: "متابعة الدفع الآمن", waiting: "جارٍ إعداد الدفع…", error: "تعذر فتح الدفع. يرجى الاتصال بنزار قبل المحاولة مجددًا؛ لا يظهر هنا دفع مؤكد.",
    pickupErrors: { date: "اختر تاريخًا ووقتًا صالحين للاستلام.", closed: "الاستلام غير متاح أيام الأربعاء. اختر تاريخًا آخر.", hours: "اختر وقتًا بين 11:00 و19:00 بتوقيت نيويورك بفواصل 30 دقيقة.", lead: "يلزم مرور 72 ساعة بعد الدفع. اختر موعدًا لاحقًا؛ تُحجز 20 دقيقة لإتمام الدفع." },
    selection: "اختر صينية بسعر محدد أعلاه للمتابعة.", verify: "أكمل التحقق الأمني أولاً.", tax: "تظهر الضريبة والمبلغ النهائي في صفحة الدفع الآمنة من Clover.", consentNote: "اختياري. لا يلزم للدفع." },
} as const;

export default function CateringCheckoutForm({ selections }: { selections: Selection[] }) {
  const { lang } = useLang();
  const copy = COPY[lang];
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [now, setNow] = React.useState(Date.now);
  const [initial] = React.useState(() => firstPickup(Date.now()));
  const [date, setDate] = React.useState(initial.date);
  const [time, setTime] = React.useState(initial.time);
  const minDate = newYorkDate(new Date(now + CATERING_LEAD_TIME_MS));
  const slotError = pickupError(date, time, now);
  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  function chooseDate(value: string) {
    setDate(value);
    const current = Date.now();
    setNow(current);
    setTime(PICKUP_TIMES.find(slot => !pickupError(value, slot, current)) ?? "");
  }
  const [note, setNote] = React.useState("");
  const [consentEmail, setConsentEmail] = React.useState(false);
  const [token, setToken] = React.useState("");
  const [resetSignal, setResetSignal] = React.useState(0);
  const [busy, setBusy] = React.useState(false);
  const [needsHelp, setNeedsHelp] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const inFlight = React.useRef(false);
  const onToken = React.useCallback((value: string) => setToken(value), []);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || needsHelp || !selections.length) return;
    const current = Date.now();
    setNow(current);
    const invalid = pickupError(date, time, current);
    if (invalid) {
      setMessage("");
      document.getElementById(invalid === "closed" || invalid === "date" ? "catering-pickup-date" : "catering-pickup-time")?.focus();
      return;
    }
    if (!token || !turnstileSiteKey) { setMessage(copy.verify); return; }
    const pickupAt = newYorkPickup(date, time)!;
    inFlight.current = true;
    setBusy(true);
    setMessage("");
    try {
      const requestId = crypto.randomUUID();
      const response = await fetch("/api/catering/checkout", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, requestKind: "standard", fulfillmentMethod: "pickup",
          name, email, phone, preparationNote: note, pickupAt, turnstileToken: token, consentEmail,
          selections: selections.map(({ id, size }) => ({ id, size, quantity: 1 })) }),
      });
      const result = await response.json() as { code?: string; orderId?: string;
        requestId?: string; checkoutUrl?: string };
      if (!response.ok || result.code !== "checkout_ready" ||
          !result.orderId || !result.requestId ||
          !/^https:\/\/([a-z0-9-]+\.)*clover\.com\//i.test(result.checkoutUrl ?? "")) {
        setMessage(copy.error);
        setNeedsHelp(true);
        return;
      }
      sessionStorage.setItem("nazar-site-order-reference-v1", JSON.stringify({
        orderId: result.orderId, requestId: result.requestId,
      }));
      trackBeginCheckout(result.orderId);
      window.location.assign(result.checkoutUrl!);
    } catch { setMessage(copy.error); setNeedsHelp(true); }
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
        <CateringPickupDate value={date} min={minDate} now={now} lang={lang} label={copy.date} invalid={Boolean(slotError)} onChange={chooseDate} />
        <label className="text-sm font-semibold">{copy.time}<select id="catering-pickup-time" required value={time} aria-invalid={Boolean(slotError)} aria-describedby={slotError ? "catering-pickup-error" : undefined} onChange={(e) => setTime(e.target.value)} className="mt-1 w-full rounded-lg border p-2"><option value="">—</option>{PICKUP_TIMES.map(slot => <option key={slot} value={slot} disabled={Boolean(pickupError(date, slot, now))}>{slot}</option>)}</select></label>
        {slotError && <p id="catering-pickup-error" role="alert" className="text-sm text-red-800 sm:col-span-2">{copy.pickupErrors[slotError]}</p>}
        <label className="text-sm font-semibold sm:col-span-2">{copy.note}<textarea maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} className="mt-1 w-full rounded-lg border p-2" /></label>
        <label className="flex items-start gap-2.5 text-sm font-semibold text-zinc-700 sm:col-span-2"><input type="checkbox" checked={consentEmail} onChange={(e) => setConsentEmail(e.target.checked)} aria-describedby="catering-consent-note" className="mt-0.5 h-4 w-4 shrink-0 rounded border-zinc-300" /><span>{t("vip.consentEmail", lang)} <span id="catering-consent-note" className="font-normal text-zinc-500">{copy.consentNote}</span></span></label>
        <div className="sm:col-span-2"><TurnstileWidget onToken={onToken} resetSignal={resetSignal} /></div>
        <p className="text-xs text-zinc-600 sm:col-span-2">{copy.tax}</p>
        {message && <p role="alert" className="text-sm text-red-800 sm:col-span-2">{message}</p>}
        <button type="submit" disabled={busy || needsHelp || !token} className="rounded-full bg-[#1E7A3A] px-6 py-3 font-bold text-white disabled:opacity-50 sm:col-span-2">{busy ? copy.waiting : copy.pay}</button>
      </form>}
  </section>;
}
