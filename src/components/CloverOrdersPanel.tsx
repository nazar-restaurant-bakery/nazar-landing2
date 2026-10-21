import { useEffect, useRef, useState } from "react";
import { getStaffSupabase } from "../lib/staffSupabase";
import { browserDeployment } from "../lib/supabase";
import { campaignCheckLabel, campaignCheckTime, readCampaignChecks, type CampaignCheckState } from "../lib/campaignEligibility";
import { campaignEligibilityReasons, staffCopy as c } from "../lib/staffCopy";

type Order = {
  id: string; cloverUrl: string; createdAt: string; orderType: string;
  totalCents: number | null;
};
type Result = { code: string; orders?: Order[]; checkedAt?: string; truncated?: boolean };

export default function CloverOrdersPanel({ accessToken }: { accessToken: string }) {
  // A new session/token gets a fresh panel; no previous private result is reused.
  return <CloverOrdersContent key={accessToken} accessToken={accessToken} />;
}

function EligibilityLabel({ result }: { result: CampaignCheckState }) {
  const check = result.status === "ready" ? result.check : null;
  const known = check?.known === true;
  const reason = result.status === "denied" ? c.campaignCheckDenied
    : result.status === "unavailable" ? c.campaignCheckUnavailable
      : check && !check.eligible ? campaignEligibilityReasons[check.reason] || c.campaignCheckUnavailable : "";
  const label = campaignCheckLabel(check) === "simit" ? c.campaignCheckLabel : c.campaignCheckGeneric;
  const text = result.status === "loading" ? c.campaignCheckLoading
    : known ? check.eligible ? c.campaignCheckYes : c.campaignCheckNo : c.campaignCheckUnknown;
  const remaining = check?.eligible ? check.remaining : null;
  return <div className="mt-2 max-w-full text-xs" role="status" aria-label={label}>
    <span className={`inline-block max-w-full break-words rounded-lg border px-2 py-1 ${known && check.eligible
      ? "border-brand-border bg-brand-primarySoft text-brand-dark" : "border-brand-border bg-brand-bg text-stone-700"}`} title={c.campaignCheckCaution}>
      {label}: {text}{reason ? ` — ${reason}` : ""}
    </span>
    {check?.campaign && <p className="mt-1 break-words text-stone-600">{c.campaign}: {check.campaign.name}</p>}
    {remaining && <p className="mt-1 break-words text-stone-600">{c.campaignCheckPersonRemaining}: {remaining.person ?? c.campaignCheckUnlimited} · {c.campaignCheckTotalRemaining}: {remaining.total ?? c.campaignCheckUnlimited} · {c.campaignCheckPerOrder}: {remaining.perOrder}</p>}
    {check && <p className="mt-1 text-[11px] text-stone-500">{c.campaignCheckSnapshot}: {campaignCheckTime(check.snapshotAt)} · {c.campaignCheckAt}: {campaignCheckTime(check.checkedAt)}</p>}
  </div>;
}

function CloverOrdersContent({ accessToken }: { accessToken: string }) {
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [eligibility, setEligibility] = useState<Record<string, CampaignCheckState>>({});
  const active = useRef(true);
  const reading = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  async function load() {
    if (reading.current) return;
    reading.current = true;
    const requestGeneration = ++generation.current;
    const current = () => active.current && generation.current === requestGeneration;
    setBusy(true); setMessage(""); setOrders(null); setEligibility({}); setCheckedAt(null);
    try {
      const response = await fetch("/api/staff/clover-orders", {
        method: "GET", cache: "no-store",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const result = await response.json() as Result;
      if (!current()) return;
      if (!response.ok || result.code !== "ok" || !Array.isArray(result.orders)) {
        setOrders(null); setCheckedAt(null);
        setMessage(result.code === "connection_unavailable"
          ? "Clover order connection is not set up yet. Existing orders remain in Clover."
          : result.code === "forbidden" ? "This account cannot view Clover orders."
          : "Clover orders could not be loaded. Try again later.");
        return;
      }
      setOrders(result.orders); setCheckedAt(result.checkedAt || null);
      setTruncated(result.truncated === true);
      const client = getStaffSupabase();
      if (!client || !browserDeployment.configured) {
        setEligibility(Object.fromEntries(result.orders.map(order => [order.id, { status: "unavailable" }])));
      } else {
        await readCampaignChecks((name, params) => client.rpc(name, params), browserDeployment.businessId,
          result.orders.map(order => order.id), (id, value) => {
            setEligibility(previous => ({ ...previous, [id]: value }));
          }, current);
      }
    } catch {
      if (current()) { setOrders(null); setCheckedAt(null); setMessage("Clover orders could not be loaded. Try again later."); }
    } finally { if (current()) { reading.current = false; setBusy(false); } }
  }

  return <section className="mb-5 rounded-xl border border-[#dfe7df] bg-white p-4 sm:p-5" aria-label="Clover online orders">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="text-lg font-semibold">Clover online orders</h2>
        <p className="text-sm text-[#64736a]">Recent Clover storefront orders; separate from Nazar customer and catering records.</p></div>
      <button type="button" disabled={busy} onClick={() => void load()} className="rounded-lg bg-[#176b3a] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy ? "Loading…" : "Load last 7 days"}</button>
    </div>
    {message && <p role="status" className="mt-3 rounded-lg bg-amber-50 p-3 text-sm">{message}</p>}
    {orders && <div className="mt-4 space-y-2">
      <p className="text-xs text-[#64736a]">{orders.length} orders shown{checkedAt ? ` · Checked ${new Date(checkedAt).toLocaleString()}` : ""}{truncated ? " · More orders may exist in Clover" : ""}. Order amount may differ from the payment collected. Confirm payment and fulfillment in Clover.</p>
      <p className="text-xs text-stone-600">{c.campaignCheckCaution}</p>
      {orders.map(order => <div key={order.id} className="flex flex-wrap justify-between gap-2 rounded-lg border border-[#dfe7df] p-3 text-sm">
        <div className="min-w-0 break-words"><strong>{order.orderType}</strong><p className="text-xs text-[#64736a]">Order {order.id} · {new Date(order.createdAt).toLocaleString()}</p><a className="text-xs font-semibold text-[#176b3a] underline" href={order.cloverUrl} target="_blank" rel="noopener noreferrer">View order in Clover</a><EligibilityLabel result={eligibility[order.id] || { status: "loading" }} /></div>
        <div className="text-right"><strong>{order.totalCents === null ? "Order amount unavailable" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(order.totalCents / 100)}</strong><p className="text-xs text-[#64736a]">Order amount</p></div>
      </div>)}
      {orders.length === 0 && <p className="text-sm text-[#64736a]">No matching Clover online orders in the last 7 days.</p>}
    </div>}
  </section>;
}
