import { useState } from "react";
import { closedCloverDay } from "../lib/cloverPullDay";
import { staffDateInput } from "../lib/staffUi";
import { staffClient } from "../lib/crmData";
import { browserDeployment } from "../lib/supabase";

type PullResult = { code?: string; fetched?: number; upserted?: number };
type DayTotals = { orderCount?: number; netCents?: number };

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
  const [totals, setTotals] = useState<{ day: string; orderCount: number; netCents: number } | null>(null);

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
        body: JSON.stringify({ days: range.days }),
      });
      const pulled = await response.json() as PullResult;
      if (!response.ok || pulled.code !== "ok" || !Number.isSafeInteger(pulled.fetched)
        || !Number.isSafeInteger(pulled.upserted) || pulled.fetched !== pulled.upserted) {
        setMessage(response.status === 403 ? "Bu hesap sipariş çekemez." : "Çekme doğrulanamadı. Kayıtların durumunu kontrol edin.");
        return;
      }
      const { data, error } = await staffClient.rpc("clover_order_day_totals_v1", {
        p_business_id: browserDeployment.businessId, p_start: range.start, p_end: range.end,
      });
      const result = data as DayTotals | null;
      if (error || !result || !Number.isSafeInteger(result.orderCount)
        || !Number.isSafeInteger(result.netCents) || result.orderCount! < 0) {
        setMessage("Siparişler çekildi, fakat gün toplamı doğrulanamadı. Yeniden çekmeden önce kontrol edin.");
        return;
      }
      setTotals({ day, orderCount: result.orderCount!, netCents: result.netCents! });
      setMessage(`${pulled.fetched} sipariş kontrol edildi; seçilen günün toplamı aşağıda.`);
    } catch { setMessage("Çekme doğrulanamadı. Kayıtların durumunu kontrol edin."); }
    finally { setBusy(false); }
  }

  return <section className="staff-panel mb-5 p-4 sm:p-5" aria-label="Clover gün mutabakatı">
    <h2 className="text-lg font-semibold">Clover gün mutabakatı</h2>
    <p className="mt-1 text-sm text-stone-600">Kapanmış günü seçin. Sistem o günü kapsayan son günleri Clover’dan okur ve seçilen günün sipariş sayısıyla tahsilat toplamını gösterir.</p>
    <div className="mt-4 flex flex-wrap items-end gap-3"><label className="text-sm font-medium">Gün (New York)
      <input type="date" value={day} max={yesterday()} onChange={event => { setDay(event.target.value); setTotals(null); }} className="staff-input mt-1 block" />
    </label><button type="button" disabled={busy} onClick={() => void pull()} className="staff-button">{busy ? "Kontrol ediliyor…" : "Clover’dan getir"}</button></div>
    {message && <p role="status" className="mt-3 text-sm">{message}</p>}
    {totals && <p className="mt-3 text-sm font-semibold">{totals.day}: {totals.orderCount} sipariş · Tahsil edilen: {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(totals.netCents / 100)}</p>}
  </section>;
}
