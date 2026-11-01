import { useEffect, useState } from "react";
import { crmData } from "../../lib/crmData";
import { staffDisplayDate } from "../../lib/staffUi";
import { validAttribution, type Attribution, type Touch } from "../../lib/crmAttribution";

type State = { id: string; loading: boolean; data: Attribution | null; unavailable: boolean };

// G21: first and last campaign that brought a verified, non-refunded catering payment.
// Read through public.crm_customer_attribution_v1 (crm.read staff only). An order with an
// unknown source is never shown as a campaign.
const label = (t: Touch) => `${t.source_class === "google_ads" ? "Google Ads" : t.utm_source || "Kampanya"} · ${t.utm_campaign || "kampanya adı yok"}`;

export default function CustomerAttribution({ customerId }: { customerId: string }) {
  const [state, setState] = useState<State>({ id: customerId, loading: true, data: null, unavailable: false });
  useEffect(() => {
    let alive = true;
    void crmData.attribution(customerId).then(result => {
      if (!alive) return;
      const ok = !result.error && validAttribution(result.data);
      setState({ id: customerId, loading: false, data: ok ? result.data as Attribution | null : null, unavailable: !ok });
    });
    return () => { alive = false; };
  }, [customerId]);
  const current = state.id === customerId ? state : { id: customerId, loading: true, data: null, unavailable: false };
  return <section className="border-b border-brand-border p-4" aria-label="Atfedilen kampanya">
    <h3 className="mb-3 text-sm font-semibold">Atfedilen kampanya</h3>
    {current.loading ? <div className="staff-skeleton" role="status" aria-label="Yükleniyor" />
      : current.unavailable ? <p className="text-xs text-stone-500">Kampanya bilgisi yüklenemedi.</p>
      : !current.data ? <p className="text-xs text-stone-500">Kaynağı bilinen doğrulanmış catering siparişi yok.</p>
      : <dl className="space-y-3 text-sm">
        {([["İlk", current.data.first], ["Son", current.data.last]] as const).map(([name, touch]) => <div key={name}>
          <dt className="text-xs text-stone-500">{name}</dt>
          <dd className="mt-0.5 break-words">{label(touch)}</dd>
          <dd className="text-xs text-stone-500">{staffDisplayDate(touch.at)} · Sipariş {touch.site_order_id.slice(0, 8).toUpperCase()}</dd>
        </div>)}
        <div><dt className="text-xs text-stone-500">Atfedilen</dt>
          <dd className="mt-0.5">{current.data.attributed_orders} sipariş · ${(current.data.attributed_revenue_cents / 100).toFixed(2)}</dd></div>
      </dl>}
  </section>;
}
