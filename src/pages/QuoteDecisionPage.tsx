import { useEffect, useState, type FormEvent } from "react";
import { createClient } from "@supabase/supabase-js";
import { dollarsToCents } from "../lib/cateringQuote";

type Context = {
  request_id: string;
  event_date: string | null;
  guests: number | null;
  message: string | null;
  expires_at: string;
};

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
const client = url && key ? createClient(url, key) : null;

export default function QuoteDecisionPage() {
  const [context, setContext] = useState<Context | null>(null);
  const [menu, setMenu] = useState("");
  const [price, setPrice] = useState("");
  const [pickup, setPickup] = useState("");
  const [decisionName, setDecisionName] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [token] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get("token") || "");

  useEffect(() => {
    document.title = "Nazar catering | Menu and price decision";
    const robots = document.createElement("meta");
    robots.name = "robots";
    robots.content = "noindex,nofollow";
    document.head.appendChild(robots);
    const referrer = document.createElement("meta");
    referrer.name = "referrer";
    referrer.content = "no-referrer";
    document.head.appendChild(referrer);
    if (!client || !/^[0-9a-f]{64}$/.test(token)) {
      queueMicrotask(() => { setMessage("This review link is missing or invalid."); setLoading(false); });
    } else {
      void client.rpc("catering_quote_link_context_v1", { p_token: token }).then(({ data, error }) => {
        if (error || !data) setMessage("This review link is invalid, expired or already used.");
        else setContext(data as Context);
        setLoading(false);
      });
    }
    return () => { robots.remove(); referrer.remove(); };
  }, [token]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!client || !context || busy) return;
    const cents = dollarsToCents(price);
    if (!cents || !menu.trim() || !pickup.trim() || !decisionName.trim()) {
      setMessage("Enter your name, the final menu, total including applicable tax, and pickup details.");
      return;
    }
    setBusy(true);
    setMessage("");
    const { error } = await client.rpc("catering_decide_quote_v1", {
      p_token: token, p_menu: menu.trim(), p_total_cents: cents,
      p_pickup_terms: pickup.trim(), p_decision_name: decisionName.trim(),
    });
    setBusy(false);
    if (error) {
      setMessage("The decision could not be saved. The link may have expired or been used.");
    } else {
      setSaved(true);
      setContext(null);
      window.history.replaceState({}, "", "/quote-decision");
    }
  }

  return <main className="min-h-screen bg-[#f6f7f4] px-4 py-10 text-stone-900">
    <div className="mx-auto max-w-2xl rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
      <p className="text-xs font-bold uppercase tracking-widest text-green-800">Nazar catering</p>
      <h1 className="mt-1 text-2xl font-bold">Final menu and price decision</h1>
      {loading ? <p className="mt-5 text-sm">Checking the review link…</p>
        : saved ? <p role="status" className="mt-5 rounded-xl bg-green-50 p-4 text-sm text-green-900">Decision saved. Nazar staff can now prepare the customer quote. This did not send an email or start a payment.</p>
          : context ? <>
            <p className="mt-4 text-sm text-stone-600">Request {context.request_id.slice(0, 8)} · Event {context.event_date || "date not set"} · Guests {context.guests ?? "not set"}</p>
            <div className="mt-4 whitespace-pre-wrap rounded-xl bg-stone-50 p-4 text-sm"><strong>Customer request:</strong><br />{context.message || "No message recorded."}</div>
            <form onSubmit={(event) => void save(event)} className="mt-5 space-y-4">
              <label className="block text-sm font-semibold">Your name<input required maxLength={100} value={decisionName} onChange={(event) => setDecisionName(event.target.value)} placeholder="Yücel" className="mt-1 w-full rounded-lg border p-3 font-normal" /></label>
              <label className="block text-sm font-semibold">Final menu and quantities<textarea required maxLength={4000} value={menu} onChange={(event) => setMenu(event.target.value)} className="mt-1 min-h-28 w-full rounded-lg border p-3 font-normal" /></label>
              <label className="block text-sm font-semibold">Final total, including any applicable tax ($)<input required inputMode="decimal" value={price} onChange={(event) => setPrice(event.target.value)} placeholder="475.00" className="mt-1 w-full rounded-lg border p-3 font-normal" /></label>
              <label className="block text-sm font-semibold">Pickup details<textarea required maxLength={1000} value={pickup} onChange={(event) => setPickup(event.target.value)} placeholder="Pickup date, time and any conditions" className="mt-1 min-h-20 w-full rounded-lg border p-3 font-normal" /></label>
              <p className="text-xs text-stone-600">Saving records this decision against the request. Nazar staff reviews the customer email before sending. No payment is taken here.</p>
              <button disabled={busy} className="rounded-lg bg-green-800 px-5 py-3 font-semibold text-white disabled:opacity-50">Save final decision</button>
            </form>
          </> : <p role="alert" className="mt-5 rounded-xl bg-amber-50 p-4 text-sm text-amber-900">{message || "Review link unavailable."}</p>}
      {context && message && <p role="alert" className="mt-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">{message}</p>}
    </div>
  </main>;
}
