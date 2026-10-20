import type { ReactNode } from "react";
import type { OpsConnection, OpsMetric, OpsSource } from "../../../lib/opsData";
import { opsCopy as c } from "../../../lib/staffCopy";
import { staffDisplayDate } from "../../../lib/staffUi";
import { opsAge } from "./opsFormat";

type Props = { index: number; source: OpsSource; title: string; connection: OpsConnection | undefined; metric?: OpsMetric; href: string; loading: boolean; children: ReactNode; footer?: ReactNode };
export default function MetricTile({ index, source, title, connection, metric, href, loading, children, footer }: Props) {
  const connected = connection?.status === "connected";
  return <section data-testid={`ops-tile-${index}`} data-source={source} className={`staff-panel flex min-w-0 flex-col ${connected ? "" : "!bg-stone-50"}`} aria-labelledby={`ops-tile-heading-${index}`}>
    <header className="flex items-start justify-between gap-3 border-b border-brand-border px-4 py-3"><div className="flex min-w-0 items-center gap-2"><span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border text-xs font-semibold ${connected ? "border-brand-border bg-brand-primarySoft text-brand-dark" : "border-stone-200 text-stone-500"}`}>{String(index).padStart(2, "0")}</span><h2 id={`ops-tile-heading-${index}`} className="text-sm font-semibold">{title}</h2></div><a href={href} target="_blank" rel="noopener noreferrer" className="shrink-0 text-xs font-medium text-brand-dark underline" aria-label={`${title} · ${c.openTool}`}>↗</a></header>
    <div className="flex-1 p-4">{loading ? <div className="space-y-3" role="status" aria-label={c.loading}><div className="staff-skeleton" /><div className="staff-skeleton !h-5" /></div> : <>{!connected && <p className={`mb-3 text-xs ${connection?.status === "error" ? "text-red-800" : "text-stone-500"}`}>{connection?.status === "error" ? c.error : c.connectionMissing}</p>}{children}</>}</div>
    <footer className="space-y-1 border-t border-brand-border px-4 py-3 text-[11px] text-stone-500">
      <p>{c.period}: {metric?.period_start ? staffDisplayDate(metric.period_start) : "—"}{metric?.period_end && metric.period_end !== metric.period_start ? ` – ${staffDisplayDate(metric.period_end)}` : ""}</p>
      <p title={metric?.collected_at ? staffDisplayDate(metric.collected_at) : undefined}>{opsAge(metric?.collected_at)}</p>
      {metric && <p>{c.collected}: {staffDisplayDate(metric.collected_at)} · {metric.collector}</p>}
      {footer}
    </footer>
  </section>;
}
