import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { staffClient } from "../../lib/crmData";
import { browserDeployment, NAZAR_BUSINESS_ID } from "../../lib/supabase";
import { opsCopy as c } from "../../lib/staffCopy";
import { opsData, opsDenied, opsPending, opsReportPath, validOpsAction, validOpsActions, validOpsConnections, validOpsDashboard } from "../../lib/opsData";
import type { OpsAction, OpsActionName, OpsConnection, OpsDashboard } from "../../lib/opsData";
import OpsView from "./OpsView";
import { loyaltyMonth, loyaltyRequestParams, loyaltyScopeMatches, validLoyaltyMetrics } from "../../lib/loyaltyMetrics";
import type { LoyaltyMetrics, LoyaltyReadState, LoyaltyScope } from "../../lib/loyaltyMetrics";
import { safeCrmRequest } from "../../lib/crmUi";

type Props = {
  identity: string; includeTests: boolean; onDenied: () => void;
  onRefreshLegacy: () => void; errorsSection?: ReactNode; detailsSection?: ReactNode;
};
type Pending = { id: string | null; requestKey: string; action: OpsActionName; startedAt: number; requiresManual: boolean };
type ReadState = "ready" | "missing" | "error";

export default function OpsController({ identity, includeTests, onDenied, onRefreshLegacy, errorsSection, detailsSection }: Props) {
  const [dashboard, setDashboard] = useState<OpsDashboard | null>(null);
  const [connections, setConnections] = useState<OpsConnection[] | null>(null);
  const [actions, setActions] = useState<OpsAction[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [backendPending, setBackendPending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [writeBlocked, setWriteBlocked] = useState(false);
  const [message, setMessage] = useState("");
  const [loyalty, setLoyalty] = useState<{ scope: LoyaltyScope; timezone: string; data: LoyaltyMetrics | null; state: LoyaltyReadState } | null>(null);
  const alive = useRef(false);
  const epoch = useRef(0);
  const reading = useRef(false);
  const writing = useRef(false);
  const actionReading = useRef(false);
  const actionSequence = useRef(0);
  const snapshotSequence = useRef(0);
  const loyaltySequence = useRef(0);
  const health = useRef<{ dashboard: ReadState; connections: ReadState; actions: ReadState }>({ dashboard: "error", connections: "error", actions: "error" });
  const actionRows = useRef<OpsAction[] | null>(null);
  const pending = useRef<Pending | null>(null);
  const callbacks = useRef({ onDenied, onRefreshLegacy });
  useEffect(() => { callbacks.current = { onDenied, onRefreshLegacy }; }, [onDenied, onRefreshLegacy]);

  const updateHealth = useCallback(() => {
    const states = Object.values(health.current);
    const missing = states.includes("missing");
    setBackendPending(missing); setUnavailable(!missing && states.includes("error"));
  }, []);
  const deny = useCallback(() => {
    // Invalidate all in-flight reads/writes before the parent removes this view.
    epoch.current++; actionSequence.current++; snapshotSequence.current++; loyaltySequence.current++;
    reading.current = false; actionReading.current = false; writing.current = false; pending.current = null; actionRows.current = null;
    setDashboard(null); setConnections(null); setActions(null); setLoyalty(null); setBusy(false); setWriteBlocked(true);
    callbacks.current.onDenied();
  }, []);
  const readLoyalty = useCallback(async () => {
    if (!alive.current) return;
    const current = epoch.current, sequence = ++loyaltySequence.current;
    let scope: LoyaltyScope = { businessId: browserDeployment.businessId, identity, includeTests, month: loyaltyMonth() };
    let timezone = "America/New_York";
    setLoyalty({ scope, timezone, data: null, state: "loading" });
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 18_000);
    const load = (context: LoyaltyScope) => safeCrmRequest(async () => {
      if (!staffClient || !context.businessId) return { data: null, error: { code: "MISSING_CONFIG" } };
      const query = staffClient.rpc("loyalty_metrics_v1", loyaltyRequestParams(context));
      return await (query.abortSignal?.(controller.signal) ?? query);
    });
    try {
      let result = await load(scope);
      if (!alive.current || current !== epoch.current || sequence !== loyaltySequence.current) return;
      if (opsDenied(result.error)) { deny(); return; }
      // The first read discovers the tenant timezone. At a month boundary,
      // re-read its actual current month before accepting any aggregate.
      if (!result.error && validLoyaltyMetrics(result.data, scope)) {
        timezone = result.data.timezone;
        const tenantMonth = loyaltyMonth(new Date(), timezone);
        if (scope.month !== tenantMonth) {
          scope = { ...scope, month: tenantMonth };
          result = await load(scope);
          if (!alive.current || current !== epoch.current || sequence !== loyaltySequence.current) return;
          if (opsDenied(result.error)) { deny(); return; }
        }
      }
      const valid = !result.error && validLoyaltyMetrics(result.data, scope);
      setLoyalty({ scope, timezone, data: valid ? result.data as LoyaltyMetrics : null, state: valid ? "ready" : opsPending(result.error) ? "missing" : "error" });
    } finally { window.clearTimeout(timer); }
  }, [identity, includeTests, deny]);
  const acceptActions = useCallback((next: OpsAction[], manual = false) => {
    actionRows.current = next; setActions(next);
    const tracked = pending.current;
    if (tracked) {
      // A time range or matching action name never identifies a lost enqueue.
      const row = next.find(item => item.request_key === tracked.requestKey && item.requested_by === identity
        && item.action === tracked.action && (!tracked.id || item.id === tracked.id));
      if (row) {
        pending.current = { ...tracked, id: row.id };
        if (!["queued", "running"].includes(row.status) && (!tracked.requiresManual || manual)) {
          pending.current = null; writing.current = false; setBusy(false); setWriteBlocked(false);
          setMessage(row.status === "done" ? c.done : row.status === "not_connected" ? c.connectionMissing : c.failed);
          return true;
        }
      }
      // A bounded or unavailable log is never evidence the write did not happen.
      if (manual) setMessage(c.unknownAction);
    } else if (manual && Object.values(health.current).every(state => state === "ready")) {
      setWriteBlocked(false); setMessage("");
    }
    return false;
  }, [identity]);

  const readSnapshots = useCallback(async () => {
    if (!alive.current) return;
    const current = epoch.current, sequence = ++snapshotSequence.current;
    // Background completion refresh: keep the current tiles visible, without a
    // loading skeleton, and never invoke a collector from a read path.
    const [d, cResult] = await Promise.all([opsData.dashboard(), opsData.connections()]);
    if (!alive.current || current !== epoch.current || sequence !== snapshotSequence.current) return;
    if ([d, cResult].some(result => opsDenied(result.error))) { deny(); return; }
    const readyDashboard = !d.error && validOpsDashboard(d.data) && d.data.business_id === NAZAR_BUSINESS_ID;
    const readyConnections = !cResult.error && validOpsConnections(cResult.data);
    health.current.dashboard = readyDashboard ? "ready" : opsPending(d.error) ? "missing" : "error";
    health.current.connections = readyConnections ? "ready" : opsPending(cResult.error) ? "missing" : "error";
    if (readyDashboard) setDashboard(d.data as OpsDashboard);
    if (readyConnections) setConnections((cResult.data as { items: OpsConnection[] }).items);
    updateHealth();
    void readLoyalty();
  }, [deny, updateHealth, readLoyalty]);

  const readActions = useCallback(async () => {
    if (!alive.current || reading.current || actionReading.current) return;
    actionReading.current = true;
    const current = epoch.current, sequence = ++actionSequence.current;
    const result = await opsData.actions();
    if (!alive.current || current !== epoch.current) return;
    actionReading.current = false;
    if (sequence !== actionSequence.current) return;
    if (opsDenied(result.error)) { deny(); return; }
    const ready = !result.error && validOpsActions(result.data);
    health.current.actions = ready ? "ready" : opsPending(result.error) ? "missing" : "error";
    updateHealth();
    if (ready && acceptActions((result.data as { items: OpsAction[] }).items)) void readSnapshots();
  }, [acceptActions, deny, readSnapshots, updateHealth]);

  const read = useCallback(async (manual = false) => {
    if (!alive.current || reading.current) return;
    reading.current = true;
    const current = epoch.current, snapshot = ++snapshotSequence.current, action = ++actionSequence.current;
    setLoading(true);
    const [d, cResult, a] = await Promise.all([opsData.dashboard(), opsData.connections(), opsData.actions()]);
    if (!alive.current || current !== epoch.current) return;
    reading.current = false; setLoading(false);
    if ([d, cResult, a].some(result => opsDenied(result.error))) { deny(); return; }
    const readyDashboard = !d.error && validOpsDashboard(d.data) && d.data.business_id === NAZAR_BUSINESS_ID;
    const readyConnections = !cResult.error && validOpsConnections(cResult.data);
    const readyActions = !a.error && validOpsActions(a.data);
    if (snapshot === snapshotSequence.current) {
      health.current.dashboard = readyDashboard ? "ready" : opsPending(d.error) ? "missing" : "error";
      health.current.connections = readyConnections ? "ready" : opsPending(cResult.error) ? "missing" : "error";
      if (readyDashboard) setDashboard(d.data as OpsDashboard);
      if (readyConnections) setConnections((cResult.data as { items: OpsConnection[] }).items);
    }
    if (action === actionSequence.current) health.current.actions = readyActions ? "ready" : opsPending(a.error) ? "missing" : "error";
    updateHealth();
    if (action === actionSequence.current && readyActions
      && acceptActions((a.data as { items: OpsAction[] }).items, manual)) void readSnapshots();
  }, [acceptActions, deny, readSnapshots, updateHealth]);

  useEffect(() => {
    alive.current = true; const generation = ++epoch.current;
    queueMicrotask(() => { if (generation === epoch.current) void read(); });
    return () => {
      alive.current = false; epoch.current++; reading.current = false; // eslint-disable-line react-hooks/exhaustive-deps -- request generation, not a DOM ref
      actionReading.current = false; actionSequence.current++; snapshotSequence.current++; // eslint-disable-line react-hooks/exhaustive-deps -- monotonically invalidate request generations, not DOM refs
      writing.current = false; pending.current = null; actionRows.current = null;
    };
  }, [read]);

  useEffect(() => {
    void readLoyalty();
    return () => { loyaltySequence.current++; }; // eslint-disable-line react-hooks/exhaustive-deps -- request generation, not a DOM ref
  }, [readLoyalty]);

  useEffect(() => {
    if (!busy) return;
    const started = pending.current?.startedAt ?? Date.now();
    const timer = window.setInterval(() => {
      if (Date.now() - started >= 120_000) {
        window.clearInterval(timer);
        if (pending.current) pending.current = { ...pending.current, requiresManual: true };
        writing.current = false; setBusy(false); setWriteBlocked(true); setMessage(c.timedOut);
        return;
      }
      void readActions();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [busy, readActions]);

  async function request(action: OpsActionName, payload: Record<string, unknown>) {
    if (!alive.current || writing.current || writeBlocked || reading.current) return false;
    if (backendPending) { setMessage(c.missingMigration); return false; }
    if (!actions) { setMessage(c.actionLogUnavailable); return false; }
    if (actions?.some(item => item.action === action && ["queued", "running"].includes(item.status))) {
      setMessage(c.samePending); return false;
    }
    const current = epoch.current;
    const requestKey = crypto.randomUUID();
    writing.current = true; pending.current = { id: null, requestKey, action, startedAt: Date.now(), requiresManual: false };
    setBusy(true); setMessage("");
    const result = await opsData.request(action, { ...payload, clientRequestId: requestKey });
    if (!alive.current || current !== epoch.current) return false;
    if (opsDenied(result.error)) { deny(); return false; }
    if (!pending.current) return true;
    if (result.error || !validOpsAction(result.data) || result.data.action !== action || result.data.request_key !== requestKey || result.data.requested_by !== identity) {
      if (pending.current) pending.current = { ...pending.current, requiresManual: true };
      writing.current = false; setBusy(false); setWriteBlocked(true);
      setMessage(opsPending(result.error) ? c.missingMigration : c.unknownAction);
      return false;
    }
    const row = result.data;
    actionSequence.current++;
    pending.current = { ...pending.current!, id: row.id };
    if (acceptActions([row, ...(actionRows.current || []).filter(item => item.id !== row.id)].slice(0, 50))) void readSnapshots();
    else void readActions();
    return true;
  }
  async function resume(actionId: string) {
    const row = actions?.find(item => item.id === actionId && item.status === "queued" && item.requested_by === identity);
    if (!alive.current || !row || writing.current || reading.current) return;
    if (pending.current && pending.current.requestKey !== row.request_key) { setMessage(c.unknownAction); return; }
    const current = epoch.current;
    writing.current = true;
    pending.current = { id: row.id, requestKey: row.request_key, action: row.action, startedAt: Date.now(), requiresManual: false };
    setBusy(true); setWriteBlocked(false); setMessage("");
    const result = await opsData.resume(row.id);
    if (!alive.current || current !== epoch.current) return;
    if (opsDenied(result.error)) { deny(); return; }
    if (!pending.current) return;
    if (result.error || !validOpsAction(result.data) || result.data.id !== row.id || result.data.request_key !== row.request_key || result.data.requested_by !== identity) {
      pending.current = { ...pending.current, requiresManual: true };
      writing.current = false; setBusy(false); setWriteBlocked(true); setMessage(c.unknownAction); return;
    }
    actionSequence.current++;
    if (acceptActions([result.data, ...(actionRows.current || []).filter(item => item.id !== row.id)].slice(0, 50))) void readSnapshots();
    else void readActions();
  }
  async function download(actionId: string) {
    if (!alive.current) return;
    const action = actions?.find(item => item.id === actionId);
    const path = action && dashboard ? opsReportPath(action, dashboard.business_id) : null;
    if (!path || !staffClient) { setMessage(c.unknownAction); return; }
    const current = epoch.current;
    const { data, error } = await staffClient.storage.from("nazar-ops").createSignedUrl(path, 60);
    if (!alive.current || current !== epoch.current) return;
    if (error || !data?.signedUrl) { setMessage(c.unavailable); return; }
    let url: URL;
    try { url = new URL(data.signedUrl, window.location.origin); }
    catch { setMessage(c.unavailable); return; }
    if (url.protocol !== "https:" || url.hostname !== "khgczybubufouraqyrcj.supabase.co"
      || !url.pathname.startsWith("/storage/v1/object/sign/nazar-ops/")) { setMessage(c.unavailable); return; }
    const link = document.createElement("a");
    link.href = url.href; link.rel = "noreferrer noopener"; link.target = "_blank";
    document.body.append(link); link.click(); link.remove();
  }
  const visibleDashboard = dashboard && {
    ...dashboard, metrics: dashboard.metrics.filter(item => includeTests || !item.is_test),
    offers: dashboard.offers.filter(item => includeTests || !item.is_test),
  };
  const currentLoyaltyScope: LoyaltyScope = { businessId: browserDeployment.businessId, identity, includeTests,
    month: loyaltyMonth(new Date(), loyalty?.timezone || "America/New_York") };
  const visibleLoyalty = loyalty && loyaltyScopeMatches(loyalty.scope, currentLoyaltyScope) ? loyalty : null;
  return <OpsView dashboard={visibleDashboard} connections={connections} actions={actions}
    loading={loading} unavailable={unavailable} backendPending={backendPending}
    busy={busy} writeBlocked={writeBlocked} message={message}
    onRefresh={() => { callbacks.current.onRefreshLegacy(); void read(true); void readLoyalty(); }}
    onRequest={request} onDownload={download} onResume={resume} identity={identity}
    errorsSection={errorsSection} detailsSection={detailsSection} loyalty={visibleLoyalty?.data ?? null} loyaltyState={visibleLoyalty?.state ?? "loading"} />;
}
