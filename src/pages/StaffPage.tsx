import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { createClient, type Session } from "@supabase/supabase-js";

type Customer = {
  id: string; name: string | null; email: string | null; phone: string | null;
  email_status: string; created_at: string; signup_count: number;
  last_signup_at: string | null; last_source: string | null;
  vip_signup_count: number; kevin_signup_count: number;
  recent_signups: { id: string; source: string; campaign: string | null; created_at: string }[];
  notes: { id: string; body: string; created_at: string }[];
};
type CateringRequest = {
  id: string; customer_id: string; name: string | null; email: string | null;
  phone: string | null; event_date: string | null; guests: number | null;
  message: string | null; status: string; assigned_to: string;
  follow_up_at: string | null; created_at: string;
};
type Overview = { customers: Customer[]; requests: CateringRequest[] };
type Segment = "all" | "vip" | "kevin";
type KlaviyoStatus = "confirmed" | "pending" | "unsubscribed" | "suppressed" | "not_on_list" | "unavailable";
type KlaviyoResult = { email: string; status: KlaviyoStatus; checkedAt: string | null };
type FollowUpTask = { id: string; title: string; assigned_to: string; due_at: string; completed_at: string | null };
type CateringDecision = {
  id: string; request_id: string; question: string; requested_at: string;
  decision: string | null; recorded_at: string | null;
  request_status: string; customer_name: string | null;
};
type DecisionQueue = { items: CateringDecision[] };
type DecisionEmailDraft = { decisionId: string; to: string; cc: string; subject: string; body: string };

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
const client = url && key ? createClient(url, key) : null;
const statuses = ["new", "contacted", "quoted", "won", "lost", "closed"];
const activeStatuses = new Set(["new", "contacted", "quoted"]);
const segments: { value: Segment; label: string }[] = [
  { value: "all", label: "All customers" },
  { value: "vip", label: "VIP signups" },
  { value: "kevin", label: "Kevin campaign" },
];

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
  const [segment, setSegment] = useState<Segment>("all");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [selectedCustomer, setSelectedCustomer] = useState<string | null>(null);
  const [selectedRequest, setSelectedRequest] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [status, setStatus] = useState("new");
  const [assignee, setAssignee] = useState("");
  const [followUp, setFollowUp] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [klaviyo, setKlaviyo] = useState<KlaviyoResult | null>(null);
  const [tasks, setTasks] = useState<{ customerId: string; items: FollowUpTask[] } | null>(null);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskOwner, setTaskOwner] = useState("");
  const [taskDue, setTaskDue] = useState("");
  const [decisionQueue, setDecisionQueue] = useState<DecisionQueue | null>(null);
  const [decisionQuestion, setDecisionQuestion] = useState("");
  const [decisionEmailDraft, setDecisionEmailDraft] = useState<DecisionEmailDraft | null>(null);
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

  const refresh = useCallback(async (query = "", view: Segment = "all") => {
    if (!client || !session) return;
    const sequence = ++refreshSequence.current;
    setBusy(true); setMessage("");
    const [overviewResult, decisionsResult] = await Promise.all([
      client.rpc("crm_overview_v2", { p_search: query, p_segment: view }),
      client.rpc("crm_catering_decisions_v1"),
    ]);
    const { data, error } = overviewResult;
    if (sequence !== refreshSequence.current) return;
    if (error) {
      setOverview(null);
      setMessage(error.code === "42501" ? "This account does not have Nazar staff access." : "Could not load records. Try again.");
    } else {
      setOverview(data as Overview);
      setMessage("");
    }
    setDecisionQueue(!decisionsResult.error ? decisionsResult.data as DecisionQueue : null);
    setBusy(false);
  }, [session]);

  useEffect(() => {
    if (!session) return;
    queueMicrotask(() => { void refresh(""); });
  }, [session, refresh]);

  useEffect(() => {
    if (!client || !session) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void client.rpc("crm_catering_decisions_v1").then(({ data, error }) => {
        if (!error) setDecisionQueue(data as DecisionQueue);
      });
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [session]);

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
  const pendingDecision = decisionQueue?.items.find((item) =>
    item.request_id === selectedRequest && !item.recorded_at);

  useEffect(() => {
    const emailAddress = currentCustomer?.email;
    if (!emailAddress || !session?.access_token) return;
    const controller = new AbortController();
    queueMicrotask(() => setKlaviyo(null));
    void fetch("/api/staff/klaviyo-status", {
      method: "POST", signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ email: emailAddress }),
    }).then(async (response) => {
      if (!response.ok) throw new Error("Klaviyo lookup failed");
      return response.json() as Promise<{ status: KlaviyoStatus; checkedAt: string }>;
    }).then((data) => { if (!controller.signal.aborted) setKlaviyo({ email: emailAddress, status: data.status, checkedAt: data.checkedAt }); })
      .catch(() => { if (!controller.signal.aborted) setKlaviyo({ email: emailAddress, status: "unavailable", checkedAt: null }); });
    return () => controller.abort();
  }, [currentCustomer?.email, session?.access_token]);

  useEffect(() => {
    const customerId = currentCustomer?.id;
    if (!client || !session || !customerId) return;
    let active = true;
    queueMicrotask(() => setTasks(null));
    void client.rpc("crm_customer_tasks_v1", { p_customer_id: customerId })
      .then(({ data, error }) => {
        if (!active) return;
        setTasks({ customerId, items: !error && Array.isArray(data) ? data as FollowUpTask[] : [] });
        if (error) setMessage("Could not load follow-up tasks.");
      });
    return () => { active = false; };
  }, [currentCustomer?.id, session]);

  async function createTask(event: FormEvent) {
    event.preventDefault();
    if (!client || !currentCustomer || !taskTitle.trim() || !taskOwner.trim() || !taskDue) return;
    setBusy(true); setMessage("");
    const { error } = await client.rpc("crm_create_task_v1", {
      p_customer_id: currentCustomer.id, p_title: taskTitle.trim(),
      p_assigned_to: taskOwner.trim(), p_due_at: new Date(taskDue).toISOString(),
    });
    if (error) setMessage("Could not save the follow-up task.");
    else {
      const result = await client.rpc("crm_customer_tasks_v1", { p_customer_id: currentCustomer.id });
      if (!result.error && Array.isArray(result.data)) setTasks({ customerId: currentCustomer.id, items: result.data as FollowUpTask[] });
      setTaskTitle(""); setTaskDue(""); setMessage("Follow-up task saved.");
    }
    setBusy(false);
  }

  async function completeTask(taskId: string) {
    if (!client || !currentCustomer) return;
    setBusy(true); setMessage("");
    const { data, error } = await client.rpc("crm_complete_task_v1", { p_task_id: taskId });
    if (error || !data) setMessage("Could not complete the task.");
    else {
      setTasks((previous) => previous?.customerId === currentCustomer.id
        ? { ...previous, items: previous.items.map((task) => task.id === taskId
          ? { ...task, completed_at: new Date().toISOString() } : task) } : previous);
      setMessage("Task completed.");
    }
    setBusy(false);
  }

  const klaviyoLabel: Record<KlaviyoStatus, string> = {
    confirmed: "Confirmed in Klaviyo", pending: "Confirmation not completed",
    unsubscribed: "Unsubscribed", suppressed: "Suppressed — do not email",
    not_on_list: "Not on the Nazar VIP list", unavailable: "Could not verify now",
  };

  function chooseRequest(request: CateringRequest) {
    setSelectedRequest(request.id);
    setStatus(request.status);
    setAssignee(request.assigned_to);
    setFollowUp(localInput(request.follow_up_at));
    setMessage("");
    setDecisionQuestion("");
  }

  async function requestDecision(event: FormEvent) {
    event.preventDefault();
    if (!client || !currentRequest || !decisionQuestion.trim()) return;
    setBusy(true); setMessage("");
    const { error } = await client.rpc("crm_request_catering_decision_v1", {
      p_request_id: currentRequest.id, p_question: decisionQuestion.trim(),
    });
    if (error) setMessage("Could not mark this request for Yücel's review.");
    else { setDecisionQuestion(""); await refresh(search, segment); setMessage("Marked for Yücel's review in CRM. No email was sent."); }
    setBusy(false);
  }

  async function prepareDecisionEmail(decisionId: string) {
    if (!session?.access_token) return;
    setBusy(true); setMessage(""); setDecisionEmailDraft(null);
    try {
      const response = await fetch("/api/staff/decision-email-draft", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ decisionId }),
      });
      if (!response.ok) throw new Error("Draft unavailable");
      const draft = await response.json() as Omit<DecisionEmailDraft, "decisionId">;
      setDecisionEmailDraft({ ...draft, decisionId });
    } catch { setMessage("Could not prepare the decision email. Please try again."); }
    setBusy(false);
  }

  function decisionMailto(draft: DecisionEmailDraft) {
    const query = new URLSearchParams({ cc: draft.cc, subject: draft.subject, body: draft.body });
    return `mailto:${encodeURIComponent(draft.to)}?${query.toString()}`;
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
    else { await refresh(search, segment); setMessage("Request saved."); }
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
    else { setNote(""); await refresh(search, segment); setMessage("Note saved."); }
    setBusy(false);
  }

  return <main className="min-h-screen bg-[#f6f7f4] px-4 py-8 text-stone-900">
    <div className="mx-auto max-w-7xl">
      <header className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <div><p className="text-xs font-bold uppercase tracking-widest text-green-800">Nazar staff</p><h1 className="text-3xl font-bold">Customer follow-up</h1></div>
        {import.meta.env.DEV && session && <a className="rounded-lg border border-green-800 px-4 py-2 text-sm font-semibold text-green-800" href="/catering-ops-local">Open local catering queue</a>}
        {session && <button className="rounded-lg border px-4 py-2" onClick={() => { void client?.auth.signOut(); setOverview(null); }}>Sign out</button>}
      </header>
      {!client ? <p>Staff access is not configured.</p> : !session ?
        <form onSubmit={sendLink} className="max-w-md space-y-4 rounded-2xl border bg-white p-6 shadow-sm">
          <h2 className="text-xl font-semibold">Staff sign-in</h2>
          <p className="text-sm text-stone-600">Use the email address invited by Nazar’s owner.</p>
          <label className="block text-sm font-medium">Email<input className="mt-1 w-full rounded-lg border p-3" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          <button disabled={busy} className="rounded-lg bg-green-800 px-5 py-3 font-semibold text-white disabled:opacity-50">Send sign-in link</button>
        </form> : <>
          <form onSubmit={(e) => { e.preventDefault(); void refresh(search, segment); }} className="mb-3 flex flex-wrap gap-2">
            <input aria-label="Search customers" placeholder="Search name, email or phone" value={search} onChange={(e) => setSearch(e.target.value)} className="min-w-64 flex-1 rounded-lg border bg-white p-3" />
            <button disabled={busy} className="rounded-lg bg-green-800 px-5 py-3 font-semibold text-white disabled:opacity-50">Search</button>
            <button type="button" disabled={busy} onClick={() => void refresh(search, segment)} className="rounded-lg border bg-white px-5 py-3">Refresh</button>
          </form>
          <nav aria-label="Customer groups" className="mb-5 flex flex-wrap gap-2">
            {segments.map((item) => <button key={item.value} type="button" aria-pressed={segment === item.value}
              onClick={() => { setSegment(item.value); setSelectedCustomer(null); setSelectedRequest(null); void refresh(search, item.value); }}
              className={`rounded-full border px-4 py-2 text-sm font-medium ${segment === item.value ? "border-green-800 bg-green-800 text-white" : "bg-white hover:bg-green-50"}`}>
              {item.label}
            </button>)}
          </nav>
          {overview && <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div className="rounded-xl border bg-white p-4"><span className="text-xs text-stone-500">Customers shown</span><strong className="block text-2xl">{overview.customers.length}</strong></div>
            <div className="rounded-xl border bg-white p-4"><span className="text-xs text-stone-500">VIP form records shown</span><strong className="block text-2xl">{overview.customers.filter((c) => c.vip_signup_count > 0).length}</strong></div>
            <div className="rounded-xl border bg-white p-4"><span className="text-xs text-stone-500">Open catering requests shown</span><strong className="block text-2xl">{overview.requests.filter((r) => activeStatuses.has(r.status)).length}</strong></div>
            <div className="rounded-xl border bg-white p-4"><span className="text-xs text-stone-500">Kevin records shown</span><strong className="block text-2xl">{overview.customers.filter((c) => c.kevin_signup_count > 0).length}</strong></div>
          </div>}
          {decisionQueue && <section className="mb-5 rounded-2xl border border-amber-200 bg-amber-50 p-5" aria-label="Price and menu decisions">
            <h2 className="font-semibold">Price and menu decisions awaiting Yücel</h2>
            <p className="mt-1 text-sm text-stone-600">Prepare an email to Yücel at Nazar, with the Nazar website address copied for Talip. Opening a draft does not send it or record a decision in CRM.</p>
            <div className="mt-3 space-y-2">
              {decisionQueue.items.filter((item) => !item.recorded_at).map((item) => <div key={item.id}
                className="rounded-lg border bg-white p-3 text-sm">
                <strong>{item.customer_name || "Catering customer"}</strong> · {item.question}
                <span className="block text-xs text-stone-500">Requested {date(item.requested_at)} · Awaiting Yücel</span>
                {overview?.requests.some((r) => r.id === item.request_id) && <button type="button"
                  onClick={() => { const request = overview.requests.find((r) => r.id === item.request_id); if (request) chooseRequest(request); }}
                  className="mt-2 text-green-800 underline">Open request</button>}
                <button type="button" disabled={busy} onClick={() => void prepareDecisionEmail(item.id)}
                  className="ml-3 mt-2 text-green-800 underline disabled:opacity-50">Prepare email to Yücel</button>
              </div>)}
              {!decisionQueue.items.some((item) => !item.recorded_at) && <p className="text-sm text-stone-600">No price or menu decisions waiting.</p>}
            </div>
            {decisionEmailDraft && <div className="mt-4 rounded-lg border border-amber-300 bg-white p-4 text-sm">
              <h3 className="font-semibold">Review the email draft</h3>
              <p className="mt-2"><strong>To:</strong> {decisionEmailDraft.to}</p>
              <p><strong>Cc:</strong> {decisionEmailDraft.cc}</p>
              <p><strong>Subject:</strong> {decisionEmailDraft.subject}</p>
              <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-stone-50 p-2 font-sans">{decisionEmailDraft.body}</pre>
              <a href={decisionMailto(decisionEmailDraft)} className="mt-3 inline-block rounded-lg bg-green-800 px-4 py-2 font-semibold text-white">Open in email app</a>
              <p className="mt-2 text-xs text-stone-600">Send the draft from your email account. Ask Yücel to reply all and sign his name. Both Nazar addresses forward to the shared inbox; replies are not imported into CRM yet.</p>
            </div>}
          </section>}
          {overview && <div className="grid gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
            <section className="rounded-2xl border bg-white p-5 shadow-sm">
              <h2 className="mb-3 text-xl font-semibold">Customers <span className="text-sm font-normal text-stone-500">({overview.customers.length}, up to 100)</span></h2>
              <div className="max-h-96 space-y-2 overflow-auto">
                {overview.customers.map((c) => <button key={c.id} onClick={() => { setSelectedCustomer(c.id); setMessage(""); }} className="block w-full rounded-lg border p-3 text-left hover:bg-green-50">
                  <strong>{c.name || "Unnamed customer"}</strong><span className="ml-2 text-xs text-stone-500">{c.last_source || "unknown source"}</span>
                  {c.vip_signup_count > 0 && <span className="ml-2 rounded-full bg-green-50 px-2 py-1 text-xs text-green-900">VIP {c.vip_signup_count}</span>}
                  {c.kevin_signup_count > 0 && <span className="ml-2 rounded-full bg-amber-50 px-2 py-1 text-xs text-amber-900">Kevin {c.kevin_signup_count}</span>}
                  <span className="block text-sm text-stone-600">{c.email || c.phone || "—"} · Local email status: {c.email_status}</span>
                </button>)}
                {!overview.customers.length && <p className="text-sm text-stone-500">No matching customers.</p>}
              </div>
            </section>
              {currentCustomer ? <section className="rounded-2xl border bg-white p-5 shadow-sm">
                <h3 className="font-semibold">{currentCustomer.name || "Unnamed customer"}</h3>
                <p className="text-sm">{currentCustomer.email || "—"} · {currentCustomer.phone || "—"}</p>
                <p className="mt-1 text-xs text-stone-500">Last signup: {date(currentCustomer.last_signup_at)} · Signups: {currentCustomer.signup_count}</p>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  <div className="rounded-lg bg-stone-50 p-3 text-sm"><span className="block text-xs text-stone-500">Local form status</span><strong>{currentCustomer.email_status}</strong><span className="block text-xs text-stone-500">This is not marketing consent.</span></div>
                  <div className="rounded-lg bg-stone-50 p-3 text-sm"><span className="block text-xs text-stone-500">Klaviyo VIP email status</span><strong>{!currentCustomer.email ? "No email address" : klaviyo?.email === currentCustomer.email ? klaviyoLabel[klaviyo.status] : "Checking…"}</strong><span className="block text-xs text-stone-500">{klaviyo?.email === currentCustomer.email && klaviyo.checkedAt ? `Checked ${date(klaviyo.checkedAt)}` : "Do not assume consent without verification."}</span></div>
                </div>
                <div className="mt-3 rounded-lg bg-stone-50 p-3 text-sm"><span className="block text-xs text-stone-500">Order history</span><strong>Not linked yet</strong><span className="block text-xs text-stone-500">The Nazar-owned checkout is still in testing. No payment or order is inferred from a form signup.</span></div>
                <h4 className="mt-4 font-semibold">Signup history</h4>
                <div className="max-h-40 overflow-auto">{currentCustomer.recent_signups.map((s) => <p key={s.id} className="mt-2 rounded-lg bg-stone-50 p-2 text-sm">
                  {s.source === "website_vip_page" ? "VIP form" : s.source}{s.campaign ? ` · Campaign: ${s.campaign}` : ""}
                  <span className="block text-xs text-stone-500">{date(s.created_at)}</span>
                </p>)}</div>
                <h4 className="mt-4 font-semibold">Catering history</h4>
                <div className="max-h-40 overflow-auto">{overview.requests.filter((r) => r.customer_id === currentCustomer.id).map((r) => <p key={r.id} className="mt-2 rounded-lg bg-stone-50 p-2 text-sm">
                  {r.status} · Event {r.event_date || "date not set"} · Follow-up {date(r.follow_up_at)}
                </p>)}{!overview.requests.some((r) => r.customer_id === currentCustomer.id) && <p className="text-sm text-stone-500">No catering request in the current results.</p>}</div>
                <h4 className="mt-4 font-semibold">Internal notes</h4>
                <div className="max-h-40 overflow-auto">{currentCustomer.notes.map((n) => <p key={n.id} className="mt-2 rounded-lg bg-stone-50 p-2 text-sm">{n.body}<span className="block text-xs text-stone-500">{date(n.created_at)}</span></p>)}</div>
                <form onSubmit={addNote} className="mt-3"><textarea maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add an internal note" className="w-full rounded-lg border p-2" /><button disabled={busy || !note.trim()} className="rounded-lg bg-green-800 px-4 py-2 text-white disabled:opacity-50">Save note</button></form>
                <h4 className="mt-5 font-semibold">Customer follow-up</h4>
                {tasks?.customerId === currentCustomer.id ? <div className="mt-2 space-y-2">{tasks.items.map((task) => <div key={task.id} className="rounded-lg border p-3 text-sm">
                  <strong className="block">{task.title}</strong><span className="text-stone-600">{task.assigned_to} · Due {date(task.due_at)} · {task.completed_at ? "Completed" : "Open"}</span>
                  {!task.completed_at && <button type="button" disabled={busy} onClick={() => void completeTask(task.id)} className="ml-2 underline disabled:opacity-50">Mark done</button>}
                </div>)}{!tasks.items.length && <p className="text-sm text-stone-500">No follow-up task yet.</p>}</div> : <p className="text-sm text-stone-500">Loading follow-up tasks…</p>}
                <form onSubmit={createTask} className="mt-3 grid gap-2 sm:grid-cols-2">
                  <label className="text-sm">Task<input required maxLength={300} value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} className="mt-1 w-full rounded-lg border p-2" /></label>
                  <label className="text-sm">Assigned to<input required maxLength={100} value={taskOwner} onChange={(e) => setTaskOwner(e.target.value)} className="mt-1 w-full rounded-lg border p-2" /></label>
                  <label className="text-sm">Due time<input required type="datetime-local" value={taskDue} onChange={(e) => setTaskDue(e.target.value)} className="mt-1 w-full rounded-lg border p-2" /></label>
                  <div className="flex items-end"><button disabled={busy} className="rounded-lg bg-green-800 px-4 py-2 text-white disabled:opacity-50">Add follow-up</button></div>
                </form>
              </section> : <section className="rounded-2xl border bg-white p-5 text-sm text-stone-600 shadow-sm">Select a customer to view their profile, VIP status and follow-up history.</section>}
            <section className="rounded-2xl border bg-white p-5 shadow-sm lg:col-span-2">
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
                {decisionQueue && <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4">
                  <h4 className="font-semibold">Yücel's price/menu decision</h4>
                  {pendingDecision ? <>
                    <p className="mt-2 text-sm"><strong>Question:</strong> {pendingDecision.question}</p>
                    <p className="text-sm text-amber-800">Waiting for Yücel's own response. Prepare and send the email from the decision queue above.</p>
                  </> : <form onSubmit={requestDecision} className="mt-2 space-y-2">
                    <label className="block text-sm">What price or menu decision is needed?<textarea required maxLength={1000}
                      value={decisionQuestion} onChange={(e) => setDecisionQuestion(e.target.value)}
                      className="mt-1 w-full rounded-lg border bg-white p-2" /></label>
                    <button disabled={busy} className="rounded-lg bg-amber-700 px-4 py-2 text-white disabled:opacity-50">Mark for Yücel's review</button>
                  </form>}
                  {decisionQueue.items.filter((item) => item.request_id === currentRequest.id && item.recorded_at).slice(0,3).map((item) =>
                    <p key={item.id} className="mt-3 rounded-lg bg-white p-2 text-sm"><strong>Decision recorded {date(item.recorded_at)}:</strong> {item.decision}</p>)}
                </div>}
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
