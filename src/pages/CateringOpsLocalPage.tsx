import { useCallback, useEffect, useState } from "react";
import { createClient, type Session } from "@supabase/supabase-js";

type Request = {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  event_date: string | null;
  guests: number | null;
  message: string | null;
  status: string;
  assigned_to: string | null;
  follow_up_at: string | null;
  created_at: string;
};

type Overview = { requests: Request[] };
const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
const client = url && key ? createClient(url, key) : null;
const active = new Set(["new", "contacted", "quoted"]);

function formatDate(value: string | null, includeTime = false) {
  if (!value) return "Not set";
  const parsed = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value);
  return Number.isNaN(parsed.getTime()) ? value : new Intl.DateTimeFormat("en-US", { dateStyle: "medium", ...(includeTime ? { timeStyle: "short" } as const : {}) }).format(parsed);
}

export default function CateringOpsLocalPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [requests, setRequests] = useState<Request[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showClosed, setShowClosed] = useState(false);

  useEffect(() => {
    document.title = "Nazar catering | Local request review";
    const robots = document.createElement("meta");
    robots.name = "robots";
    robots.content = "noindex,nofollow";
    document.head.appendChild(robots);
    if (!client) return () => robots.remove();
    void client.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: listener } = client.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      if (!next) { setRequests(null); setSelectedId(null); }
    });
    return () => { listener.subscription.unsubscribe(); robots.remove(); };
  }, []);

  const refresh = useCallback(async () => {
    if (!client || !session) return;
    setBusy(true);
    setError("");
    const { data, error: readError } = await client.rpc("crm_overview_v2", { p_search: "", p_segment: "all" });
    if (readError) {
      setRequests(null);
      setError(readError.code === "42501" ? "This account does not have Nazar staff access." : "Requests could not be loaded. Please try again.");
    } else {
      const rows = (data as Overview)?.requests;
      setRequests(Array.isArray(rows) ? rows : []);
    }
    setBusy(false);
  }, [session]);

  useEffect(() => {
    if (session) queueMicrotask(() => { void refresh(); });
  }, [session, refresh]);

  const visible = (requests || []).filter((request) => showClosed || active.has(request.status));
  const selected = visible.find((request) => request.id === selectedId) || visible[0];

  return <main className="min-h-screen bg-[#f6f7f4] px-4 py-7 text-stone-900">
    <div className="mx-auto max-w-6xl">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-widest text-green-800">Nazar catering · local staff view</p>
          <h1 className="mt-1 text-3xl font-bold">Incoming quote requests</h1>
          <p className="mt-2 max-w-3xl text-sm text-stone-600">Actual catering records from Nazar's existing staff database. This screen is read-only while the quote decision and customer sending workflow is being connected.</p>
        </div>
        <span className="rounded-full bg-amber-100 px-3 py-2 text-xs font-bold text-amber-900">Local only · no quotes sent</span>
      </header>

      {!client ? <p className="rounded-xl bg-white p-5">Local staff connection is not configured.</p>
        : !session ? <section className="rounded-xl border bg-white p-5">
          <h2 className="font-bold">Staff sign-in required</h2>
          <p className="mt-2 text-sm">Sign in on the local <a className="text-green-800 underline" href="/staff">Customer follow-up screen</a>, then return here. No customer information is shown without an authorized session.</p>
        </section>
          : <>
            <div className="mb-4 flex flex-wrap items-center gap-3">
              <button type="button" disabled={busy} onClick={() => void refresh()} className="rounded-lg bg-green-800 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Refresh requests</button>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={showClosed} onChange={(event) => setShowClosed(event.target.checked)} />Show closed requests</label>
              <span className="text-sm text-stone-600">{requests === null ? "Loading requests…" : `${visible.length} shown · up to 100 total`}</span>
            </div>
            {error && <p role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-900">{error}</p>}
            {requests && <div className="grid gap-5 lg:grid-cols-[minmax(260px,0.8fr)_minmax(0,1.4fr)]">
              <section className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
                <h2 className="mb-3 font-bold">Request queue</h2>
                <div className="max-h-[38rem] space-y-2 overflow-auto">
                  {visible.map((request) => <button key={request.id} type="button" onClick={() => setSelectedId(request.id)} aria-pressed={selected?.id === request.id}
                    className={`w-full rounded-xl border p-3 text-left text-sm hover:bg-green-50 ${selected?.id === request.id ? "border-green-800 bg-green-50" : "border-stone-200"}`}>
                    <strong className="block">{request.name || "Unnamed customer"}</strong>
                    <span className="text-stone-600">{request.status} · Event {formatDate(request.event_date)}</span>
                    <span className="block text-xs text-stone-500">Received {formatDate(request.created_at, true)}</span>
                  </button>)}
                  {!visible.length && <p className="text-sm text-stone-600">No requests in this view.</p>}
                </div>
              </section>
              <section className="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
                {selected ? <>
                  <div className="flex flex-wrap justify-between gap-2"><h2 className="text-xl font-bold">{selected.name || "Unnamed customer"}</h2><span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-bold text-amber-900">{selected.status}</span></div>
                  <p className="mt-1 break-all text-xs text-stone-500">Request ID: {selected.id}</p>
                  <dl className="mt-5 grid gap-4 text-sm sm:grid-cols-2">
                    <div><dt className="text-stone-500">Contact</dt><dd>{[selected.email, selected.phone].filter(Boolean).join(" · ") || "Not supplied"}</dd></div>
                    <div><dt className="text-stone-500">Event date</dt><dd>{formatDate(selected.event_date)}</dd></div>
                    <div><dt className="text-stone-500">Guest count</dt><dd>{selected.guests ?? "Not supplied"}</dd></div>
                    <div><dt className="text-stone-500">Next follow-up</dt><dd>{formatDate(selected.follow_up_at, true)}</dd></div>
                  </dl>
                  <h3 className="mt-6 font-bold">Customer request and menu selection</h3>
                  <p className="mt-2 whitespace-pre-wrap rounded-xl bg-stone-50 p-4 text-sm">{selected.message || "No request text was recorded."}</p>
                  <p className="mt-3 text-xs text-stone-600">Older submissions store the selection in this text. Separate product rows and quantities will appear after the structured intake change is released and verified.</p>
                  <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm"><strong>Next action:</strong> {active.has(selected.status) ? "Review the request for Yücel's final menu and price decision." : "This request is closed; no quote action is pending."} Decision saving, quote sending and customer acceptance are not active on this local screen.</div>
                </> : <p className="text-sm text-stone-600">Select a request to review it.</p>}
              </section>
            </div>}
          </>}
      <p className="mt-8 text-xs text-stone-500">Private staff information. Do not share outside Nazar.</p>
    </div>
  </main>;
}
