import type { Offer } from "../../lib/crmData";
import { staffCopy as c } from "../../lib/staffCopy";
import { staffDisplayDate } from "../../lib/staffUi";

export default function OffersView({ offers, loading }: { offers: Offer[] | null; loading: boolean }) {
  return <section className="staff-panel p-4 sm:p-5 min-w-0" aria-labelledby="staff-offers-title">
    <h1 id="staff-offers-title" className="text-xl font-semibold">{c.offers}</h1>
    <p className="mt-2 text-sm text-stone-600">{c.offersScope}</p>
    <p className="mt-2 text-xs text-stone-600">{c.offerDateScope}</p>
    {loading ? <div className="mt-4 space-y-3" role="status" aria-label={c.loading}>
      {[0, 1, 2].map(value => <div key={value} className="h-12 animate-pulse rounded-lg bg-brand-primarySoft" />)}
    </div> : offers === null ? <p role="status" className="mt-4">{c.unavailable}</p>
      : offers.length === 0 ? <p className="mt-4">{c.noOffers}</p>
        : <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[42rem] border-collapse text-left text-sm">
            <caption className="sr-only">{c.offersScope}</caption>
            <thead><tr className="border-b border-brand-border">
              {[c.offerName, c.code, c.channel, c.starts, c.ends, c.status, c.offerActive].map(label =>
                <th key={label} scope="col" className="px-3 py-3 first:pl-0 font-semibold">{label}</th>)}
            </tr></thead>
            <tbody>{offers.map(offer => <tr key={offer.id} className="border-b border-brand-border last:border-0">
              <th scope="row" className="max-w-xs py-3 pr-3 align-top font-medium">
                <span className="block break-words">{offer.name}</span>
                {offer.description && <span className="mt-1 block break-words text-xs font-normal text-stone-600">{offer.description}</span>}
              </th>
              <td className="px-3 py-3 align-top">{offer.code || "—"}</td>
              <td className="px-3 py-3 align-top">{offer.channel_target || "—"}</td>
              <td className="whitespace-nowrap px-3 py-3 align-top">{staffDisplayDate(offer.starts_at)}</td>
              <td className="whitespace-nowrap px-3 py-3 align-top">{staffDisplayDate(offer.ends_at)}</td>
              <td className="px-3 py-3 align-top text-stone-600">{c.sourceOnly}</td>
              <td className="px-3 py-3 align-top" title={c.notProvided}>—</td>
            </tr>)}</tbody>
          </table>
        </div>}
  </section>;
}
