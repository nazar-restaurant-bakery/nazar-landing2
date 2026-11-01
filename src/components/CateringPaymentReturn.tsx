import React from "react";
import { useLang } from "./Language";
import { trackPurchase } from "../lib/analytics";

type State = { status: string; orderId: string; requestedAt: string;
  totalCents: number; emailStatus: string };
const COPY = {
  en: { title: "Your catering payment", check: "Check payment status", loading: "Checking your payment…",
    pending: "Payment confirmation is still processing. Please check again shortly. Do not place another order yet.",
    paid: "Payment received. Your catering order is confirmed.",
    reschedule: "Payment received. Nazar will contact you to confirm a new pickup time.",
    unknown: "We cannot confirm this payment in this browser. Please contact Nazar with your Clover receipt before ordering again.",
    cancelled: "Clover returned to Nazar. We have not confirmed a payment. Check the status below before trying again.",
    email: "A confirmation email was accepted for delivery.", noEmail: "If no email arrives, keep your Clover receipt and contact Nazar." },
  tr: { title: "Catering ödemeniz", check: "Ödeme durumunu kontrol et", loading: "Ödemeniz kontrol ediliyor…",
    pending: "Ödeme doğrulaması sürüyor. Biraz sonra tekrar kontrol edin. Şimdilik yeni sipariş vermeyin.",
    paid: "Ödeme alındı. Catering siparişiniz onaylandı.",
    reschedule: "Ödeme alındı. Yeni teslim saatini doğrulamak için Nazar sizinle iletişime geçecek.",
    unknown: "Bu tarayıcıda ödemeyi doğrulayamıyoruz. Yeniden sipariş vermeden önce Clover makbuzunuzla Nazar'a ulaşın.",
    cancelled: "Clover'dan Nazar'a döndünüz. Ödeme henüz doğrulanmadı. Yeniden denemeden önce aşağıdan kontrol edin.",
    email: "Onay e-postası gönderilmek üzere kabul edildi.", noEmail: "E-posta gelmezse Clover makbuzunuzu saklayıp Nazar'a ulaşın." },
  ar: { title: "دفع طلب الطعام", check: "تحقق من حالة الدفع", loading: "جارٍ التحقق من الدفع…",
    pending: "لا يزال تأكيد الدفع قيد المعالجة. تحقق بعد قليل ولا تقدم طلبًا جديدًا الآن.",
    paid: "تم استلام الدفع وتأكيد طلبك.",
    reschedule: "تم استلام الدفع. سيتصل بك نزار لتأكيد موعد استلام جديد.",
    unknown: "لا يمكننا تأكيد الدفع في هذا المتصفح. اتصل بنزار مع إيصال Clover قبل طلب جديد.",
    cancelled: "عدت من Clover. لم يتم تأكيد الدفع بعد. تحقق من الحالة قبل المحاولة مجددًا.",
    email: "تم قبول رسالة التأكيد للإرسال.", noEmail: "إذا لم تصلك رسالة، احتفظ بإيصال Clover واتصل بنزار." },
} as const;

export default function CateringPaymentReturn({ payment }: { payment: string }) {
  const { lang } = useLang();
  const copy = COPY[lang];
  const [state, setState] = React.useState<State | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(false);
  const check = React.useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const stored = JSON.parse(sessionStorage.getItem("nazar-site-order-reference-v1") || "null") as
        { orderId?: string; requestId?: string } | null;
      if (!stored?.orderId || !stored.requestId) { setError(true); return; }
      const response = await fetch("/api/catering/order-status", { method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: stored.orderId, requestId: stored.requestId }), cache: "no-store" });
      if (!response.ok) { setError(true); return; }
      const result = await response.json() as State;
      if (result.orderId !== stored.orderId) { setError(true); return; }
      setState(result);
      // Only a paid answer from the server is measured; one purchase per order. Never throws.
      trackPurchase(result);
    } catch { setError(true); }
    finally { setLoading(false); }
  }, []);
  React.useEffect(() => { void check(); }, [check]);
  const confirmed = state?.status === "paid" || state?.status === "needs_reschedule";
  return <section className="rounded-3xl border border-emerald-200 bg-white p-6 shadow-sm sm:p-8" aria-live="polite">
    <h1 className="text-2xl font-extrabold text-zinc-900">{copy.title}</h1>
    <p className="mt-4 text-base font-semibold text-zinc-800">{loading ? copy.loading :
      error ? copy.unknown : state?.status === "paid" ? copy.paid :
      state?.status === "needs_reschedule" ? copy.reschedule :
      payment === "failed" || payment === "cancelled" ? copy.cancelled : copy.pending}</p>
    {confirmed && state && <div className="mt-4 rounded-xl bg-emerald-50 p-4 text-sm text-emerald-950">
      <p>Order {state.orderId.slice(0, 8).toUpperCase()} · ${(state.totalCents / 100).toFixed(2)}</p>
      <p>{new Date(state.requestedAt).toLocaleString(lang === "tr" ? "tr-TR" : lang === "ar" ? "ar" : "en-US", {
        timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" })} (New York)</p>
      <p className="mt-2">{state.emailStatus === "sent" ? copy.email : copy.noEmail}</p>
    </div>}
    {!confirmed && <button type="button" onClick={() => void check()} disabled={loading}
      className="mt-5 rounded-full bg-[#1E7A3A] px-5 py-2 font-bold text-white disabled:opacity-50">{copy.check}</button>}
  </section>;
}
