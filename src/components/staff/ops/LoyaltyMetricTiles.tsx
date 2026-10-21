import type { ReactNode } from "react";
import type { LoyaltyMetrics, LoyaltyReadState } from "../../../lib/loyaltyMetrics";
import { loyaltyCopy as c } from "../../../lib/staffCopy";
import { staffDisplayDate } from "../../../lib/staffUi";

function sourceReason(code: string | null | undefined) {
  if (code === "repeat_payment_time_unknown") return c.paymentTimeUnknown;
  if (code?.includes("attribution") || code?.includes("explicit")) return c.noAttribution;
  if (code === "no_campaigns") return c.noCampaign;
  if (code?.includes("matur") || code?.includes("cohort") || code?.includes("30d")) return c.immature;
  if (code?.includes("order") || code?.includes("ingest")) return c.noOrders;
  return c.unknown;
}
const number = (value: number | null | undefined) => typeof value === "number" ? value.toLocaleString("tr-TR") : "—";

export default function LoyaltyMetricTiles({ data, state = "missing" }: { data: LoyaltyMetrics | null; state?: LoyaltyReadState }) {
  const available = state === "ready" && data !== null;
  function box(key: string, title: string, known: boolean | undefined, why: string | null | undefined, content: ReactNode, footer?: string) {
    return <section className="staff-panel min-w-0" data-testid={`loyalty-box-${key}`} aria-labelledby={`loyalty-heading-${key}`}>
      <h3 id={`loyalty-heading-${key}`} className="border-b border-brand-border px-4 py-3 text-sm font-semibold">{title}</h3>
      <div className="space-y-3 p-4">{state === "loading" ? <div role="status" aria-label={c.loading} className="space-y-3"><div className="staff-skeleton" /><div className="staff-skeleton !h-5" /></div>
        : available && known ? content : <><p className="text-3xl font-semibold">—</p><p className="text-xs text-stone-600">{state === "missing" ? c.missing : state === "error" ? c.error : sourceReason(why)}</p></>}
        {footer && <p className="text-xs text-stone-500">{footer}</p>}</div>
    </section>;
  }
  return <section className="space-y-3" aria-label={c.title}>
    <div><h2 className="text-lg font-semibold">{c.title}</h2><p className="mt-1 text-xs text-stone-600">{c.source} · {c.scope}</p>
      {available && <p className="mt-1 text-xs text-stone-500">{c.period}: {data.month.slice(0, 7)} · {data.timezone} · {data.include_tests ? c.testScope : c.realScope} · {c.checked}: {staffDisplayDate(data.generated_at)}</p>}</div>
    <div className="grid min-w-0 gap-4 md:grid-cols-2 xl:grid-cols-4">
      {box("customers", c.customers, data?.customer_counts.known, data?.customer_counts.reason, <dl className="space-y-2"><div><dt className="text-xs text-stone-600">{c.newCustomer}</dt><dd className="text-2xl font-semibold">{number(data?.customer_counts.new)}</dd></div><div><dt className="text-xs text-stone-600">{c.repeatCustomer}</dt><dd className="text-2xl font-semibold">{number(data?.customer_counts.repeat)}</dd></div></dl>)}
      {box("campaigns", c.campaigns, data?.campaigns.known, data?.campaigns.reason, data?.campaigns.items.length ? <ul className="space-y-3">{data.campaigns.items.map(item => <li key={item.campaign_id} className="break-words"><p className="text-sm font-semibold">{item.name}</p><p className="text-sm">{c.applied}: {number(item.applied)}</p><p className="text-sm">{c.orderLinked}: {number(item.order_linked)}</p><p className="text-sm">{c.staffAttested}: {number(item.staff_attested)}</p>{item.order_linked === undefined && <p className="text-xs text-stone-500">{c.splitMissing}</p>}<p className="text-sm">{c.repeat30}: {item.repeat_30d.known && typeof item.repeat_30d.rate === "number" ? `${(item.repeat_30d.rate * 100).toLocaleString("tr-TR", { maximumFractionDigits: 1 })}% (${item.repeat_30d.numerator}/${item.repeat_30d.denominator})` : "—"}</p>{!item.repeat_30d.known && <p className="text-xs text-stone-500">{sourceReason(item.repeat_30d.reason)}</p>}</li>)}</ul> : <p className="text-xs text-stone-600">{c.noCampaign}</p>, c.cohort)}
      {box("messages", c.sent, data?.messages.known, data?.messages.reason, <p className="text-3xl font-semibold">{number(data?.messages.sent)}</p>, c.notSales)}
      {box("attribution", c.attributed, data?.attribution.known, data?.attribution.reason, <p className="text-3xl font-semibold">{number(data?.attribution.orders)}</p>, c.attributionCaution)}
    </div>
  </section>;
}
