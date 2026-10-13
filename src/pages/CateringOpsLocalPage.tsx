import { useCallback, useEffect, useState } from "react";
import { createClient, type Session } from "@supabase/supabase-js";
import { customerQuoteMailto, customerQuoteMessage, formatDollars, type ApprovedQuote } from "../lib/cateringQuote";

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
const localQuoteTestMode = import.meta.env.VITE_CATERING_QUOTE_TEST_MODE === "true"
  && url !== "https://khgczybubufouraqyrcj.supabase.co";
const quoteActionEnabled = import.meta.env.VITE_CATERING_QUOTE_ENABLED === "true" || localQuoteTestMode;
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
  const [quotes, setQuotes] = useState<ApprovedQuote[]>([]);
  const [quoteAvailable, setQuoteAvailable] = useState(false);
  const [deliveryConfirmed, setDeliveryConfirmed] = useState(false);
  const [reviewLink, setReviewLink] = useState<{ requestId: string; href: string } | null>(null);

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
    const [overviewResult, quoteResult] = await Promise.all([
      client.rpc("crm_overview_v2", { p_search: "", p_segment: "all" }),
      client.rpc("catering_quote_overview_v1"),
    ]);
    const { data, error: readError } = overviewResult;
    if (readError) {
      setRequests(null);
      setError(readError.code === "42501" ? "This account does not have Nazar staff access." : "Requests could not be loaded. Please try again.");
    } else {
      const rows = (data as Overview)?.requests;
      setRequests(Array.isArray(rows) ? rows : []);
    }
    setQuoteAvailable(!quoteResult.error);
    setQuotes(!quoteResult.error && Array.isArray((quoteResult.data as { items?: ApprovedQuote[] })?.items)
      ? (quoteResult.data as { items: ApprovedQuote[] }).items : []);
    setBusy(false);
  }, [session]);

  async function markSent(quote: ApprovedQuote, request: Request) {
    if (!client || !session || !deliveryConfirmed || !quoteActionEnabled) return;
    const channel = request.email ? "email" : "phone";
    const recipient = request.email || request.phone;
    if (!recipient) return;
    setBusy(true);
    const { data, error: saveError } = await client.rpc("catering_mark_quote_sent_v1", {
      p_quote_id: quote.id, p_channel: channel, p_recipient: recipient,
    });
    setBusy(false);
    if (saveError || data !== true) {
      setError("Delivery could not be recorded. Confirm the approved quote is still current and try again.");
    } else {
      setDeliveryConfirmed(false);
      void refresh();
    }
  }

  async function prepareReviewLink(request: Request) {
    if (!client || !session || busy || !quoteActionEnabled) return;
    setBusy(true);
    setError("");
    const { data, error: issueError } = await client.rpc("catering_issue_quote_link_v1", { p_request_id: request.id });
    setBusy(false);
    if (issueError || typeof data !== "string" || !/^[0-9a-f]{64}$/.test(data)) {
      setError("Review link could not be prepared. The quote workflow may not be connected yet.");
      return;
    }
    setReviewLink({ requestId: request.id, href: `${window.location.origin}/quote-decision#token=${data}` });
  }

  useEffect(() => {
    if (session) queueMicrotask(() => { void refresh(); });
  }, [session, refresh]);

  const visible = (requests || []).filter((request) => showClosed || active.has(request.status));
  const selected = visible.find((request) => request.id === selectedId) || visible[0];
  const selectedQuote = quotes.filter((quote) => quote.request_id === selected?.id)
    .sort((a, b) => b.version - a.version)[0];

  return <main className="min-h-screen bg-[#f6f7f4] px-4 py-7 text-stone-900">
    <div className="mx-auto max-w-6xl">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-widest text-green-800">Nazar catering · staff view</p>
          <h1 className="mt-1 text-3xl font-bold">Incoming quote requests</h1>
          <p className="mt-2 max-w-3xl text-sm text-stone-600">Catering requests, menu and price decisions, and customer quote delivery in one place.</p>
        </div>
        {!quoteActionEnabled && <span className="rounded-full bg-amber-100 px-3 py-2 text-xs font-bold text-amber-900">Quote actions disabled</span>}
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
                  <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm"><strong>Next action:</strong> {active.has(selected.status) ? "Get the final menu and price decision, then deliver the approved quote." : "This request is closed; no quote action is pending."} The email draft never sends automatically; record delivery only after sending it.</div>
                  {quoteAvailable && quoteActionEnabled && active.has(selected.status) && <section className="mt-5 rounded-xl border border-stone-200 p-4">
                    <h3 className="font-bold">Yücel's menu and price review</h3>
                    <p className="mt-2 text-sm text-stone-600">Create a one-use link for this request. It expires in 48 hours and the email must be sent by Nazar staff.</p>
                    <button type="button" disabled={busy} onClick={() => void prepareReviewLink(selected)} className="mt-3 rounded-lg border border-green-800 px-4 py-2 text-sm font-semibold text-green-800 disabled:opacity-50">Prepare Yücel review link</button>
                    {reviewLink?.requestId === selected.id && <>
                      <a className="mt-3 block text-sm font-semibold text-green-800 underline" href={`mailto:ctnazarbakery%40gmail.com?subject=${encodeURIComponent(`Nazar catering decision ${selected.id.slice(0, 8)}`)}&body=${encodeURIComponent(`Yücel, please review this catering request and enter the final menu, total price and pickup details here:\n${reviewLink.href}\n\nThis link expires in 48 hours and works once.`)}`}>Open review email draft to Yücel</a>
                      {import.meta.env.DEV && <p className="mt-2 text-xs text-amber-800">Local address: this link opens only on this computer. Do not send it to another device before the screen is published.</p>}
                    </>}
                  </section>}
                  <section className="mt-5 rounded-xl border border-stone-200 p-4">
                    <h3 className="font-bold">Customer quote</h3>
                    {!quoteAvailable ? <p className="mt-2 text-sm text-stone-600">Quote records are not connected to this database yet.</p>
                      : !selectedQuote ? <p className="mt-2 text-sm text-stone-600">No menu and price decision has been saved for this request.</p>
                        : <>
                          <p className="mt-2 text-sm">Version {selectedQuote.version} · {selectedQuote.stage}</p>
                          <p className="mt-2 whitespace-pre-wrap text-sm"><strong>Final menu:</strong> {selectedQuote.menu}</p>
                          <p className="mt-2 text-sm"><strong>Final total:</strong> {formatDollars(selectedQuote.total_cents)}</p>
                          {selectedQuote.decision_name && <p className="mt-2 text-sm"><strong>Decision recorded as:</strong> {selectedQuote.decision_name}</p>}
                          <p className="mt-2 text-sm"><strong>Pickup details:</strong> {selectedQuote.pickup_terms}</p>
                          {quoteActionEnabled && selectedQuote.stage === "approved" && selected.email && <>
                            <textarea readOnly aria-label="Customer quote email" value={customerQuoteMessage(selected.name, selectedQuote)} className="mt-3 h-56 w-full rounded-lg border bg-stone-50 p-3 text-sm" />
                            <a href={customerQuoteMailto(selected.email, selectedQuote, selected.name)} className="mt-3 inline-block rounded-lg bg-green-800 px-4 py-2 text-sm font-semibold text-white">Open customer email draft</a>
                          </>}
                          {quoteActionEnabled && selectedQuote.stage === "approved" && (selected.email || selected.phone) && <>
                            <label className="mt-4 flex gap-2 text-sm"><input type="checkbox" checked={deliveryConfirmed} onChange={(event) => setDeliveryConfirmed(event.target.checked)} />I actually delivered this exact quote to the customer by {selected.email ? "email" : "phone"}.</label>
                            <button type="button" disabled={!deliveryConfirmed || busy} onClick={() => void markSent(selectedQuote, selected)} className="mt-3 rounded-lg border border-green-800 px-4 py-2 text-sm font-semibold text-green-800 disabled:opacity-50">Record quote as sent</button>
                          </>}
                          {selectedQuote.stage === "approved" && !selected.email && !selected.phone && <p className="mt-2 text-sm text-red-800">No contact method is recorded; delivery is blocked.</p>}
                        </>}
                  </section>
                </> : <p className="text-sm text-stone-600">Select a request to review it.</p>}
              </section>
            </div>}
          </>}
      <p className="mt-8 text-xs text-stone-500">Private staff information. Do not share outside Nazar.</p>
    </div>
  </main>;
}
