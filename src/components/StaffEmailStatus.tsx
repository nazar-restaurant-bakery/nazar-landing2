import { useEffect, useState } from "react";
import { emailStatusLabel, validEmailStatusResult, type EmailStatusResult } from "../lib/crmEmailStatus";
import { crmDisplayDate } from "../lib/crmUi";

export default function StaffEmailStatus({ customerId, email, accessToken, localStatus }: {
  customerId: string; email: string | null; accessToken: string; localStatus: string;
}) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ customerId: string; result: EmailStatusResult } | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!email || !accessToken) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 18000);
    let active = true;
    queueMicrotask(() => { if (active) { setState(null); setLoading(true); } });
    void fetch("/api/staff/klaviyo-status", {
      method: "POST", signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ customerId }),
    }).then(async response => {
      if (!response.ok) throw new Error("Lookup unavailable");
      const result: unknown = await response.json();
      if (!validEmailStatusResult(result)) throw new Error("Invalid lookup");
      if (active) setState({ customerId, result });
    }).catch(() => { if (active) setState({ customerId, result: {
      status: "unavailable", checkedAt: null, saved: null, localBlocked: localStatus === "unsubscribed", synced: false,
    } }); }).finally(() => { window.clearTimeout(timeout); if (active) setLoading(false); });
    return () => { active = false; window.clearTimeout(timeout); controller.abort(); };
  }, [customerId, email, accessToken, attempt, localStatus]);
  const result = state?.customerId === customerId ? state.result : null;
  const blocked = localStatus === "unsubscribed" || result?.localBlocked || result?.saved?.blocked
    || result?.status === "unsubscribed" || result?.status === "suppressed";
  return <div className="rounded-lg bg-[#f6f7f4] p-3 text-sm" aria-label="Email permission status">
    <span className="text-xs text-[#64736a]">Email consent · Klaviyo</span>
    <strong className="mt-1 block">{!email ? "No email address" : result ? emailStatusLabel[result.status] : "Checking…"}</strong>
    {blocked && <strong className="mt-2 block text-red-800">Email marketing blocked — do not send.</strong>}
    {email && <>
      <span className="mt-1 block text-xs">{result?.checkedAt ? `Checked ${crmDisplayDate(result.checkedAt)}` : "Current Klaviyo status is not verified."}</span>
      {result?.synced ? <span className="block text-xs">Saved in CRM. {result.saved?.blocked ? "The block stays until separately reviewed." : "This does not grant permission to send."}</span>
        : <span className="block text-xs">{result?.checkedAt ? "CRM save was not confirmed. Refresh before relying on this result." : "Do not assume consent."}</span>}
      {!result?.synced && result?.saved && <span className="mt-1 block text-xs">Last saved: {emailStatusLabel[result.saved.status]} · {crmDisplayDate(result.saved.checkedAt)}. This is an earlier check.</span>}
      <button type="button" className="mt-2 underline" disabled={loading} onClick={() => setAttempt(n => n + 1)}>{loading ? "Checking…" : "Refresh email status"}</button>
      <span className="mt-1 block text-xs text-[#64736a]">Updated when this profile is opened or refreshed; not a continuous sync.</span>
    </>}
  </div>;
}
