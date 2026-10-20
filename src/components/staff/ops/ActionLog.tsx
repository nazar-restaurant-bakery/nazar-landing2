import { useRef, useState } from "react";
import type { OpsAction } from "../../../lib/opsData";
import { opsCopy as c } from "../../../lib/staffCopy";
import { staffDisplayDate } from "../../../lib/staffUi";

const names: Record<string, string> = { collect: c.collect, sync_clover_csv: c.syncClover, retry_failed_job: c.retry, offer_set_active: c.offer, ads_set_status: c.ads, product_set_channel: c.product, commission_report: c.report };
const states: Record<string, string> = { queued: c.queued, running: c.working, done: c.done, failed: c.failed, not_connected: c.notConnected };
export default function ActionLog({ actions, loading, onDownload, onResume, identity, busy }: { actions: OpsAction[] | null; loading: boolean; onDownload?: (actionId: string) => Promise<void>; onResume?: (actionId: string) => Promise<void>; identity: string; busy: boolean }) {
  const [resumeId, setResumeId] = useState<string | null>(null);
  const [resuming, setResuming] = useState(false);
  const [resumeError, setResumeError] = useState("");
  const resumePending = useRef(false);
  async function resume(action: OpsAction) {
    if (!onResume || busy || resumePending.current || action.status !== "queued" || !identity || action.requested_by !== identity) return;
    resumePending.current = true; setResuming(true); setResumeError("");
    try { await onResume(action.id); setResumeId(null); }
    catch { setResumeError(c.unknownAction); }
    finally { resumePending.current = false; setResuming(false); }
  }
  const rows = actions ? [...actions].sort((a, b) => Date.parse(b.requested_at) - Date.parse(a.requested_at)).slice(0, 10) : [];
  return <section className="staff-panel p-4" aria-label={c.actionLog}>
    <h2 className="font-semibold">{c.actionLog}</h2><p className="mt-1 text-xs text-stone-500">{c.actionLogScope}</p>
    {loading && actions === null ? <div className="mt-4 staff-skeleton" role="status" aria-label={c.loading} />
      : actions === null ? <p className="mt-3 text-sm text-stone-500">{c.actionLogUnavailable}</p>
        : !rows.length ? <p className="mt-3 text-sm text-stone-500">{c.noActions}</p>
          : <ol className="mt-3 space-y-3">{rows.map(action => {
            const canResume = !!onResume && action.status === "queued" && !!identity && action.requested_by === identity;
            return <li key={action.id} className="rounded-lg border border-brand-border p-3 text-xs">
              <div className="flex flex-wrap items-start justify-between gap-2"><h3 className="font-semibold">{names[action.action] || action.action}</h3><span className={action.status === "failed" ? "text-red-800" : action.status === "done" ? "text-brand-dark" : "text-stone-500"}>{states[action.status] || "—"}</span></div>
              <p className="mt-2 text-stone-500">{c.requestedAt}: {staffDisplayDate(action.requested_at)}</p>
              <p className="mt-1 text-stone-500">{c.requestedBy}: {action.requested_by && /^[0-9a-f-]{36}$/i.test(action.requested_by) ? `${c.staffAccount} ${action.requested_by.slice(0, 8)}` : "—"}</p>
              {action.finished_at && <p className="mt-1 text-stone-500">{c.finishedAt}: {staffDisplayDate(action.finished_at)}</p>}
              {action.result?.code && /^[A-Z_0-9-]{1,80}$/i.test(action.result.code) && <p className="mt-2 break-words text-stone-500">{c.result}: {action.result.code}</p>}
              {onDownload && action.action === "commission_report" && action.status === "done" && typeof action.result?.downloadPath === "string" && <button type="button" disabled={busy || resuming} className="mt-3 font-semibold text-brand-dark underline" onClick={() => void onDownload(action.id)}>{c.downloadReport}</button>}
              {canResume && (resumeId !== action.id ? <button type="button" disabled={busy || resuming} className="mt-3 font-semibold text-brand-dark underline" onClick={() => { setResumeId(action.id); setResumeError(""); }}>{c.resumeQueued}</button>
                : <div className="mt-3 rounded-lg border border-brand-border bg-brand-bg p-3" data-testid={`ops-resume-${action.id}`}>
                  <p>{c.resumeQueuedHelp}</p>{resumeError && <p role="alert" className="mt-2 text-red-800">{resumeError}</p>}
                  <div className="mt-3 flex flex-wrap gap-2"><button type="button" className="staff-button" disabled={busy || resuming} onClick={() => void resume(action)}>{resuming ? c.working : c.run}</button><button type="button" className="staff-button staff-secondary" disabled={busy || resuming} onClick={() => { setResumeId(null); setResumeError(""); }}>{c.cancel}</button></div>
                </div>)}
            </li>;
          })}</ol>}
  </section>;
}
