import { useState } from "react";
import { staffClient } from "../../../lib/crmData";

type Day = { day: string; orderDifference: number | null; netDifferenceCents: number | null;
  refundDifferenceCents: number | null };
type Comparison = { source: "table" | "both"; csvAvailable: boolean; provisional: boolean;
  orderCount: number; grossSalesCents: number; refundCents: number; qualifiedNetCents: number;
  missingFieldCount: number; unknownChannelCount: number; refundUnverifiedCount: number;
  missingCsvDays?: number; dailyDifferences: Day[] };

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
export default function CommissionComparison() {
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [data, setData] = useState<Comparison | null>(null);
  const [state, setState] = useState("Henüz karşılaştırma yüklenmedi.");
  const [busy, setBusy] = useState(false);
  async function load() {
    if (busy || !staffClient) return;
    setBusy(true); setData(null); setState("Karşılaştırma yükleniyor…");
    try {
      const { data: session } = await staffClient.auth.getSession();
      const token = session.session?.access_token;
      if (!token) { setState("Personel oturumu gerekli."); return; }
      const response = await fetch("/api/staff/commission-compare", { method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ month }), credentials: "same-origin" });
      const body = await response.json();
      if (!response.ok || body.code !== "ok" || !body.data) {
        setState(response.status === 503 ? "Tablo karşılaştırması henüz kurulmadı." : "Karşılaştırma açılamadı."); return;
      }
      setData(body.data as Comparison); setState("");
    } catch { setState("Karşılaştırma açılamadı."); }
    finally { setBusy(false); }
  }
  return <div className="mt-4 border-t border-stone-200 pt-3 text-xs" aria-label="Komisyon kaynağı karşılaştırması">
    <div className="flex flex-wrap items-end gap-2"><label>Ay <input className="staff-input ml-2" type="month" value={month}
      onChange={event => setMonth(event.target.value)} /></label><button type="button" className="font-semibold text-brand-dark underline"
      disabled={busy} onClick={() => void load()}>CSV / tablo karşılaştır</button></div>
    {state && <p className="mt-2 text-stone-600" role="status">{state}</p>}
    {data && <div className="mt-2 space-y-1" role="status">
      <p>Kaynak: {data.csvAvailable ? "CSV + tablo" : "tablo"} · {data.provisional ? "ön hesap" : "karşılaştırıldı"}</p>
      <p>Tablo: {data.orderCount} sipariş · net {money(data.qualifiedNetCents)} · iade {money(data.refundCents)}</p>
      <p>Eksik alan: {data.missingFieldCount} · bilinmeyen kanal: {data.unknownChannelCount} · iadesi doğrulanmayan: {data.refundUnverifiedCount}</p>
      {data.csvAvailable && <p>Günlük fark: {data.dailyDifferences.filter(day => day.orderDifference !== 0 || day.netDifferenceCents !== 0 || day.refundDifferenceCents !== 0).length} gün; CSV veri eksiği: {data.missingCsvDays || 0} gün.</p>}
      {data.csvAvailable && <details><summary className="cursor-pointer underline">Günlük farkları göster</summary>
        <div className="mt-1 max-h-44 overflow-auto">{data.dailyDifferences.filter(day => day.orderDifference !== 0 || day.netDifferenceCents !== 0 || day.refundDifferenceCents !== 0).map(day =>
          <p key={day.day}>{day.day}: sipariş {day.orderDifference ?? "?"}, net {day.netDifferenceCents ?? "?"}¢, iade {day.refundDifferenceCents ?? "?"}¢</p>)}</div></details>}
    </div>}
  </div>;
}
