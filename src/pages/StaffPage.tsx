import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { createClient, type Session } from "@supabase/supabase-js";
import StaffFormErrors from "../components/StaffFormErrors";
import StaffEmailStatus from "../components/StaffEmailStatus";
import { safeCrmRequest, crmDisplayDate, crmLocalInput, crmTaskError, crmRequestError, validCrmOverview, validCrmTasks, validCrmDecisions } from "../lib/crmUi";

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
  message: string | null; status: string; assigned_to: string | null;
  follow_up_at: string | null; created_at: string;
};
type Overview = { customers: Customer[]; requests: CateringRequest[] };
type Segment = "all" | "vip" | "catering" | "kevin" | "test";
type FollowUpTask = { id: string; title: string; assigned_to: string; due_at: string; completed_at: string | null };
type CateringDecision = {
  id: string; request_id: string; question: string; requested_at: string;
  decision: string | null; recorded_at: string | null;
  request_status: string; customer_name: string | null;
};
type DecisionQueue = { items: CateringDecision[] };
type DecisionEmailDraft = { decisionId: string; to: string; cc: string; subject: string; body: string };
type CateringNotification = { request_id: string; tracked: boolean; attempted_at: string | null; sent_at: string | null; error: string | null };

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
const client = url && key ? createClient(url, key) : null;
async function crmRpc(name: string, params?: Record<string, unknown>) {
  return safeCrmRequest(() => client ? client.rpc(name, params)
    : Promise.resolve({ data: null, error: { code: "MISSING_CONFIG" } }));
}
const statuses = ["new", "contacted", "quoted", "won", "lost", "closed"];
const activeStatuses = new Set(["new", "contacted", "quoted"]);
const segments: { value: Segment; label: string }[] = [
  { value: "all", label: "All customers" },
  { value: "vip", label: "VIP signups" },
  { value: "catering", label: "Catering" },
  { value: "kevin", label: "Kevin campaign" },
  { value: "test", label: "Internal tests" },
];

function date(value: string | null) {
  return crmDisplayDate(value);
}
function localInput(value: string | null) {
  return crmLocalInput(value);
}

function StaffPassword() {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!client || busy) return;
    if (password.length < 12) { setMessage("Use at least 12 characters."); return; }
    if (password !== confirmation) { setMessage("The passwords do not match."); return; }
    setBusy(true); setMessage("");
    try {
      const { error } = await client.auth.updateUser({ password });
      setMessage(error ? "Could not save your password. Sign in again and retry."
        : "Staff password saved. You can now sign in with your email and this password.");
    } catch { setMessage("Could not confirm the password change. Try signing in with the new password before retrying."); }
    finally { setPassword(""); setConfirmation(""); setBusy(false); }
  }
  return <details className="mb-5 rounded-lg border border-[#dfe7df] bg-white p-4">
    <summary className="cursor-pointer font-semibold text-green-800">Set or change your staff password</summary>
    <form onSubmit={save} className="mt-4 max-w-md space-y-3">
      <p className="text-sm text-stone-600">Choose a separate password for Nazar staff access. Do not use your email account password.</p>
      <label className="block text-sm font-medium">New staff password<input type="password" autoComplete="new-password" required minLength={12} value={password} onChange={(event) => setPassword(event.target.value)} className="mt-1 w-full rounded-lg border p-3" /></label>
      <label className="block text-sm font-medium">Confirm staff password<input type="password" autoComplete="new-password" required minLength={12} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} className="mt-1 w-full rounded-lg border p-3" /></label>
      <button disabled={busy} className="rounded-lg bg-green-800 px-4 py-2 font-semibold text-white disabled:opacity-50">{busy ? "Saving…" : "Save staff password"}</button>
      {message && <p role="status" className="text-sm">{message}</p>}
    </form>
  </details>;
}

export default function StaffPage({ variant = "followup" }: { variant?: "followup" | "crm" }) {
  const [session, setSession] = useState<Session | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [signInMethod, setSignInMethod] = useState<"password" | "link">("password");
  const [linkWait, setLinkWait] = useState(0);
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
  const [tasks, setTasks] = useState<{ customerId: string; items: FollowUpTask[]; unavailable?: boolean } | null>(null);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskOwner, setTaskOwner] = useState("");
  const [taskDue, setTaskDue] = useState("");
  const [decisionQueue, setDecisionQueue] = useState<DecisionQueue | null>(null);
  const [decisionQuestion, setDecisionQuestion] = useState("");
  const [decisionEmailDraft, setDecisionEmailDraft] = useState<DecisionEmailDraft | null>(null);
  const [notifications, setNotifications] = useState<CateringNotification[]>([]);
  const [notificationStatusAvailable, setNotificationStatusAvailable] = useState<boolean | null>(null);
  const refreshSequence = useRef(0);

  useEffect(() => {
    document.title = variant === "crm" ? "Nazar staff | CRM" : "Nazar staff | Customer follow-up";
    const robots = document.createElement("meta");
    robots.name = "robots";
    robots.content = "noindex,nofollow";
    document.head.appendChild(robots);
    if (!client) return () => robots.remove();
    void client.auth.getSession().then(({ data }) => setSession(data.session))
      .catch(() => setMessage("Could not check staff sign-in. Please reload."));
    const { data: listener } = client.auth.onAuthStateChange((_event, next) => {
      if (!next) {
        refreshSequence.current += 1;
        setOverview(null); setTasks(null); setDecisionQueue(null);
        setNotifications([]); setDecisionEmailDraft(null); setSelectedCustomer(null);
        setSelectedRequest(null); setBusy(false);
        setNote(""); setTaskTitle(""); setTaskOwner(""); setTaskDue("");
        setDecisionQuestion(""); setAssignee(""); setFollowUp(""); setStatus("new");
        setNotificationStatusAvailable(null); setMessage("");
      }
      setSession(next);
    });
    return () => { listener.subscription.unsubscribe(); robots.remove(); };
  }, [variant]);

  const refresh = useCallback(async (query = "", view: Segment = "all") => {
    if (!client || !session) return;
    const sequence = ++refreshSequence.current;
    setBusy(true); setMessage("");
    const [overviewResult, decisionsResult, notificationsResult] = await Promise.all([
      crmRpc("crm_overview_v2", { p_search: query, p_segment: view === "catering" ? "all" : view }),
      crmRpc("crm_catering_decisions_v1"),
      crmRpc("crm_catering_notification_status_v1"),
    ]);
    const { data, error } = overviewResult;
    if (sequence !== refreshSequence.current) return;
    if (error || !validCrmOverview(data)) {
      setOverview(null);
      setMessage(error?.code === "42501" ? "This account does not have Nazar staff access." : "Could not load records. Try again.");
      setDecisionQueue(null); setNotifications([]); setTasks(null);
      setDecisionEmailDraft(null); setBusy(false);
      return;
    } else {
      setOverview(data as Overview);
      setMessage("");
    }
    setDecisionQueue(!decisionsResult.error && validCrmDecisions(decisionsResult.data) ? decisionsResult.data as DecisionQueue : null);
    const validNotifications = Array.isArray(notificationsResult.data?.items)
      && notificationsResult.data.items.every((item: unknown) => !!item && typeof item === "object"
        && "request_id" in item && typeof item.request_id === "string");
    setNotifications(!notificationsResult.error && validNotifications ? notificationsResult.data.items as CateringNotification[] : []);
    setNotificationStatusAvailable(!notificationsResult.error && validNotifications);
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
      void crmRpc("crm_catering_decisions_v1").then(({ data, error }) => {
        if (!error && validCrmDecisions(data)) setDecisionQueue(data as DecisionQueue);
      });
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [session]);

  useEffect(() => {
    if (linkWait <= 0) return;
    const timer = window.setTimeout(() => setLinkWait((seconds) => Math.max(0, seconds - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [linkWait]);

  async function signIn(event: FormEvent) {
    if (signInMethod === "link") { await sendLink(event); return; }
    event.preventDefault();
    if (!client || busy) return;
    setBusy(true); setMessage("");
    try {
      const { error } = await client.auth.signInWithPassword({ email: email.trim(), password });
      setMessage(error?.status === 429
        ? "Too many sign-in attempts. Please try again later."
        : error ? "Could not sign in. Check your email and password." : "");
    } catch { setMessage("Could not sign in. Please try again."); }
    finally { setPassword(""); setBusy(false); }
  }

  async function sendLink(event: FormEvent) {
    event.preventDefault();
    if (!client || busy || linkWait > 0) return;
    setBusy(true); setMessage("");
    setLinkWait(60);
    try {
    const { error } = await client.auth.signInWithOtp({
      email: email.trim(), options: { shouldCreateUser: false, emailRedirectTo: `${window.location.origin}${variant === "crm" ? "/staff/crm" : "/staff"}` },
    });
    setMessage(error?.status === 429
      ? "Sign-in email limit reached. Use your password if already set up, or try again later. The email service may require a longer wait."
      : error
        ? "Could not send the sign-in link. Check that this address was invited, then try again."
        : "Check your email for the sign-in link.");
    } catch { setMessage("Could not send the sign-in link. Please try again."); }
    finally { setBusy(false); }
  }

  const currentCustomer = overview?.customers.find((c) => c.id === selectedCustomer);
  const currentRequest = overview?.requests.find((r) => r.id === selectedRequest);
  const pendingDecision = decisionQueue?.items.find((item) =>
    item.request_id === selectedRequest && !item.recorded_at);
  const notificationByRequest = new Map(notifications.map((item) => [item.request_id, item]));
  const unsentNotificationCount = notifications.filter((item) => item.tracked && !item.sent_at).length;

  useEffect(() => {
    const customerId = currentCustomer?.id;
    if (!client || !session || !customerId) return;
    let active = true;
    queueMicrotask(() => setTasks(null));
    void crmRpc("crm_customer_tasks_v1", { p_customer_id: customerId })
      .then(({ data, error }) => {
        if (!active) return;
        const unavailable = !!error || !validCrmTasks(data);
        setTasks({ customerId, items: unavailable ? [] : data as FollowUpTask[], unavailable });
        if (unavailable) setMessage("Could not load follow-up tasks. Try refreshing records.");
      });
    return () => { active = false; };
  }, [currentCustomer?.id, session, overview]);

  async function createTask(event: FormEvent) {
    event.preventDefault();
    if (!client || !currentCustomer || busy) return;
    const validation = crmTaskError(taskTitle, taskOwner, taskDue);
    if (validation) { setMessage(validation); return; }
    setBusy(true); setMessage("");
    const { data, error } = await crmRpc("crm_create_task_v1", {
      p_customer_id: currentCustomer.id, p_title: taskTitle.trim(),
      p_assigned_to: taskOwner.trim(), p_due_at: new Date(taskDue).toISOString(),
    });
    if (error || typeof data !== "string" || !data) setMessage("Could not confirm the task save. Refresh records before retrying.");
    else {
      const result = await crmRpc("crm_customer_tasks_v1", { p_customer_id: currentCustomer.id });
      const unavailable = !!result.error || !validCrmTasks(result.data);
      setTasks({ customerId: currentCustomer.id, items: unavailable ? [] : result.data as FollowUpTask[], unavailable });
      setTaskTitle(""); setTaskDue(""); setMessage(unavailable ? "Task saved, but the updated list could not be loaded. Refresh records before adding it again." : "Follow-up task saved.");
    }
    setBusy(false);
  }

  async function completeTask(taskId: string) {
    if (!client || !currentCustomer) return;
    setBusy(true); setMessage("");
    const { data, error } = await crmRpc("crm_complete_task_v1", { p_task_id: taskId });
    if (error || !data) setMessage("Could not complete the task.");
    else {
      setTasks((previous) => previous?.customerId === currentCustomer.id
        ? { ...previous, items: previous.items.map((task) => task.id === taskId
          ? { ...task, completed_at: new Date().toISOString() } : task) } : previous);
      setMessage("Task completed.");
    }
    setBusy(false);
  }

  function chooseRequest(request: CateringRequest) {
    setSelectedRequest(request.id);
    setStatus(request.status);
    setAssignee(request.assigned_to ?? "");
    setFollowUp(localInput(request.follow_up_at));
    setMessage("");
    setDecisionQuestion("");
  }

  async function requestDecision(event: FormEvent) {
    event.preventDefault();
    if (!client || !currentRequest || busy) return;
    if (!decisionQuestion.trim() || decisionQuestion.trim().length > 1000) {
      setMessage("Enter a decision question between 1 and 1000 characters."); return;
    }
    setBusy(true); setMessage("");
    const { error } = await crmRpc("crm_request_catering_decision_v1", {
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
      if (!draft || ![draft.to, draft.cc, draft.subject, draft.body].every(value => typeof value === "string")) throw new Error("Invalid draft");
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
    if (!client || !currentRequest || busy) return;
    const validation = crmRequestError(status, assignee, followUp);
    if (validation) { setMessage(validation); return; }
    setBusy(true); setMessage("");
    const { data, error } = await crmRpc("crm_update_catering", {
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
    if (!client || !currentCustomer || busy) return;
    if (!note.trim() || note.trim().length > 2000) {
      setMessage("Enter a note between 1 and 2000 characters."); return;
    }
    setBusy(true); setMessage("");
    const { data, error } = await crmRpc("crm_add_note", {
      p_customer_id: currentCustomer.id, p_body: note.trim(),
    });
    if (error || !data) setMessage("Could not confirm the note save. Refresh records before retrying.");
    else { setNote(""); await refresh(search, segment); setMessage("Note saved."); }
    setBusy(false);
  }

  if (variant === "crm" && session) {
    const visibleCustomers = segment === "catering"
      ? (overview?.customers ?? []).filter((customer) => overview?.requests.some((request) => request.customer_id === customer.id))
      : overview?.customers ?? [];
    const visibleRequests = segment === "vip" || segment === "kevin" ? [] : overview?.requests ?? [];
    const openTasks = tasks && !tasks.unavailable && currentCustomer && tasks.customerId === currentCustomer.id
      ? tasks.items.filter((task) => !task.completed_at).length : null;

    return <main className="min-h-screen bg-[#f6f7f4] text-[#17231b]">
      <header className="border-b border-[#dfe7df] bg-white px-4 py-4 sm:px-6">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3"><span className="grid h-9 w-9 place-items-center rounded-lg bg-[#176b3a] text-xl font-black text-white">N</span><strong>NAZAR STAFF</strong><span className="text-[#64736a]">/ CRM</span></div>
          <div className="flex items-center gap-3"><a href="/staff" className="text-sm font-medium text-[#176b3a] underline">Customer follow-up</a><button type="button" onClick={() => { void client?.auth.signOut(); setOverview(null); }} className="rounded-lg border border-[#dfe7df] px-3 py-2 text-sm">Sign out</button></div>
        </div>
      </header>
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        <div className="mb-5"><h1 className="text-2xl font-bold sm:text-3xl">Customer relationships</h1><p className="text-sm text-[#64736a]">VIP, catering and staff follow-up in one private view</p></div>
        {overview && <StaffPassword />}
        {overview && client && <StaffFormErrors key={session.user.id} client={client} />}
        <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[
            ["Customers shown", overview?.customers.length ?? "—"],
            ["VIP signups shown", overview?.customers.filter((customer) => customer.vip_signup_count > 0).length ?? "—"],
            ["Open catering shown", overview?.requests.filter((request) => activeStatuses.has(request.status)).length ?? "—"],
            ["Kevin records shown", overview?.customers.filter((customer) => customer.kevin_signup_count > 0).length ?? "—"],
          ].map(([label, value]) => <div key={label} className="rounded-xl border border-[#dfe7df] bg-white p-4"><span className="text-xs text-[#64736a]">{label}</span><strong className="mt-1 block text-2xl">{value}</strong></div>)}
        </div>
        <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
          <section className="rounded-xl border border-[#dfe7df] bg-white p-4" aria-label="Customer list">
            <h2 className="mb-3 text-lg font-semibold">Customers</h2>
            <form onSubmit={(event) => { event.preventDefault(); void refresh(search, segment); }} className="mb-3 flex gap-2">
              <input aria-label="Search customers" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search name, email or phone" className="min-w-0 flex-1 rounded-lg border border-[#dfe7df] bg-[#f6f7f4] p-3 text-sm" />
              <button disabled={busy} className="rounded-lg bg-[#176b3a] px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">Search</button>
            </form>
            <div className="mb-3 flex flex-wrap gap-1" role="group" aria-label="Customer filters">{segments.map((item) => <button key={item.value} type="button" aria-pressed={segment === item.value} onClick={() => { setSegment(item.value); setSelectedCustomer(null); setSelectedRequest(null); void refresh(search, item.value); }} className={`rounded-lg border px-2.5 py-2 text-sm ${segment === item.value ? "border-[#176b3a] bg-[#176b3a] text-white" : "border-[#dfe7df] bg-white"}`}>{item.value === "all" ? "All" : item.value === "test" ? "Internal tests" : item.label.replace(" signups", "")}</button>)}</div>
            <button type="button" disabled={busy} onClick={() => void refresh(search, segment)} className="mb-3 text-xs font-medium text-[#176b3a] underline disabled:opacity-50">Refresh records</button>
            <div className="max-h-[36rem] space-y-2 overflow-auto">{visibleCustomers.map((customer) => <button key={customer.id} type="button" onClick={() => { setSelectedCustomer(customer.id); setSelectedRequest(null); setNote(""); setMessage(""); }} className={`w-full rounded-lg border p-3 text-left ${currentCustomer?.id === customer.id ? "border-[#176b3a] bg-[#eaf6ee]" : "border-[#dfe7df] bg-white hover:bg-[#f6f7f4]"}`}><strong className="block">{customer.name || "Unnamed customer"}</strong><span className="block text-xs text-[#64736a]">{[customer.vip_signup_count > 0 && "VIP", overview?.requests.some((request) => request.customer_id === customer.id) && "Catering", customer.kevin_signup_count > 0 && "Kevin"].filter(Boolean).join(" · ") || "Website contact"}</span><span className="block break-all text-xs text-[#64736a]">{customer.email || customer.phone || "No contact shown"}</span></button>)}{overview && visibleCustomers.length === 0 && <p className="text-sm text-[#64736a]">No matching customers.</p>}{!overview && <p className="text-sm text-[#64736a]">{busy ? "Loading customers…" : "Customer records unavailable. Refresh records to retry."}</p>}</div>
          </section>
          {currentCustomer ? <section className="rounded-xl border border-[#dfe7df] bg-white p-4 sm:p-5" aria-label="Customer profile">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#dfe7df] pb-4"><div><h2 className="text-xl font-bold">{currentCustomer.name || "Unnamed customer"}</h2><p className="break-all text-sm text-[#64736a]">{currentCustomer.email || "No email"} · {currentCustomer.phone || "No phone"}</p></div><span className="rounded-lg bg-[#eaf6ee] px-3 py-2 text-sm font-semibold text-[#176b3a]">{tasks?.customerId === currentCustomer.id && tasks.unavailable ? "Tasks unavailable" : openTasks === null ? "Loading tasks" : `${openTasks} open follow-up${openTasks === 1 ? "" : "s"}`}</span></div>
            <div className="my-4 grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg bg-[#f6f7f4] p-3"><span className="text-xs text-[#64736a]">Relationship</span><strong className="mt-1 block">{[currentCustomer.vip_signup_count > 0 && "VIP", overview?.requests.some((request) => request.customer_id === currentCustomer.id) && "Catering"].filter(Boolean).join(" · ") || "Website contact"}</strong></div>
              <StaffEmailStatus key={`${currentCustomer.id}:${currentCustomer.email}`} customerId={currentCustomer.id} email={currentCustomer.email} accessToken={session.access_token} localStatus={currentCustomer.email_status} />
              <div className="rounded-lg bg-[#f6f7f4] p-3"><span className="text-xs text-[#64736a]">Source</span><strong className="mt-1 block">{currentCustomer.last_source || "Not recorded"}</strong>{currentCustomer.kevin_signup_count > 0 && <span className="block text-xs text-[#64736a]">Kevin campaign: {currentCustomer.kevin_signup_count} signup(s)</span>}</div>
              <div className="rounded-lg bg-[#f6f7f4] p-3"><span className="text-xs text-[#64736a]">Order history</span><strong className="mt-1 block">Not linked yet</strong><span className="text-xs text-[#64736a]">A form submission is not a paid order.</span></div>
            </div>
            <div className="grid gap-5 md:grid-cols-[1.1fr_.9fr]"><div><h3 className="mb-2 font-semibold">Customer history</h3>{currentCustomer.recent_signups.map((signup) => <div key={signup.id} className="border-t border-[#dfe7df] py-2"><strong className="block text-sm">{date(signup.created_at)} · {signup.source === "website_vip_page" ? "VIP form" : signup.source}</strong><span className="text-xs text-[#64736a]">{signup.campaign ? `Campaign: ${signup.campaign}` : "Website signup"}</span></div>)}{overview?.requests.filter((request) => request.customer_id === currentCustomer.id).map((request) => <button key={request.id} type="button" onClick={() => chooseRequest(request)} className="block w-full border-t border-[#dfe7df] py-2 text-left"><strong className="block text-sm">{date(request.created_at)} · Catering request</strong><span className="text-xs text-[#64736a]">{request.status} · Event {request.event_date || "date not set"}</span></button>)}{currentCustomer.recent_signups.length === 0 && !overview?.requests.some((request) => request.customer_id === currentCustomer.id) && <p className="text-sm text-[#64736a]">No history in the current results.</p>}</div>
              <div><h3 className="mb-2 font-semibold">Staff follow-up</h3>{tasks?.customerId === currentCustomer.id && !tasks.unavailable ? <div className="space-y-2">{tasks.items.map((task) => <div key={task.id} className="rounded-lg bg-amber-50 p-3 text-sm"><strong className="block">{task.title}</strong><span className="text-xs text-[#64736a]">{task.assigned_to} · Due {date(task.due_at)} · {task.completed_at ? "Completed" : "Open"}</span>{!task.completed_at && <button type="button" disabled={busy} onClick={() => void completeTask(task.id)} className="ml-2 text-xs text-[#176b3a] underline">Mark done</button>}</div>)}{tasks.items.length === 0 && <p className="text-sm text-[#64736a]">No follow-up task yet.</p>}</div> : <p className="text-sm text-[#64736a]">{tasks?.unavailable ? "Tasks unavailable. Refresh records to retry." : "Loading tasks…"}</p>}
                <form onSubmit={createTask} className="mt-3 space-y-2 rounded-lg border border-[#dfe7df] p-3"><input aria-label="Follow-up task" required maxLength={300} value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} placeholder="Follow-up task" className="w-full rounded-lg border p-2 text-sm" /><input aria-label="Assigned to" required maxLength={100} value={taskOwner} onChange={(event) => setTaskOwner(event.target.value)} placeholder="Assigned to" className="w-full rounded-lg border p-2 text-sm" /><input aria-label="Due time" required type="datetime-local" value={taskDue} onChange={(event) => setTaskDue(event.target.value)} className="w-full rounded-lg border p-2 text-sm" /><button disabled={busy} className="rounded-lg bg-[#176b3a] px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">Add follow-up</button></form>
                <h3 className="mb-2 mt-5 font-semibold">Internal notes</h3>{currentCustomer.notes.map((item) => <p key={item.id} className="border-t border-[#dfe7df] py-2 text-sm">{item.body}<span className="block text-xs text-[#64736a]">{date(item.created_at)}</span></p>)}<form onSubmit={addNote} className="mt-2 flex gap-2"><input aria-label="New internal note" maxLength={2000} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Add a note" className="min-w-0 flex-1 rounded-lg border border-[#dfe7df] p-2 text-sm" /><button disabled={busy || !note.trim()} className="rounded-lg bg-[#176b3a] px-3 py-2 text-sm text-white disabled:opacity-50">Add</button></form>
              </div></div>
          </section> : <section className="rounded-xl border border-[#dfe7df] bg-white p-5" aria-label="Customer profile">Select a customer to see their profile, VIP status and follow-up history.</section>}
        </div>
        <section className="mt-5 rounded-xl border border-[#dfe7df] bg-white p-4 sm:p-5" aria-label="Catering requests"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-lg font-semibold">Catering requests <span className="text-sm font-normal text-[#64736a]">({visibleRequests.length} shown)</span></h2>{notificationStatusAvailable && unsentNotificationCount > 0 && <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-950">{unsentNotificationCount} staff alert(s) not sent</span>}</div>
          <div className="mt-3 grid gap-2 md:grid-cols-2">{visibleRequests.map((request) => <button key={request.id} type="button" onClick={() => chooseRequest(request)} className={`rounded-lg border p-3 text-left text-sm ${currentRequest?.id === request.id ? "border-[#176b3a] bg-[#eaf6ee]" : "border-[#dfe7df]"}`}><strong className="block">{request.name || "Unnamed customer"} <span className="font-normal text-[#64736a]">· {request.status}</span></strong><span className="block text-xs text-[#64736a]">Event {request.event_date || "not set"} · Follow-up {date(request.follow_up_at)}</span><span className="block text-xs text-[#64736a]">Staff alert: {notificationByRequest.get(request.id)?.sent_at ? "sent" : notificationByRequest.get(request.id)?.tracked ? "not sent" : "not tracked"}</span></button>)}{overview && visibleRequests.length === 0 && <p className="text-sm text-[#64736a]">No matching catering requests.</p>}</div>
          {currentRequest && <div className="mt-4 border-t border-[#dfe7df] pt-4"><h3 className="font-semibold">{currentRequest.name || "Unnamed customer"}</h3><p className="text-sm text-[#64736a]">{currentRequest.email || "No email"} · {currentRequest.phone || "No phone"} · Event {currentRequest.event_date || "—"} · Guests {currentRequest.guests || "—"}</p><p className="mt-3 whitespace-pre-wrap rounded-lg bg-[#f6f7f4] p-3 text-sm">{currentRequest.message || "No message"}</p><p className="mt-2 text-xs text-[#64736a]">Staff notification: {notificationByRequest.get(currentRequest.id)?.sent_at ? `sent ${date(notificationByRequest.get(currentRequest.id)?.sent_at ?? null)}` : notificationByRequest.get(currentRequest.id)?.tracked ? "not sent" : "not tracked"}</p>
            <form onSubmit={saveRequest} className="mt-4 grid gap-3 sm:grid-cols-2"><label className="text-sm">Status<select value={status} onChange={(event) => setStatus(event.target.value)} className="mt-1 w-full rounded-lg border p-2">{statuses.map((value) => <option key={value}>{value}</option>)}</select></label><label className="text-sm">Assigned to<input required maxLength={100} value={assignee} onChange={(event) => setAssignee(event.target.value)} className="mt-1 w-full rounded-lg border p-2" /></label><label className="text-sm">Next follow-up<input type="datetime-local" value={followUp} onChange={(event) => setFollowUp(event.target.value)} className="mt-1 w-full rounded-lg border p-2" /></label><div className="flex items-end"><button disabled={busy} className="rounded-lg bg-[#176b3a] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Save request</button></div></form>
            {decisionQueue && <div className="mt-4 rounded-lg bg-amber-50 p-3"><h4 className="font-semibold">Price and menu decision</h4>{pendingDecision ? <p className="mt-1 text-sm">Awaiting Yücel: {pendingDecision.question}</p> : <form onSubmit={requestDecision} className="mt-2 flex flex-wrap gap-2"><input aria-label="Decision needed" required maxLength={1000} value={decisionQuestion} onChange={(event) => setDecisionQuestion(event.target.value)} placeholder="What decision is needed?" className="min-w-48 flex-1 rounded-lg border p-2 text-sm" /><button disabled={busy} className="rounded-lg bg-amber-700 px-3 py-2 text-sm text-white">Mark for Yücel</button></form>}{decisionQueue.items.filter((item) => item.request_id === currentRequest.id && item.recorded_at).slice(0, 3).map((item) => <p key={item.id} className="mt-2 text-sm">Decision recorded {date(item.recorded_at)}: {item.decision}</p>)}</div>}
          </div>}
        </section>
        {decisionQueue && decisionQueue.items.some((item) => !item.recorded_at) && <section className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4" aria-label="Price and menu decisions"><h2 className="font-semibold">Price and menu decisions awaiting Yücel</h2><p className="mt-1 text-xs text-[#64736a]">Preparing an email does not send it or record a decision.</p>{decisionQueue.items.filter((item) => !item.recorded_at).map((item) => <div key={item.id} className="mt-2 rounded-lg border bg-white p-3 text-sm"><strong>{item.customer_name || "Catering customer"}</strong> · {item.question}<button type="button" disabled={busy} onClick={() => void prepareDecisionEmail(item.id)} className="ml-3 text-[#176b3a] underline">Prepare email</button></div>)}{decisionEmailDraft && <div className="mt-3 rounded-lg border bg-white p-3 text-sm"><p><strong>To:</strong> {decisionEmailDraft.to} · <strong>Cc:</strong> {decisionEmailDraft.cc}</p><p><strong>Subject:</strong> {decisionEmailDraft.subject}</p><pre className="mt-2 whitespace-pre-wrap font-sans">{decisionEmailDraft.body}</pre><a href={decisionMailto(decisionEmailDraft)} className="mt-2 inline-block rounded-lg bg-[#176b3a] px-3 py-2 text-white">Open in email app</a></div>}</section>}
        {message && <p role="status" className="mt-5 rounded-lg bg-amber-50 p-3 text-sm">{message}</p>}
        <p className="mt-5 text-xs text-[#64736a]">Private staff workspace. Customer information must not be shared outside Nazar. Counts cover records returned by the current search.</p>
      </div>
    </main>;
  }

  return <main className="min-h-screen bg-[#f6f7f4] px-4 py-8 text-stone-900">
    <div className="mx-auto max-w-7xl">
      <header className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <div><p className="text-xs font-bold uppercase tracking-widest text-green-800">Nazar staff</p><h1 className="text-3xl font-bold">{variant === "crm" ? "CRM sign-in" : "Customer follow-up"}</h1></div>
        {session && <a href="/staff/crm" className="rounded-lg border border-green-800 px-4 py-2 font-semibold text-green-800">Open CRM</a>}
        {session && <button className="rounded-lg border px-4 py-2" onClick={() => { void client?.auth.signOut(); setOverview(null); }}>Sign out</button>}
      </header>
      {!client ? <p>Staff access is not configured.</p> : !session ?
        <form onSubmit={signIn} className="max-w-md space-y-4 rounded-2xl border bg-white p-6 shadow-sm">
          <h2 className="text-xl font-semibold">Staff sign-in</h2>
          <p className="text-sm text-stone-600">Use the email address invited by Nazar’s owner.</p>
          <div className="flex gap-4" aria-label="Sign-in method">
            <button type="button" disabled={busy} aria-pressed={signInMethod === "password"} onClick={() => { setSignInMethod("password"); setMessage(""); }} className="text-sm font-semibold underline">Email and password</button>
            <button type="button" disabled={busy} aria-pressed={signInMethod === "link"} onClick={() => { setSignInMethod("link"); setPassword(""); setMessage(""); }} className="text-sm font-semibold underline">Email link</button>
          </div>
          <label className="block text-sm font-medium">Email<input className="mt-1 w-full rounded-lg border p-3" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          {signInMethod === "password" && <><label className="block text-sm font-medium">Password<input className="mt-1 w-full rounded-lg border p-3" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label><p className="text-sm text-stone-600">Use your Nazar staff password. Your Google or email account password does not apply. If you have not set a staff password, use an email link.</p></>}
          <button disabled={busy || (signInMethod === "link" && linkWait > 0)} className="rounded-lg bg-green-800 px-5 py-3 font-semibold text-white disabled:opacity-50">{busy ? "Please wait…" : signInMethod === "password" ? "Sign in" : linkWait > 0 ? `Wait ${linkWait}s before requesting again` : "Send sign-in link"}</button>
        </form> : <>
          {overview && <StaffPassword />}
          {overview && client && <StaffFormErrors key={session.user.id} client={client} />}
          <form onSubmit={(e) => { e.preventDefault(); void refresh(search, segment); }} className="mb-3 flex flex-wrap gap-2">
            <input aria-label="Search customers" placeholder="Search name, email or phone" value={search} onChange={(e) => setSearch(e.target.value)} className="min-w-64 flex-1 rounded-lg border bg-white p-3" />
            <button disabled={busy} className="rounded-lg bg-green-800 px-5 py-3 font-semibold text-white disabled:opacity-50">Search</button>
            <button type="button" disabled={busy} onClick={() => void refresh(search, segment)} className="rounded-lg border bg-white px-5 py-3">Refresh</button>
          </form>
          <nav aria-label="Customer groups" className="mb-5 flex flex-wrap gap-2">
            {segments.filter((item) => item.value !== "catering").map((item) => <button key={item.value} type="button" aria-pressed={segment === item.value}
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
          {unsentNotificationCount > 0 && <div className="mb-5 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm" role="status">
            {unsentNotificationCount} catering staff notification{unsentNotificationCount === 1 ? "" : "s"} not confirmed. Review new catering requests here during the daily check.
          </div>}
          {notificationStatusAvailable === false && <div className="mb-5 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm" role="alert">
            Staff notification status is unavailable. Review all new catering requests in CRM today.
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
                  <StaffEmailStatus key={`${currentCustomer.id}:${currentCustomer.email}`} customerId={currentCustomer.id} email={currentCustomer.email} accessToken={session.access_token} localStatus={currentCustomer.email_status} />
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
                {tasks?.customerId === currentCustomer.id && !tasks.unavailable ? <div className="mt-2 space-y-2">{tasks.items.map((task) => <div key={task.id} className="rounded-lg border p-3 text-sm">
                  <strong className="block">{task.title}</strong><span className="text-stone-600">{task.assigned_to} · Due {date(task.due_at)} · {task.completed_at ? "Completed" : "Open"}</span>
                  {!task.completed_at && <button type="button" disabled={busy} onClick={() => void completeTask(task.id)} className="ml-2 underline disabled:opacity-50">Mark done</button>}
                </div>)}{!tasks.items.length && <p className="text-sm text-stone-500">No follow-up task yet.</p>}</div> : <p className="text-sm text-stone-500">{tasks?.unavailable ? "Tasks unavailable. Refresh records to retry." : "Loading follow-up tasks…"}</p>}
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
                  {notificationByRequest.get(r.id)?.tracked && <span className={`ml-2 rounded-full px-2 py-1 text-xs ${notificationByRequest.get(r.id)?.sent_at ? "bg-green-50 text-green-800" : "bg-amber-100 text-amber-900"}`}>
                    {notificationByRequest.get(r.id)?.sent_at ? "Staff notified" : "Notification pending"}
                  </span>}
                  <span className="block text-sm text-stone-600">Follow up: {date(r.follow_up_at)} · {r.assigned_to}</span>
                </button>)}
                {!overview.requests.length && <p className="text-sm text-stone-500">No matching requests.</p>}
              </div>
              {currentRequest && <div className="mt-5 border-t pt-4">
                <h3 className="font-semibold">{currentRequest.name || "Unnamed customer"}</h3>
                <p className="text-sm">{currentRequest.email || "—"} · {currentRequest.phone || "—"}</p>
                <p className="mt-1 text-sm">Event: {currentRequest.event_date || "—"} · Guests: {currentRequest.guests || "—"}</p>
                {notificationByRequest.get(currentRequest.id)?.tracked && <p className="mt-1 text-sm">
                  Staff notification: {notificationByRequest.get(currentRequest.id)?.sent_at
                    ? `sent ${date(notificationByRequest.get(currentRequest.id)?.sent_at || null)}`
                    : notificationByRequest.get(currentRequest.id)?.error ? "not sent — review during daily check" : "pending"}
                </p>}
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
