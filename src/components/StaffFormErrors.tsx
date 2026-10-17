import { useEffect, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

type FormError = { id: string; occurred_at: string; form_kind: string; stage: string;
  error_code: string; http_status: number; alert_status: string };
type ErrorList = { total_open: number; items: FormError[] };
function valid(value: unknown): value is ErrorList {
  if (!value || typeof value !== "object") return false;
  const list = value as ErrorList;
  return Number.isSafeInteger(list.total_open) && list.total_open >= 0 && Array.isArray(list.items)
    && list.items.length <= 50 && list.total_open >= list.items.length && list.items.every((item) =>
      item && typeof item.id === "string" && /^[0-9a-f-]{36}$/i.test(item.id)
      && typeof item.occurred_at === "string" && Number.isFinite(Date.parse(item.occurred_at))
      && ["vip", "catering", "unknown"].includes(item.form_kind)
      && ["configuration", "challenge", "database"].includes(item.stage)
      && typeof item.error_code === "string" && /^[a-z_]{1,60}$/.test(item.error_code)
      && item.http_status === 503
      && ["not_requested", "suppressed", "claimed", "accepted", "failed"].includes(item.alert_status));
}

export default function StaffFormErrors({ client }: { client: SupabaseClient }) {
  const [data, setData] = useState<ErrorList | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [testResult, setTestResult] = useState("");
  const [testStarted, setTestStarted] = useState(false);
  const alive = useRef(true);
  async function refresh() {
    setBusy(true); setMessage("");
    try {
      const result = await client.rpc("crm_form_errors_v1");
      if (!alive.current) return;
      setData(!result.error && valid(result.data) ? result.data : null);
      if (result.error || !valid(result.data)) setMessage("Form error records are unavailable. Retry or check the server logs.");
    } catch {
      if (alive.current) { setData(null); setMessage("Form error records are unavailable. Retry or check the server logs."); }
    } finally { if (alive.current) setBusy(false); }
  }
  useEffect(() => {
    alive.current = true;
    queueMicrotask(() => { if (alive.current) void refresh(); });
    return () => { alive.current = false; };
    // Each mounted instance belongs to the current authenticated CRM session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);
  async function setupTest() {
    if (testStarted) return;
    setTestStarted(true); setTestResult("Sending the single setup test…");
    try {
      const { data: auth } = await client.auth.getSession();
      if (!auth.session) { setTestResult("Sign in again. No test sent."); return; }
      const result = await fetch("/api/staff/form-error-setup-test", { method: "POST", signal: AbortSignal.timeout(20000),
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth.session.access_token}` }, body: "{}" });
      const body = await result.json() as { code?: string };
      if (alive.current) setTestResult(result.ok && body.code === "accepted" ? "Setup test accepted for ctnazarbakery@gmail.com. Inbox delivery is not yet confirmed."
        : body.code === "already_attempted_or_rate_limited" ? "No email sent: this setup test was already attempted or the 15-minute limit applies."
        : "Could not confirm the test result. Check delivery records before any further action; do not resend.");
    } catch { if (alive.current) setTestResult("Test result uncertain. Check delivery records; do not resend."); }
  }
  async function resolve(id: string) {
    if (busy) return;
    setBusy(true); setMessage("");
    try {
      const result = await client.rpc("crm_resolve_form_error_v1", { p_id: id });
      if (!alive.current) return;
      if (result.error || result.data !== true) {
        setMessage("Could not confirm resolution. Refresh records before retrying."); return;
      }
      await refresh();
    } catch { if (alive.current) setMessage("Could not confirm resolution. Refresh records before retrying."); }
    finally { if (alive.current) setBusy(false); }
  }
  return <section aria-label="Form errors" className="mb-5 rounded-xl border border-[#dfe7df] bg-white p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-lg font-semibold">Form errors{data ? ` (${data.total_open} open)` : ""}</h2>
      <button type="button" disabled={busy} onClick={() => void refresh()} className="text-sm font-semibold text-green-800 underline disabled:opacity-50">Refresh form errors</button></div>
    <p className="mt-2 text-sm text-stone-600">Server-reported form failures. Browser-only failures and a full database outage may appear only in server logs. An email marked accepted is not proof of inbox delivery.</p>
    <details className="mt-2 text-sm"><summary className="cursor-pointer text-green-800">Email alert setup test</summary>
      <p className="mt-2">Sends one setup email to ctnazarbakery@gmail.com only. No customer data. The 15-minute alert limit applies; a permanent receipt prevents another attempt.</p>
      <button type="button" disabled={testStarted} onClick={() => void setupTest()} className="mt-2 font-semibold text-green-800 underline disabled:opacity-50">Send setup test once</button>
      {testResult && <p role="status" className="mt-2">{testResult}</p>}
    </details>
    {message && <p role="status" className="mt-2 text-sm text-red-700">{message}</p>}
    {data?.total_open === 0 && <p className="mt-2 text-sm">No unresolved server-reported form errors.</p>}
    {data && data.total_open > data.items.length && <p className="mt-2 text-sm">Showing the latest {data.items.length} of {data.total_open} unresolved records.</p>}
    {data?.items.map((item) => <article key={item.id} className="mt-3 rounded-lg border p-3 text-sm">
      <p><strong>{item.form_kind} form</strong> · {new Date(item.occurred_at).toLocaleString("en-US", { timeZone: "America/New_York" })} New York</p>
      <p>Stage: {item.stage} · Code: {item.error_code} · Email: {item.alert_status}</p>
      <p className="break-all">Reference: {item.id}</p>
      <button type="button" disabled={busy} onClick={() => void resolve(item.id)} className="mt-2 font-semibold text-green-800 underline disabled:opacity-50">Mark resolved after checking</button>
    </article>)}
  </section>;
}
