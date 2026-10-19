import type { OpsConnection, OpsSource } from "../../../lib/opsData";
import { opsCopy as c } from "../../../lib/staffCopy";
import { staffDisplayDate } from "../../../lib/staffUi";

const sources: [OpsSource, string][] = [["clover", "Clover"], ["klaviyo", "Klaviyo"], ["google_ads", "Google Ads"], ["meta", "Meta"], ["site", c.site], ["ga4", "GA4"], ["reviews", c.reviews], ["scheduler", c.scheduler], ["supabase", "Supabase"]];
export default function StatusStrip({ connections, loading, disabled, onRefresh, onCollect }: { connections: OpsConnection[] | null; loading: boolean; disabled: boolean; onRefresh: () => void; onCollect: () => void }) {
  const canCollect = !!connections?.some(connection => connection.capabilities.includes("collect"));
  const schedulerConnected = connections?.some(connection => connection.source === "scheduler" && connection.status === "connected");
  return <section className="staff-panel p-4" aria-label={c.statusTitle}>
    <div className="flex flex-wrap items-start justify-between gap-4"><div className="min-w-0 flex-1"><h2 className="mb-3 text-sm font-semibold">{c.statusTitle}</h2><div className="flex flex-wrap gap-2">{sources.map(([source, label]) => {
      const connection = connections?.find(item => item.source === source);
      const connected = connection?.status === "connected";
      const error = connection?.status === "error";
      return <details key={source} className={`max-w-full rounded-lg border px-2.5 py-1.5 text-xs ${connected ? "border-brand-border bg-brand-primarySoft text-brand-dark" : error ? "border-red-200 bg-red-50 text-red-800" : "border-stone-200 bg-stone-50 text-stone-500"}`} data-testid={`ops-connection-${source}`}><summary className="cursor-pointer"><span className="font-semibold">{label}</span> · {connected ? c.connected : error ? c.error : c.waiting}</summary><div className="mt-2 max-w-72 space-y-1 border-t border-current/20 pt-2"><p>{c.lastOk}: {staffDisplayDate(connection?.last_ok_at)}</p>{error && <p className="break-words">{c.lastError}: {connection?.last_error || "—"}</p>}{connection?.note && <p className="break-words">{connection.note}</p>}</div></details>;
    })}</div></div><div className="flex shrink-0 flex-wrap gap-2"><button type="button" className="staff-button staff-secondary" title={c.refreshHelp} disabled={disabled || loading} onClick={onRefresh}>{loading ? c.loading : c.refresh}</button><button type="button" data-testid="ops-action-collect" className={`staff-button ${canCollect ? "" : "staff-secondary !bg-stone-50 !text-stone-500"}`} disabled={disabled || loading} onClick={onCollect}>{c.collect}</button></div></div><p className="mt-3 text-xs text-stone-500">{schedulerConnected ? c.scheduleConnected : c.manualOnly}</p>
  </section>;
}
