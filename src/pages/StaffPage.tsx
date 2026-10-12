import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { createClient, type Session } from "@supabase/supabase-js";

type Customer = {
  id: string; name: string | null; email: string | null; phone: string | null;
  email_status: string; created_at: string; signup_count: number;
  last_signup_at: string | null; last_source: string | null;
  notes: { id: string; body: string; created_at: string }[];
};
type CateringRequest = {
  id: string; customer_id: string; name: string | null; email: string | null;
  phone: string | null; event_date: string | null; guests: number | null;
  message: string | null; status: string; assigned_to: string;
  follow_up_at: string | null; created_at: string;
};
type Overview = { customers: Customer[]; requests: CateringRequest[] };

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
const client = url && key ? createClient(url, key) : null;
const statuses = ["new", "contacted", "quoted", "won", "lost", "closed"];
const activeStatuses = new Set(["new", "contacted", "quoted"]);

function date(value: string | null) {
  return value ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "—";
}
function localInput(value: string | null) {
  if (!value) return "";
  const d = new Date(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function StaffPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [email, setEmail] = useState("");
  const [search, setSearch] = useState("");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [selectedCustomer, setSelectedCustomer] = useState<string | null>(null);
  const [selectedRequest, setSelectedRequest] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [status, setStatus] = useState("new");
  const [assignee, setAssignee] = useState("");
  const [followUp, setFollowUp] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const refreshSequence = useRef(0);

  useEffect(() => {
    document.title = "Nazar staff | Customer follow-up";
    const robots = document.createElement("meta");
    robots.name = "robots";
    robots.content = "noindex,nofollow";
    document.head.appendChild(robots);
    if (!client) return () => robots.remove();
    void client.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: listener } = client.auth.onAuthStateChange((_event, next) => {
      if (!next) refreshSequence.current += 1;
      setSession(next);
    });
    return () => { listener.subscription.unsubscribe(); robots.remove(); };
  }, []);

  const refresh = useCallback(async (query = "") => {
    if (!client || !session) return;
    const sequence = ++refreshSequence.current;
    setBusy(true); setMessage("");
    const { data, error } = await client.rpc("crm_overview", { p_search: query });
    if (sequence !== refreshSequence.current) return;
    if (error) {
      setOverview(null);
      setMessage(error.code === "42501" ? "This account does not have Nazar staff access." : "Could not load records. Try again.");
    } else {
      setOverview(data as Overview);
      setMessage("");
    }
    setBusy(false);
  }, [session]);

  useEffect(() => {
    if (!session) return;
    queueMicrotask(() => { void refresh(""); });
  }, [session, refresh]);

  async function sendLink(event: FormEvent) {
    event.preventDefault();
    if (!client) return;
    setBusy(true); setMessage("");
    const { error } = await client.auth.signInWithOtp({
      email: email.trim(), options: { shouldCreateUser: false, emailRedirectTo: `${window.location.origin}/staff` },
    });
    setMessage(error?.status === 429
      ? "Sign-in email limit reached. Please try again later."
      : error
        ? "Could not send the sign-in link. Check that this address was invited, then try again."
        : "Check your email for the sign-in link.");
    setBusy(false);
  }

  const currentCustomer = overview?.customers.find((c) => c.id === selectedCustomer);
  const currentRequest = overview?.requests.find((r) => r.id === selectedRequest);

  function chooseRequest(request: CateringRequest) {
    setSelectedRequest(request.id);
    setStatus(request.status);
    setAssignee(request.assigned_to);
    setFollowUp(localInput(request.follow_up_at));
    setMessage("");
  }

  async function saveRequest(event: FormEvent) {
    event.preventDefault();
    if (!client || !currentRequest) return;
    if (activeStatuses.has(status) && !followUp) {
      setMessage("Set a follow-up time for an open request."); return;
    }
    setBusy(true); setMessage("");
    const { data, error } = await client.rpc("crm_update_catering", {
      p_request_id: currentRequest.id, p_status: status,
      p_assigned_to: assignee.trim(),
      p_follow_up_at: followUp ? new Date(followUp).toISOString() : null,
    });
    if (error || !data) setMessage("Could not save this request.");
    else { await refresh(search); setMessage("Request saved."); }
    setBusy(false);
  }

  async function addNote(event: FormEvent) {
    event.preventDefault();
    if (!client || !currentCustomer || !note.trim()) return;
    setBusy(true); setMessage("");
    const { data, error } = await client.rpc("crm_add_note", {
      p_customer_id: currentCustomer.id, p_body: note.trim(),
    });
    if (error || !data) setMessage("Could not save the note.");
    else { setNote(""); await refresh(search); setMessage("Note saved."); }
    setBusy(false);
  }

  return <main className="min-h-screen bg-stone-50 px-4 py-8 text-stone-900">
    <div className="mx-auto max-w-6xl">
      <header className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <div><p className="text-xs font-bold uppercase tracking-widest text-green-800">Nazar staff</p><h1 className="text-3xl font-bold">Customer follow-up</h1></div>
        {session && <button className="rounded-lg border px-4 py-2" onClick={() => { void client?.auth.signOut(); setOverview(null); }}>Sign out</button>}
      </header>
      {!client ? <p>Staff access is not configured.</p> : !session ?
        <form onSubmit={sendLink} className="max-w-md space-y-4 rounded-2xl border bg-white p-6 shadow-sm">
          <h2 className="text-xl font-semibold">Staff sign-in</h2>
          <p className="text-sm text-stone-600">Use the email address invited by Nazar’s owner.</p>
          <label className="block text-sm font-medium">Email<input className="mt-1 w-full rounded-lg border p-3" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          <button disabled={busy} className="rounded-lg bg-green-800 px-5 py-3 font-semibold text-white disabled:opacity-50">Send sign-in link</button>
        </form> : <>
          <form onSubmit={(e) => { e.preventDefault(); void refresh(search); }} className="mb-5 flex flex-wrap gap-2">
            <input aria-label="Search customers" placeholder="Search name, email or phone" value={search} onChange={(e) => setSearch(e.target.value)} className="min-w-64 flex-1 rounded-lg border bg-white p-3" />
            <button disabled={busy} className="rounded-lg bg-green-800 px-5 py-3 font-semibold text-white disabled:opacity-50">Search</button>
            <button type="button" disabled={busy} onClick={() => void refresh(search)} className="rounded-lg border bg-white px-5 py-3">Refresh</button>
          </form>
          {overview && <div className="grid gap-6 lg:grid-cols-2">
            <section className="rounded-2xl border bg-white p-5 shadow-sm">
              <h2 className="mb-3 text-xl font-semibold">Customers <span className="text-sm font-normal text-stone-500">({overview.customers.length}, up to 100)</span></h2>
              <div className="max-h-96 space-y-2 overflow-auto">
                {overview.customers.map((c) => <button key={c.id} onClick={() => { setSelectedCustomer(c.id); setMessage(""); }} className="block w-full rounded-lg border p-3 text-left hover:bg-green-50">
                  <strong>{c.name || "Unnamed customer"}</strong><span className="ml-2 text-xs text-stone-500">{c.last_source || "unknown source"}</span>
                  <span className="block text-sm text-stone-600">{c.email || c.phone || "—"} · Local consent: {c.email_status}</span>
                </button>)}
                {!overview.customers.length && <p className="text-sm text-stone-500">No matching customers.</p>}
              </div>
              {currentCustomer && <div className="mt-5 border-t pt-4">
                <h3 className="font-semibold">{currentCustomer.name || "Unnamed customer"}</h3>
                <p className="text-sm">{currentCustomer.email || "—"} · {currentCustomer.phone || "—"}</p>
                <p className="mt-1 text-xs text-stone-500">Last signup: {date(currentCustomer.last_signup_at)} · Signups: {currentCustomer.signup_count}</p>
                <h4 className="mt-4 font-semibold">Internal notes</h4>
                <div className="max-h-40 overflow-auto">{currentCustomer.notes.map((n) => <p key={n.id} className="mt-2 rounded-lg bg-stone-50 p-2 text-sm">{n.body}<span className="block text-xs text-stone-500">{date(n.created_at)}</span></p>)}</div>
                <form onSubmit={addNote} className="mt-3"><textarea maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add an internal note" className="w-full rounded-lg border p-2" /><button disabled={busy || !note.trim()} className="rounded-lg bg-green-800 px-4 py-2 text-white disabled:opacity-50">Save note</button></form>
              </div>}
            </section>
            <section className="rounded-2xl border bg-white p-5 shadow-sm">
              <h2 className="mb-3 text-xl font-semibold">Catering requests <span className="text-sm font-normal text-stone-500">({overview.requests.length}, up to 100)</span></h2>
              <div className="max-h-96 space-y-2 overflow-auto">
                {overview.requests.map((r) => <button key={r.id} onClick={() => chooseRequest(r)} className="block w-full rounded-lg border p-3 text-left hover:bg-green-50">
                  <strong>{r.name || "Unnamed customer"}</strong><span className="ml-2 rounded-full bg-stone-100 px-2 py-1 text-xs">{r.status}</span>
                  <span className="block text-sm text-stone-600">Follow up: {date(r.follow_up_at)} · {r.assigned_to}</span>
                </button>)}
                {!overview.requests.length && <p className="text-sm text-stone-500">No matching requests.</p>}
              </div>
              {currentRequest && <div className="mt-5 border-t pt-4">
                <h3 className="font-semibold">{currentRequest.name || "Unnamed customer"}</h3>
                <p className="text-sm">{currentRequest.email || "—"} · {currentRequest.phone || "—"}</p>
                <p className="mt-1 text-sm">Event: {currentRequest.event_date || "—"} · Guests: {currentRequest.guests || "—"}</p>
                <p className="mt-3 whitespace-pre-wrap rounded-lg bg-stone-50 p-3 text-sm">{currentRequest.message || "No message"}</p>
                <form onSubmit={saveRequest} className="mt-4 grid gap-3 sm:grid-cols-2">
                  <label className="text-sm">Status<select value={status} onChange={(e) => setStatus(e.target.value)} className="mt-1 w-full rounded-lg border p-2">{statuses.map((s) => <option key={s}>{s}</option>)}</select></label>
                  <label className="text-sm">Assigned to<input required maxLength={100} value={assignee} onChange={(e) => setAssignee(e.target.value)} className="mt-1 w-full rounded-lg border p-2" /></label>
                  <label className="text-sm">Next follow-up (your device time)<input type="datetime-local" value={followUp} onChange={(e) => setFollowUp(e.target.value)} className="mt-1 w-full rounded-lg border p-2" /></label>
                  <div className="flex items-end"><button disabled={busy} className="rounded-lg bg-green-800 px-5 py-2 text-white disabled:opacity-50">Save request</button></div>
                </form>
              </div>}
            </section>
          </div>}
        </>}
      {message && <p role="status" className="mt-5 rounded-lg bg-amber-50 p-3 text-sm">{message}</p>}
      <p className="mt-8 text-xs text-stone-500">Private staff workspace. Customer information must not be shared outside Nazar.</p>
    </div>
  </main>;
}
