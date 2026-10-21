import { useState } from "react";
import { closedCloverDay } from "../lib/cloverPullDay";
import { staffDateInput } from "../lib/staffUi";
import { staffClient } from "../lib/crmData";
import { browserDeployment } from "../lib/supabase";

type PullWarning = { code?: string; step?: string; httpStatus?: number };
type PullResult = { code?: string; step?: string; providerStatus?: number; fetched?: number; upserted?: number; requestCount?: number; warnings?: PullWarning[] };
type DayTotals = { orderCount?: number; collectedCents?: number; tipCents?: number; refundUnverifiedCount?: number; undatedTransactionCount?: number;
  customerAccessDeniedCount?: number; reconciliationConfirmed?: boolean };
const safeCode = /^[a-z][a-z0-9_]{1,48}$/;
const safeSteps = new Set(["configuration", "authorization", "list", "order_core", "order_refunds", "order_customers", "ingest"]);

function pullFailure(status: number, result: PullResult | null) {
  const code = typeof result?.code === "string" && safeCode.test(result.code) ? result.code : "unknown_error";
  const step = typeof result?.step === "string" && safeSteps.has(result.step) ? result.step : "request";
  const http = Number.isInteger(result?.providerStatus) && result!.providerStatus! >= 400 && result!.providerStatus! <= 599
    ? result!.providerStatus : status;
  return `Çekme başarısız · Adım: ${step} · Kod: ${code} · HTTP: ${http}. Tekrar denemeden önce kontrol edin.`;
}

function pullWarnings(warnings: PullWarning[] | undefined) {
  if (!Array.isArray(warnings)) return "";
  return warnings.filter(warning => warning && safeSteps.has(warning.step || "")
    && typeof warning.code === "string" && safeCode.test(warning.code)
    && Number.isInteger(warning.httpStatus) && warning.httpStatus! >= 400 && warning.httpStatus! <= 599)
    .map(warning => `Adım: ${warning.step} · Kod: ${warning.code} · HTTP: ${warning.httpStatus}`).join("; ");
}

function yesterday() {
  const today = staffDateInput(new Date().toISOString()).slice(0, 10);
  const date = new Date(`${today}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

export default function CloverOrderPullPanel({ accessToken }: { accessToken: string }) {
  const [day, setDay] = useState(yesterday);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [totals, setTotals] = useState<{ day: string; orderCount: number; collectedCents: number; tipCents: number;
    refundUnverifiedCount: number; undatedTransactionCount: number; customerAccessDeniedCount: number; reconciliationConfirmed: boolean } | null>(null);

  async function pull() {
    if (busy || !staffClient || !browserDeployment.configured) return;
    const range = closedCloverDay(day);
    setTotals(null);
    if (!range) { setMessage("Son 30 gün içinden kapanmış bir tarih seçin."); return; }
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/staff/clover-order-pull", {
        method: "POST", cache: "no-store",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ day }),
      });
      const pulled = await response.json() as PullResult;
      if (!response.ok || pulled.code !== "ok" || !Number.isSafeInteger(pulled.fetched)
        || !Number.isSafeInteger(pulled.upserted) || pulled.fetched !== pulled.upserted) {
        setMessage(pullFailure(response.status, pulled));
        return;
      }
      const scopeWarnings = pullWarnings(pulled.warnings);
      const { data, error } = await staffClient.rpc("clover_order_day_summary_v2", {
        p_business_id: browserDeployment.businessId, p_start: range.start, p_end: range.end,
      });
      const result = data as DayTotals | null;
      if (error || !result || !Number.isSafeInteger(result.orderCount)
        || !Number.isSafeInteger(result.collectedCents) || !Number.isSafeInteger(result.tipCents) || result.orderCount! < 0
        || !Number.isSafeInteger(result.refundUnverifiedCount) || result.refundUnverifiedCount! < 0
        || !Number.isSafeInteger(result.undatedTransactionCount) || result.undatedTransactionCount! < 0
        || !Number.isSafeInteger(result.customerAccessDeniedCount) || result.customerAccessDeniedCount! < 0
        || typeof result.reconciliationConfirmed !== "boolean") {
        setMessage(`Siparişler çekildi.${scopeWarnings ? ` ${scopeWarnings}.` : ""} Adım: day_totals · Kod: day_totals_unconfirmed. Yeniden çekmeden önce kontrol edin.`);
        return;
      }
      setTotals({ day, orderCount: result.orderCount!, collectedCents: result.collectedCents!, tipCents: result.tipCents!,
        refundUnverifiedCount: result.refundUnverifiedCount!,
        undatedTransactionCount: result.undatedTransactionCount!,
        customerAccessDeniedCount: result.customerAccessDeniedCount!,
        reconciliationConfirmed: result.reconciliationConfirmed! });
      setMessage(`${pulled.fetched} sipariş, ${pulled.requestCount ?? "?"} Clover isteği kontrol edildi.${scopeWarnings ? ` ${scopeWarnings}.` : ""}
        ${result.reconciliationConfirmed ? "Seçilen günün toplamı aşağıda." : "İade veya işlem tarihi doğrulanmadı; mutabakat onaylanamaz."}`);
    } catch { setMessage("Çekme başarısız · Adım: request · Kod: network_or_response. Tekrar denemeden önce kontrol edin."); }
    finally { setBusy(false); }
  }

  return <section className="staff-panel mb-5 p-4 sm:p-5" aria-label="Clover gün mutabakatı">
    <h2 className="text-lg font-semibold">Clover gün mutabakatı</h2>
    <p className="mt-1 text-sm text-stone-600">Kapanmış New York gününü seçin. Sipariş sayısı açılış gününe, tahsilat ve bahşiş ödeme gününe göre gösterilir.</p>
    <div className="mt-4 flex flex-wrap items-end gap-3"><label className="text-sm font-medium">Gün (New York)
      <input type="date" value={day} max={yesterday()} onChange={event => { setDay(event.target.value); setTotals(null); }} className="staff-input mt-1 block" />
    </label><button type="button" disabled={busy} onClick={() => void pull()} className="staff-button">{busy ? "Kontrol ediliyor…" : "Clover’dan getir"}</button></div>
    {message && <p role="status" className="mt-3 text-sm">{message}</p>}
    {totals && <div className="mt-3 text-sm font-semibold">
      <p>Siparişler (açılış günü): {totals.orderCount}</p>
      <p>Tahsilat (ödeme günü, bahşiş hariç): {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(totals.collectedCents / 100)} · Bahşiş: {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(totals.tipCents / 100)}</p>
      <p>İadesi doğrulanmayan: {totals.refundUnverifiedCount} · Müşteri eşleşmesi token izni nedeniyle yapılamayan: {totals.customerAccessDeniedCount}</p>
      {totals.undatedTransactionCount > 0 && <p>Tarihi eksik ödeme/iade kaydı: {totals.undatedTransactionCount}</p>}
      <p className="mt-1 font-normal text-stone-600">Tahsilat, sisteme çekilmiş ödeme ve iadeleri kapsar; Clover gün raporuyla doğrulanmadan kesinleşmez.</p>
    </div>}
  </section>;
}
