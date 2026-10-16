import { useState } from "react";

type Order = {
  id: string; createdAt: string; orderType: string;
  totalCents: number | null;
};
type Result = { code: string; orders?: Order[]; checkedAt?: string; truncated?: boolean };

export default function CloverOrdersPanel({ accessToken }: { accessToken: string }) {
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    if (busy) return;
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/staff/clover-orders", {
        method: "GET", cache: "no-store",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const result = await response.json() as Result;
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
    } catch { setOrders(null); setCheckedAt(null); setMessage("Clover orders could not be loaded. Try again later."); }
    finally { setBusy(false); }
  }

  return <section className="mb-5 rounded-xl border border-[#dfe7df] bg-white p-4 sm:p-5" aria-label="Clover online orders">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="text-lg font-semibold">Clover online orders</h2>
        <p className="text-sm text-[#64736a]">Recent Clover storefront orders; separate from Nazar customer and catering records.</p></div>
      <button type="button" disabled={busy} onClick={() => void load()} className="rounded-lg bg-[#176b3a] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy ? "Loading…" : "Load last 7 days"}</button>
    </div>
    {message && <p role="status" className="mt-3 rounded-lg bg-amber-50 p-3 text-sm">{message}</p>}
    {orders && <div className="mt-4 space-y-2">
      <p className="text-xs text-[#64736a]">{orders.length} orders shown{checkedAt ? ` · Checked ${new Date(checkedAt).toLocaleString()}` : ""}{truncated ? " · More orders may exist in Clover" : ""}. Confirm payment and fulfillment in Clover.</p>
      {orders.map(order => <div key={order.id} className="flex flex-wrap justify-between gap-2 rounded-lg border border-[#dfe7df] p-3 text-sm">
        <div><strong>{order.orderType}</strong><p className="text-xs text-[#64736a]">Order {order.id} · {new Date(order.createdAt).toLocaleString()}</p></div>
        <div className="text-right"><strong>{order.totalCents === null ? "Total unavailable" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(order.totalCents / 100)}</strong></div>
      </div>)}
      {orders.length === 0 && <p className="text-sm text-[#64736a]">No matching Clover online orders in the last 7 days.</p>}
    </div>}
  </section>;
}
