import { useEffect, useState } from "react";
import {
  loadStaffOffers, staffOfferDate, staffOfferStatusLabels,
  type StaffOffersResult, type StaffOffersRpc,
} from "../lib/staffOffers";

type PanelState = StaffOffersResult | { status: "loading" };

export default function StaffOffersPanel({ rpc, businessId }: {
  rpc: StaffOffersRpc;
  businessId: string;
}) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<PanelState>({ status: "loading" });
  useEffect(() => {
    let active = true;
    queueMicrotask(() => { if (active) setState({ status: "loading" }); });
    void loadStaffOffers(rpc, businessId).then((result) => { if (active) setState(result); });
    return () => { active = false; };
  }, [rpc, businessId, attempt]);

  return <section aria-labelledby="staff-offers-heading" aria-busy={state.status === "loading"}
    className="rounded-lg border border-brand-border bg-white p-4 sm:p-6">
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div><h1 id="staff-offers-heading" className="text-2xl font-bold">Teklifler</h1>
        <p className="mt-1 text-sm text-stone-600">Aktif, pasif ve tarih aralığı dışındaki tüm teklifler. Bu ekran salt okunurdur.</p>
        <p className="mt-1 text-xs text-stone-600">Durum, işletmenin tarihine göre hesaplanır.</p></div>
      <button type="button" disabled={state.status === "loading"}
        onClick={() => setAttempt((value) => value + 1)}
        className="min-h-11 rounded-lg border border-brand px-4 py-2 font-semibold text-brand disabled:opacity-50">Yenile</button>
    </div>
    {state.status === "loading" && <div role="status" className="space-y-3">
      <span className="sr-only">Teklifler yükleniyor.</span>
      {[0, 1, 2].map((row) => <div key={row} aria-hidden="true" className="h-16 animate-pulse rounded-lg bg-brand-bg" />)}
    </div>}
    {state.status === "denied" && <p role="alert" className="rounded-lg border border-brand-border p-4">Erişim yok. Bu hesap personel yetkisine sahip değil.</p>}
    {state.status === "unavailable" && <p role="alert" className="rounded-lg border border-brand-border p-4">Teklifler yüklenemedi. Yenile ile tekrar deneyin. Kayıt sayısı doğrulanmadı.</p>}
    {state.status === "ready" && <>
      <p role="status" className="mb-3 text-sm text-stone-600">{state.offers.length} teklif</p>
      {state.offers.length === 0 ? <p>Henüz teklif yok.</p> : <ul aria-label="Tüm teklifler" className="space-y-3">
        {state.offers.map((offer) => <li key={offer.id} className="rounded-lg border border-brand-border p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <h2 className="min-w-0 break-words text-lg font-semibold">{offer.name}</h2>
            <span className={`rounded-lg border border-brand-border px-2 py-1 text-sm ${offer.offer_status === "live" ? "bg-brand-primarySoft text-brand-dark" : "bg-brand-bg text-stone-700"}`}>
              {staffOfferStatusLabels[offer.offer_status]}
            </span>
          </div>
          {offer.description && <p className="mt-2 whitespace-pre-wrap break-words text-sm text-stone-700">{offer.description}</p>}
          <dl className="mt-3 grid min-w-0 gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <div className="min-w-0"><dt className="text-stone-600">Kod</dt><dd className="break-all font-medium">{offer.code || "—"}</dd></div>
            <div className="min-w-0"><dt className="text-stone-600">Kanal</dt><dd className="break-words font-medium">{offer.channel_target || "—"}</dd></div>
            <div><dt className="text-stone-600">Başlangıç</dt><dd>{staffOfferDate(offer.starts_at)}</dd></div>
            <div><dt className="text-stone-600">Bitiş</dt><dd>{staffOfferDate(offer.ends_at)}</dd></div>
          </dl>
        </li>)}
      </ul>}
    </>}
  </section>;
}
