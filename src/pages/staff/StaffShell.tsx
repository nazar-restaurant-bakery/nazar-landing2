import { useCallback, useEffect, useRef, useState } from "react";
import { NavLink, Navigate, useLocation, useNavigate } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { crmData, staffClient, type Overview, type CateringDecision, type CateringNotification, type TaskState, type EmailState, type Offer, type FormErrors } from "../../lib/crmData";
import { validCrmOverview, validCrmTasks, validCrmDecisions } from "../../lib/crmUi";
import { validCrmQueue, type CrmQueue, type CrmQueueName } from "../../lib/crmQueue";
import { validEmailStatusResult, type EmailStatusResult } from "../../lib/crmEmailStatus";
import { staffCopy as c } from "../../lib/staffCopy";
import { mergeOverview, staffDateInput, staffInputIso, staffRequestError, staffTaskError } from "../../lib/staffUi";
import CustomersView from "./CustomersView";
import CateringView from "./CateringView";
import TasksView from "./TasksView";
import StaffOffersPanel from "../../components/StaffOffersPanel";
import ProfileSyncPanel from "../../components/staff/ProfileSyncPanel";
import CloverOrdersPanel from "../../components/CloverOrdersPanel";
import CloverOrderPullPanel from "../../components/CloverOrderPullPanel";
import { browserDeployment } from "../../lib/supabase";
import SystemView from "./SystemView";
import OpsController from "./OpsController";
import CouponCheckout from "./CouponCheckout";
import StaffManagement from "./StaffManagement";
import StaffManagementLink from "../../components/staff/StaffManagementLink";
import StaffSignIn, { StaffPassword } from "./StaffSignIn";
import SiteOrderTickets from "../../components/staff/ops/SiteOrderTickets";
import { visibleStaffTab } from "../../lib/staffVisibility";
import "./staff.css";

type Phase = "checking" | "allowed" | "denied" | "unavailable";
type Readback = { kind: "overview" | "queue" | "errors" | "decisions" } | { kind: "tasks"; customerId: string };
function denied(result: { error: unknown }) {
  const error = result.error as { code?: string; status?: number } | null;
  return error?.code === "42501" || error?.code === "403" || error?.status === 403;
}
function validErrors(value: unknown): value is FormErrors {
  if (!value || typeof value !== "object") return false;
  const list = value as FormErrors;
  return Number.isSafeInteger(list.total_open) && list.total_open >= 0 && Array.isArray(list.items) && list.items.length <= 50 && list.total_open >= list.items.length && list.items.every(item => item && typeof item.id === "string" && typeof item.occurred_at === "string" && ["vip", "catering", "unknown"].includes(item.form_kind) && ["configuration", "challenge", "database"].includes(item.stage) && /^[a-z_]{1,60}$/.test(item.error_code) && item.http_status === 503 && ["not_requested", "suppressed", "claimed", "accepted", "failed"].includes(item.alert_status));
}
function validNotifications(value: unknown): value is { items: CateringNotification[] } {
  const items = (value as { items?: CateringNotification[] } | null)?.items;
  return Array.isArray(items) && items.every(item => item && typeof item.request_id === "string" && typeof item.tracked === "boolean" && [item.attempted_at, item.sent_at, item.error].every(v => v === null || typeof v === "string"));
}
function validOffers(value: unknown): value is Offer[] {
  return Array.isArray(value) && value.every(item => item && typeof item.id === "string" && typeof item.name === "string" && [item.description, item.code, item.channel_target, item.starts_at, item.ends_at].every(v => v === null || typeof v === "string"));
}

export default function StaffShell() {
  const navigate = useNavigate(); const location = useLocation();
  const [session, setSession] = useState<Session | null>(null);
  const [sessionReady, setSessionReady] = useState(false);
  const [staffScopeRevision, setStaffScopeRevision] = useState(0);
  const [platformView, setPlatformView] = useState<"checking" | "restaurant" | "platform" | "unavailable">("checking");
  const [phase, setPhase] = useState<Phase>("checking");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [includeTests, setIncludeTests] = useState(false);
  const [selectedCustomer, setSelectedCustomer] = useState<string | null>(null);
  const [selectedRequest, setSelectedRequest] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<CateringDecision[] | null>(null);
  const [notifications, setNotifications] = useState<CateringNotification[] | null>(null);
  const [, setOffers] = useState<Offer[] | null>(null);
  const [errors, setErrors] = useState<FormErrors | null>(null);
  const [tasks, setTasks] = useState<Record<string, TaskState>>({});
  const [tasksLoading, setTasksLoading] = useState(false);
  const [emailStates, setEmailStates] = useState<Record<string, EmailState>>({});
  const [queue, setQueue] = useState<CrmQueueName>("open_tasks");
  const [offset, setOffset] = useState(0); const [queueOwner, setQueueOwner] = useState("");
  const [queueData, setQueueData] = useState<CrmQueue | null>(null);
  const [reading, setReading] = useState(false); const [writing, setWriting] = useState(false);
  const [writeBlocked, setWriteBlocked] = useState(false);
  const [message, setMessage] = useState(""); const [revision, setRevision] = useState(0);
  const epoch = useRef(0); const taskEpoch = useRef(0); const emailEpoch = useRef(0);
  const alive = useRef(true); const writePending = useRef(false); const refreshPending = useRef(false);
  const authIdentity = useRef(""); const locallySignedOut = useRef(false);
  const emailController = useRef<AbortController | null>(null);
  const uncertainWrite = useRef<Readback | null>(null);
  const reconciledTasks = useRef<{ customerId: string; epoch: number } | null>(null);

  const clearPrivate = useCallback(() => {
    epoch.current++; taskEpoch.current++; emailEpoch.current++; emailController.current?.abort();
    setOverview(null); setTasks({}); setTasksLoading(false); setEmailStates({}); setDecisions(null); setNotifications(null);
    setOffers(null); setErrors(null); setQueueData(null); setSelectedCustomer(null); setSelectedRequest(null);
    setQueueOwner(""); setWriting(false); setWriteBlocked(false); setReading(false); setMessage("");
    writePending.current = false; refreshPending.current = false;
    uncertainWrite.current = null;
    reconciledTasks.current = null;
  }, []);

  useEffect(() => {
    alive.current = true;
    document.title = `Nazar Staff · ${c.workspace}`;
    const robots = document.createElement("meta"); robots.name = "robots"; robots.content = "noindex,nofollow"; document.head.appendChild(robots);
    let authEventSeen = false;
    function accept(next: Session | null) {
      if (!alive.current || (locallySignedOut.current && next)) return;
      const id = next?.user.id || "";
      if (id !== authIdentity.current) { clearPrivate(); authIdentity.current = id; setPhase("checking"); setIncludeTests(false); }
      setSession(next); setSessionReady(true);
    }
    if (!staffClient) { setSessionReady(true); return () => { alive.current = false; robots.remove(); }; }
    const { data: listener } = staffClient.auth.onAuthStateChange((_event, next) => { authEventSeen = true; accept(next); });
    void staffClient.auth.getSession().then(({ data }) => { if (!authEventSeen) accept(data.session); }).catch(() => { if (alive.current) { setSessionReady(true); setMessage(c.loginNetwork); } });
    // This is a mutable request generation, not a captured DOM ref.
    return () => { alive.current = false; epoch.current++; emailController.current?.abort(); listener.subscription.unsubscribe(); robots.remove(); }; // eslint-disable-line react-hooks/exhaustive-deps
  }, [clearPrivate]);

  useEffect(() => {
    let active = true;
    setPlatformView("checking");
    if (!session || !staffClient || !browserDeployment.businessId) return () => { active = false; };
    void staffClient.rpc("staff_business_authorized_v1", {
      p_business_id: null, p_operation: "platform.read",
    }).then(result => {
      if (active) {
        setPlatformView(result.error || typeof result.data !== "boolean"
          ? "unavailable" : result.data ? "platform" : "restaurant");
        if (!result.error && result.data === false) setIncludeTests(false);
      }
    }, () => { if (active) setPlatformView("unavailable"); });
    return () => { active = false; };
  }, [session, staffScopeRevision]);

  const refresh = useCallback(async (manual = false) => {
    if (!staffClient || !session || writePending.current || refreshPending.current) return;
    refreshPending.current = true; const current = ++epoch.current; taskEpoch.current++; emailEpoch.current++; emailController.current?.abort();
    setReading(true); setMessage("");
    const authorized = await crmData.authorized();
    if (!alive.current || current !== epoch.current) return;
    if (authorized.error || authorized.data !== true) {
      clearPrivate(); setPhase(denied(authorized) || authorized.data === false ? "denied" : "unavailable"); return;
    }
    const readback = uncertainWrite.current;
    const results = await Promise.all([crmData.overview("all"), includeTests ? crmData.overview("test") : Promise.resolve(null), crmData.decisions(), crmData.notifications(), crmData.queue(queue, offset), crmData.errors(), crmData.offers(), readback?.kind === "tasks" ? crmData.tasks(readback.customerId) : Promise.resolve(null)]);
    if (!alive.current || current !== epoch.current) return;
    if (results.some(result => result && denied(result))) { clearPrivate(); setPhase("denied"); return; }
    const [base, test, decisionResult, notificationResult, queueResult, errorResult, offerResult, taskReadback] = results;
    const validBase = !base.error && validCrmOverview(base.data);
    const validTest = !includeTests || (test && !test.error && validCrmOverview(test.data));
    if (validBase && validTest) {
      const next = includeTests && test ? mergeOverview(base.data as Overview, test.data as Overview) : base.data as Overview;
      const requestIds = new Set(next.requests.map(request => request.id));
      setOverview(next);
      setSelectedCustomer(previous => previous && next.customers.some(customer => customer.id === previous) ? previous : null);
      setSelectedRequest(previous => previous && next.requests.some(request => request.id === previous) ? previous : null);
      setDecisions(!decisionResult.error && validCrmDecisions(decisionResult.data) ? (decisionResult.data.items as CateringDecision[]).filter(item => requestIds.has(item.request_id)) : null);
      setNotifications(!notificationResult.error && validNotifications(notificationResult.data) ? notificationResult.data.items.filter(item => requestIds.has(item.request_id)) : null);
      const relevantReadSucceeded = !readback || readback.kind === "overview"
        || (readback.kind === "tasks" && taskReadback && !taskReadback.error && validCrmTasks(taskReadback.data))
        || (readback.kind === "queue" && !queueResult.error && validCrmQueue(queueResult.data, queue, offset))
        || (readback.kind === "errors" && !errorResult.error && validErrors(errorResult.data))
        || (readback.kind === "decisions" && !decisionResult.error && validCrmDecisions(decisionResult.data));
      if (manual && relevantReadSucceeded) {
        if (readback?.kind === "tasks" && taskReadback && validCrmTasks(taskReadback.data)) {
          setTasks(previous => ({ ...previous, [readback.customerId]: { items: taskReadback.data, unavailable: false } }));
          reconciledTasks.current = { customerId: readback.customerId, epoch: current };
          setTasksLoading(false);
        }
        setWriteBlocked(false); uncertainWrite.current = null;
      }
      else if (manual && readback) setMessage(c.unknownSave);
    } else { setMessage(c.unavailable); setWriteBlocked(true); }
    const queueValid = !queueResult.error && validCrmQueue(queueResult.data, queue, offset);
    setQueueData(queueValid ? queueResult.data : null);
    setErrors(!errorResult.error && validErrors(errorResult.data) ? errorResult.data : null);
    setOffers(!offerResult.error && validOffers(offerResult.data) ? offerResult.data : null);
    setPhase("allowed"); setRevision(value => value + 1); setReading(false); refreshPending.current = false;
    if (queueValid && offset > 0 && offset >= queueResult.data.total) setOffset(queueResult.data.total === 0 ? 0 : Math.floor((queueResult.data.total - 1) / 25) * 25);
  }, [session, includeTests, queue, offset, clearPrivate]);

  useEffect(() => { if (session) queueMicrotask(() => { void refresh(); }); }, [session, refresh]);

  useEffect(() => {
    if (phase !== "allowed" || !session || !selectedCustomer || !overview?.customers.some(customer => customer.id === selectedCustomer)) return;
    if (reconciledTasks.current?.customerId === selectedCustomer && reconciledTasks.current.epoch === epoch.current) return;
    const current = ++taskEpoch.current; const readEpoch = epoch.current; const id = selectedCustomer;
    queueMicrotask(() => { if (alive.current && current === taskEpoch.current) setTasksLoading(true); });
    void crmData.tasks(id).then(result => {
      if (!alive.current || current !== taskEpoch.current || readEpoch !== epoch.current) return;
      if (denied(result)) { clearPrivate(); setPhase("denied"); return; }
      const unavailable = !!result.error || !validCrmTasks(result.data);
      setTasks(previous => ({ ...previous, [id]: { items: unavailable ? [] : result.data, unavailable } })); setTasksLoading(false);
    });
    return () => { taskEpoch.current++; }; // eslint-disable-line react-hooks/exhaustive-deps -- invalidate this request generation
  }, [selectedCustomer, phase, session, overview, revision, clearPrivate]);

  const refreshEmail = useCallback(async (id: string) => {
    const customer = overview?.customers.find(item => item.id === id);
    if (!session || phase !== "allowed" || !customer?.email) return;
    emailController.current?.abort(); const controller = new AbortController(); emailController.current = controller;
    const current = ++emailEpoch.current; const readEpoch = epoch.current;
    setEmailStates(previous => ({ ...previous, [id]: { loading: true, result: previous[id]?.result || null } }));
    const timer = window.setTimeout(() => controller.abort(), 18000);
    let result: EmailStatusResult | null = null;
    try {
      const response = await fetch("/api/staff/klaviyo-status", { method: "POST", signal: controller.signal, headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify({ customerId: id }) });
      if (response.status === 403) { if (alive.current && readEpoch === epoch.current) { clearPrivate(); setPhase("denied"); } return; }
      if (!response.ok) throw new Error("Unavailable");
      const data: unknown = await response.json(); if (!validEmailStatusResult(data)) throw new Error("Invalid result"); result = data;
    } catch { /* Keep the previous observation explicitly dated; no consent inference. */ }
    finally { window.clearTimeout(timer); }
    if (!alive.current || current !== emailEpoch.current || readEpoch !== epoch.current) return;
    setEmailStates(previous => ({ ...previous, [id]: { loading: false, result: result || { status: "unavailable", checkedAt: null, localBlocked: customer.email_status === "unsubscribed" || !!previous[id]?.result?.localBlocked, synced: false, saved: previous[id]?.result?.saved || null } } }));
  }, [overview, session, phase, clearPrivate]);

  useEffect(() => {
    if (location.pathname === "/staff/customers" && selectedCustomer) queueMicrotask(() => { void refreshEmail(selectedCustomer); });
    return () => { emailEpoch.current++; emailController.current?.abort(); }; // eslint-disable-line react-hooks/exhaustive-deps -- invalidate this request generation
  }, [location.pathname, selectedCustomer, refreshEmail]);

  useEffect(() => {
    if (phase !== "allowed" || !session) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible" || writePending.current || refreshPending.current) return;
      const current = epoch.current;
      void crmData.decisions().then(result => {
        if (!alive.current || current !== epoch.current) return;
        if (denied(result)) { clearPrivate(); setPhase("denied"); return; }
        const visible = new Set(overview?.requests.map(request => request.id));
        setDecisions(!result.error && validCrmDecisions(result.data) ? (result.data.items as CateringDecision[]).filter(item => visible.has(item.request_id)) : null);
      });
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [phase, session, overview, clearPrivate]);

  async function mutate(action: () => ReturnType<typeof crmData.addNote>, expected: "boolean" | "id", success: string, readback: Readback = { kind: "overview" }) {
    if (writePending.current || refreshPending.current || writeBlocked || phase !== "allowed" || !session) return false;
    writePending.current = true; setWriting(true); setMessage(""); const current = epoch.current; const identity = authIdentity.current;
    const result = await action();
    if (!alive.current || current !== epoch.current || identity !== authIdentity.current) return false;
    writePending.current = false; setWriting(false);
    if (denied(result)) { clearPrivate(); setPhase("denied"); return false; }
    if (result.error || (expected === "boolean" ? result.data !== true : typeof result.data !== "string" || !result.data)) { uncertainWrite.current = readback; setWriteBlocked(true); setMessage(c.unknownSave); return false; }
    await refresh();
    if (alive.current && identity === authIdentity.current) setMessage(success);
    return true;
  }
  async function addNote(id: string, body: string) {
    if (!body.trim() || body.trim().length > 2000) { setMessage(c.noteError); return false; }
    return mutate(() => crmData.addNote(id, body.trim()), "boolean", c.noteSaved);
  }
  async function createTask(id: string, title: string, owner: string, due: string) {
    const validation = staffTaskError(title, owner, staffDateInput(due));
    if (validation || !Number.isFinite(Date.parse(due))) { setMessage(validation || c.dueError); return false; }
    return mutate(() => crmData.createTask(id, title.trim(), owner.trim(), due), "id", c.taskSaved, { kind: "tasks", customerId: id });
  }
  async function updateRequest(id: string, status: string, owner: string, due: string) {
    const validation = staffRequestError(status, owner, due); if (validation) { setMessage(validation); return false; }
    const original = overview?.requests.find(request => request.id === id)?.follow_up_at;
    const iso = due ? original && staffDateInput(original) === due ? original : staffInputIso(due) : null;
    return mutate(() => crmData.updateRequest(id, status, owner.trim(), iso), "boolean", c.requestSaved);
  }
  async function askQuestion(id: string, question: string) {
    if (!question.trim() || question.trim().length > 1000) { setMessage(c.questionError); return false; }
    if (!decisions || decisions.some(item => item.request_id === id && !item.recorded_at)) { setMessage(decisions ? c.pendingDecision : c.decisionUnavailable); return false; }
    return mutate(() => crmData.requestDecision(id, question.trim()), "id", c.questionSaved, { kind: "decisions" });
  }
  function openCustomer(id: string) {
    if (!overview?.customers.some(customer => customer.id === id)) { setMessage(c.noMatchingRecord); return; }
    setSelectedCustomer(id); navigate("/staff/customers");
  }
  function openRequest(id: string) {
    if (!overview?.requests.some(request => request.id === id)) { setMessage(c.noMatchingRecord); return; }
    setSelectedRequest(id); navigate("/staff/catering");
  }
  function toggleTests(next: boolean) {
    if (writePending.current || reading) return;
    clearPrivate(); setIncludeTests(next); setPhase("checking");
  }
  async function signOut() {
    locallySignedOut.current = true; authIdentity.current = ""; clearPrivate(); setSession(null); setIncludeTests(false); navigate("/staff", { replace: true });
    try { const result = await staffClient?.auth.signOut(); if (result?.error) setMessage(c.signOutFailed); }
    catch { setMessage(c.signOutFailed); }
  }

  const tab = location.pathname.split("/")[2];
  const busy = reading || writing;
  const platformOperator = platformView === "platform";
  const tabs = [["customers", c.customers], ["catering", c.catering], ["tasks", c.tasks], ["offers", c.offers], ["profile-sync", "Profil senkronu"], ["orders", "Clover siparişleri"], ["coupons", "Kupon"], ["ops", "Ops"], ["system", c.system], ["password", c.passwordPage]];
  return <main className="staff-workspace" lang="tr" dir="ltr">
    {!sessionReady ? <Skeleton /> : !session ? <><StaffSignIn onSigningIn={() => { locallySignedOut.current = false; }} />{message && <p role="status" className="mx-auto max-w-md px-4 text-sm text-amber-800">{message}</p>}</> : <>
      <header className="border-b border-brand-border bg-white px-4 lg:px-6"><div className="mx-auto flex max-w-[1800px] flex-wrap items-center gap-x-5 gap-y-3 py-3"><div className="flex items-center gap-2"><span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand font-bold text-white">N</span><div><p className="text-sm font-bold">{c.brand}</p><p className="text-[11px] text-stone-500">{c.workspace}</p></div></div><nav className="order-3 flex w-full flex-wrap gap-1 lg:order-none lg:w-auto" aria-label={c.workspace}>{phase === "allowed" && platformView !== "checking" && platformView !== "unavailable" && tabs.filter(([path]) => visibleStaffTab(path, platformOperator)).map(([path, label]) => <NavLink key={path} to={`/staff/${path}`} className={({ isActive }) => `rounded-lg px-3 py-2 text-sm font-medium ${isActive ? "bg-brand-primarySoft text-brand-dark" : "text-stone-600 hover:bg-brand-bg"}`}>{label}</NavLink>)}{phase === "allowed" && platformOperator && <StaffManagementLink key={`${session.user.id}:${browserDeployment.businessId}:${staffScopeRevision}`} businessId={browserDeployment.businessId} />}</nav><div className="ml-auto flex min-w-0 flex-wrap items-center gap-3">{platformOperator && <label className="flex items-center gap-2 text-xs" title={c.testsHelp}><input type="checkbox" checked={includeTests} disabled={busy || phase !== "allowed"} onChange={event => toggleTests(event.target.checked)} className="accent-brand" />{c.tests}</label>}<div className="max-w-48"><p className="truncate text-xs">{session.user.email || "—"}</p><p className="text-[10px] text-stone-500">{c.role}: {platformView === "platform" ? "Platform" : platformView === "restaurant" ? "Restoran" : "—"}</p></div><button type="button" className="text-xs font-semibold text-brand underline" onClick={() => void signOut()}>{c.logout}</button></div></div></header>
      <div className="mx-auto max-w-[1800px] px-3 py-4 sm:px-5 lg:px-6"><div className="mb-4 flex flex-wrap items-center justify-between gap-2"><p className="text-xs text-stone-500">{c.privacy}</p>{!["ops", "coupons", "team", "password"].includes(tab) && <button type="button" className="staff-button staff-secondary" disabled={busy} onClick={() => void refresh(true)}>{reading ? c.loading : c.refresh}</button>}</div>
        {(message || writeBlocked) && <p role="status" className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{message || c.refreshFirst}</p>}
        {phase === "denied" ? <section className="staff-panel p-6"><h1 className="text-xl font-semibold">{c.accessDenied}</h1><p className="mt-2 text-sm">{c.deniedHelp}</p></section>
          : phase === "unavailable" ? <p role="status" className="staff-panel p-6">{c.unavailable}</p>
            : phase === "checking" || platformView === "checking" ? <Skeleton />
            : platformView === "unavailable" ? <p role="status" className="staff-panel p-6">Görünüm rolü doğrulanamadı. Sayfayı yenileyin.</p> : <>
              {(!tab || tab === "crm") && <Navigate to={tab === "crm" ? "/staff/customers" : "/staff/tasks"} replace />}
              {tab && !["customers", "catering", "tasks", "offers", "profile-sync", "orders", "coupons", "team", "ops", "system", "password", "crm"].includes(tab) && <Navigate to="/staff/tasks" replace />}
              {tab && !["crm"].includes(tab) && !visibleStaffTab(tab, platformOperator) && <Navigate to="/staff/tasks" replace />}
              {tab && visibleStaffTab(tab, platformOperator) && <>
              {overview && <div hidden={tab !== "customers"}><CustomersView overview={overview} selectedId={selectedCustomer} onSelect={setSelectedCustomer} tasksByCustomer={tasks} tasksLoading={tasksLoading} emailStates={emailStates} onRefreshEmail={id => void refreshEmail(id)} onAddNote={addNote} onCreateTask={createTask} onCompleteTask={id => mutate(() => crmData.completeTask(id), "boolean", c.taskDone, selectedCustomer ? { kind: "tasks", customerId: selectedCustomer } : { kind: "queue" })} onOpenRequest={openRequest} busy={busy} writeBlocked={writeBlocked} /></div>}
              {overview && <div hidden={tab !== "catering"}><CateringView requests={overview.requests} selectedId={selectedRequest} onSelect={setSelectedRequest} decisions={decisions} notifications={notifications} busy={busy} writeBlocked={writeBlocked} accessToken={session.access_token} onUpdate={updateRequest} onQuestion={askQuestion} /></div>}
              {!overview && ["customers", "catering"].includes(tab) && <p role="status">{c.unavailable}</p>}
              {tab === "tasks" && <TasksView data={queueData} loading={reading} owner={queueOwner} onOwnerChange={setQueueOwner} onPage={value => { setQueueData(null); setOffset(value); }} onQueue={value => { setQueueData(null); setQueue(value); setOffset(0); }} queue={queue} onOpenCustomer={openCustomer} onOpenRequest={openRequest} onComplete={id => mutate(() => crmData.completeTask(id), "boolean", c.taskDone, { kind: "queue" })} busy={busy} writeBlocked={writeBlocked} />}
              {tab === "offers" && <StaffOffersPanel rpc={crmData.rpc} businessId={browserDeployment.businessId} />}
              {tab === "profile-sync" && <ProfileSyncPanel key={session.user.id} accessToken={session.access_token} />}
              {tab === "orders" && <><CloverOrderPullPanel key={`pull-${session.user.id}`} accessToken={session.access_token} /><CloverOrdersPanel key={session.user.id} accessToken={session.access_token} /></>}
              {tab === "coupons" && <CouponCheckout key={`${session.user.id}:${browserDeployment.businessId}`} businessId={browserDeployment.businessId} />}
              {tab === "team" && <StaffManagement key={`${session.user.id}:${browserDeployment.businessId}`} businessId={browserDeployment.businessId} onScopeChange={() => setStaffScopeRevision(v => v + 1)} />}
              {tab === "ops" && !platformOperator && <section className="space-y-4"><h1 className="text-2xl font-semibold">Site siparişleri · mutfak</h1><SiteOrderTickets key={`${session.user.id}:${browserDeployment.businessId}`} identity={session.user.id} businessId={browserDeployment.businessId} /></section>}
              {tab === "ops" && platformOperator && <OpsController key={session.user.id} identity={session.user.id} includeTests={includeTests}
                onDenied={() => { clearPrivate(); setPhase("denied"); }} onRefreshLegacy={() => { void refresh(true); }}
                errorsSection={<SystemView section="errors" aggregateOnly errors={errors} loading={reading} notifications={notifications} requests={overview?.requests || []} email={session.user.email || ""} authorized={phase === "allowed"} onResolve={id => mutate(() => crmData.resolveError(id), "boolean", c.resolved, { kind: "errors" })} busy={busy} writeBlocked={writeBlocked} />}
                detailsSection={<SystemView section="details" aggregateOnly errors={errors} loading={reading} notifications={notifications} requests={overview?.requests || []} email={session.user.email || ""} authorized={phase === "allowed"} onResolve={id => mutate(() => crmData.resolveError(id), "boolean", c.resolved, { kind: "errors" })} busy={busy} writeBlocked={writeBlocked} />} />}
              {tab === "password" && <section aria-label={c.passwordPage}><h1 className="text-xl font-semibold">{c.passwordPage}</h1><p className="mt-2 text-sm text-stone-600">{c.passwordScope}</p><StaffPassword key={session.user.id} userId={session.user.id} /></section>}
              {tab === "system" && <><SystemView errors={errors} loading={reading} notifications={notifications} requests={overview?.requests || []} email={session.user.email || ""} authorized={phase === "allowed"} onResolve={id => mutate(() => crmData.resolveError(id), "boolean", c.resolved, { kind: "errors" })} busy={busy} writeBlocked={writeBlocked} /><StaffPassword key={session.user.id} userId={session.user.id} /></>}
              </>}
            </>}
      </div>
    </>}
  </main>;
}

function Skeleton() { return <div role="status" aria-label={c.loading} className="mx-auto grid max-w-6xl gap-3 p-6">{[0, 1, 2, 3].map(row => <div key={row} className="staff-skeleton" />)}</div>; }
