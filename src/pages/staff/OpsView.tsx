import { useState, type ReactNode } from "react";
import type { OpsAction, OpsActionName, OpsConnection, OpsDashboard, OpsMetric, OpsSource } from "../../lib/opsData";
import { selectOpsMetric } from "../../lib/opsUi";
import { opsCopy as c } from "../../lib/staffCopy";
import { staffLinks } from "../../lib/staffLinks";
import { staffDisplayDate } from "../../lib/staffUi";
import MetricTile from "../../components/staff/ops/MetricTile";
import StatusStrip from "../../components/staff/ops/StatusStrip";
import ActionColumn from "../../components/staff/ops/ActionColumn";
import ActionLog from "../../components/staff/ops/ActionLog";
import { opsAge, opsCurrency, opsMetricNumber, opsPercent } from "../../components/staff/ops/opsFormat";
import { observedSiteFailure } from "../../components/staff/ops/opsMetricVisibility";

export interface OpsViewProps {
  identity: string;
  dashboard: OpsDashboard | null;
  connections: OpsConnection[] | null;
  actions: OpsAction[] | null;
  loading: boolean;
  unavailable: boolean;
  backendPending: boolean;
  busy: boolean;
  writeBlocked: boolean;
  message: string;
  onRefresh: () => void;
  onRequest: (action: OpsActionName, payload: Record<string, unknown>) => Promise<boolean>;
  onDownload?: (actionId: string) => Promise<void>;
  onResume?: (actionId: string) => Promise<void>;
  errorsSection?: ReactNode;
  detailsSection?: ReactNode;
  children?: ReactNode;
}
type Format = "number" | "money" | "percent" | "text" | "date" | "up";

export default function OpsView({ identity, dashboard, connections, actions, loading, unavailable, backendPending, busy, writeBlocked, message, onRefresh, onRequest, onDownload, onResume, errorsSection, detailsSection, children }: OpsViewProps) {
  const [selectedAction, setSelectedAction] = useState<OpsActionName | null>(null);
  const connection = (source: OpsSource) => backendPending ? undefined : connections?.find(item => item.source === source);
  const failedSitePing = observedSiteFailure(dashboard?.metrics || [], connection("site"), actions);
  function metric(source: OpsSource, key: string) {
    if (backendPending) return undefined;
    if (connection(source)?.status !== "connected") return source === "site" ? failedSitePing?.get(key) : undefined;
    return selectOpsMetric(dashboard?.metrics || [], source, key);
  }
  const value = (source: OpsSource, key: string, format: Format = "number") => <Datum label="" metric={metric(source, key)} format={format} compact />;
  const row = (label: string, source: OpsSource, key: string, format: Format = "number", prominent = false) => <Datum label={label} metric={metric(source, key)} format={format} prominent={prominent} />;
  const tileProps = (index: number, source: OpsSource, title: string, key: string, link: keyof typeof staffLinks = source) => ({ index, source, title, metric: metric(source, key), connection: connection(source), href: staffLinks[link].href, loading });
  const channelNames = [["dine_in", c.dineIn], ["pickup", c.pickup], ["delivery", c.delivery], ["catering", c.catering]] as const;
  const channelValues = channelNames.map(([channel]) => metric("clover", `channel_${channel}_net_sales_mtd`)?.value_num ?? null);
  const channelMax = Math.max(1, ...channelValues.filter((amount): amount is number => typeof amount === "number").map(Math.abs));
  const qicr = metric("supabase", "qicr_mtd");
  const base = metric("supabase", "baseline");
  const commissionMetric = metric("supabase", "commission_mtd");
  const commissionReady = [qicr, base, commissionMetric].some(Boolean) || connection("supabase")?.capabilities.includes("commission_report");
  const commissionConnection = commissionReady ? connection("supabase") : undefined;

  return <div className="min-w-0 space-y-4" aria-label={c.title}>
    <header className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-2xl font-semibold">{c.title}</h1><p className="mt-1 text-sm text-stone-600">{c.subtitle}</p></div><p className="max-w-lg text-xs text-stone-500">{c.totalsOnly}</p></header>
    {backendPending && <p className="staff-panel p-4 text-sm text-stone-600" role="status">{c.missingMigration}</p>}
    {unavailable && !backendPending && <p className="staff-panel p-4 text-sm text-red-800" role="status">{c.unavailable}</p>}
    {message && <p className="staff-panel p-4 text-sm" role="status">{message}</p>}
    <StatusStrip connections={backendPending ? null : connections} loading={loading} disabled={busy} onRefresh={onRefresh} onCollect={() => setSelectedAction("collect")} collectConfirmation={selectedAction === "collect" ? <ActionColumn confirmationOnly dashboard={dashboard} connections={connections} actions={actions} selectedAction="collect" onSelectAction={setSelectedAction} onRequest={onRequest} busy={busy} blocked={writeBlocked} backendPending={backendPending} /> : null} />
    <p className="text-xs text-stone-500">{c.snapshotScope} {c.realTotals}</p>
    <div className="grid min-w-0 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
      <div className="grid min-w-0 items-stretch gap-4 md:grid-cols-2" data-testid="ops-metric-grid">
        <MetricTile {...tileProps(1, "clover", c.cloverSales, "net_sales_yesterday")} footer={<p>{c.netSalesDefinition}</p>}><div className="space-y-4">{row(`${c.yesterday} · ${c.netSales}`, "clover", "net_sales_yesterday", "money", true)}{row(`${c.monthToDate} · ${c.netSales}`, "clover", "net_sales_mtd", "money")}<div className="grid grid-cols-2 gap-3">{row(`${c.yesterday} · ${c.orders}`, "clover", "orders_yesterday")}{row(`${c.monthToDate} · ${c.orders}`, "clover", "orders_mtd")}</div></div></MetricTile>
        <MetricTile {...tileProps(2, "clover", c.cloverChannels, "net_sales_mtd")}><p className="mb-4 text-xs text-stone-500">{c.monthToDate}</p><div className="space-y-4">{channelNames.map(([channel, label], index) => <div key={channel}><div className="flex items-baseline justify-between gap-2 text-sm"><span className="font-medium">{label}</span><div>{value("clover", `channel_${channel}_net_sales_mtd`, "money")}</div></div><div className="mt-1 h-2 overflow-hidden rounded-lg bg-stone-100" aria-hidden="true"><div className="h-full rounded-lg bg-brand" style={{ width: channelValues[index] === null ? "0%" : `${Math.abs(channelValues[index]!) / channelMax * 100}%` }} /></div><div className="mt-1 text-xs text-stone-500">{c.orders}: {value("clover", `channel_${channel}_orders_mtd`)}</div></div>)}</div></MetricTile>
        <MetricTile {...tileProps(3, "supabase", c.commission, "qicr_mtd")} connection={commissionConnection} metric={qicr} footer={<p>{c.commissionPending}</p>}><div className="space-y-4">{row(`${c.monthToDate} · ${c.qicr}`, "supabase", "qicr_mtd", "money", true)}{row(c.baseDifference, "supabase", "qicr_mtd", "money")}<p className="text-xs text-stone-500">{c.qicrDefinition}</p>{row(c.computedCommission, "supabase", "commission_mtd", "money")}<p className="text-xs text-stone-500">{commissionMetric?.value_text === "estimate" ? c.estimate : commissionMetric ? c.calculated : "—"}</p></div></MetricTile>
        <MetricTile {...tileProps(4, "klaviyo", c.klaviyo, "subscribers")}><div className="space-y-4">{row(c.subscriberCount, "klaviyo", "subscribers", "number", true)}{row(`${c.snapshotDifference} · ${c.netGrowth}`, "klaviyo", "net_growth_7d")} {row(c.latestCampaign, "klaviyo", "last_campaign_name", "text")}<div className="grid grid-cols-2 gap-3">{row(c.opens, "klaviyo", "last_campaign_open_rate", "percent")}{row(c.clicks, "klaviyo", "last_campaign_click_rate", "percent")}</div></div></MetricTile>
        <MetricTile {...tileProps(5, "google_ads", c.googleAds, "spend_7d")} footer={<p>{c.conversionCaution}</p>}><div className="space-y-4">{row(`${c.lastSeven} · ${c.cost}`, "google_ads", "spend_7d", "money", true)}<div className="grid grid-cols-2 gap-3">{row(c.clicks, "google_ads", "clicks_7d")}{row(c.conversions, "google_ads", "conversions_7d")}{row(c.activeCampaigns, "google_ads", "active_campaigns")}{row(c.pausedCampaigns, "google_ads", "paused_campaigns")}</div></div></MetricTile>
        <MetricTile {...tileProps(6, "meta", c.meta, "spend_7d")}><div className="space-y-4">{row(`${c.lastSeven} · ${c.cost}`, "meta", "spend_7d", "money", true)}<div className="grid grid-cols-2 gap-3">{row(c.reach, "meta", "reach_7d")}{row(c.results, "meta", "results_7d")}{row(c.campaigns, "meta", "campaigns")}</div></div></MetricTile>
        <MetricTile {...tileProps(7, "site", c.site, "is_up")} footer={<p>{c.ga4Property}</p>}><div className="space-y-4">{row(c.siteStatus, "site", "is_up", "up", true)}<div className="grid grid-cols-2 gap-3">{row(c.httpStatus, "site", "http_status")}{row(`${c.duration} · ${c.milliseconds}`, "site", "response_ms")}</div>{row(`${c.lastSeven} · ${c.ga4Visits}`, "ga4", "visits_7d")}{connection("ga4")?.status !== "connected" && <p className="text-xs text-stone-500">GA4 · {c.waiting}</p>}{row(`${c.lastSeven} · ${c.formSubmissions}`, "supabase", "form_submissions_7d")}</div></MetricTile>
        <MetricTile {...tileProps(8, "reviews", c.reviews, "rating")} footer={<p>{c.reviewDifference}</p>}><div className="space-y-4">{row(c.rating, "reviews", "rating", "number", true)}{row(c.reviewCount, "reviews", "total_reviews")}{row(c.newReviews, "reviews", "new_reviews_7d")}</div></MetricTile>
        <div className="min-w-0 space-y-3"><MetricTile {...tileProps(9, "scheduler", c.scheduler, "runs_24h")}><div className="space-y-4"><div className="grid grid-cols-2 gap-3">{row(`${c.lastDay} · ${c.runs}`, "scheduler", "runs_24h", "number", true)}{row(c.failedRuns, "scheduler", "failures_24h")}</div>{row(c.failedJob, "scheduler", "last_failure_name", "text")}{row(c.lastFailure, "scheduler", "last_failure_at", "date")}<p className="text-xs text-stone-500">{c.noSchedule}</p></div></MetricTile>{errorsSection && <details className="staff-panel p-4"><summary className="cursor-pointer text-sm font-semibold">{c.existingSystem}</summary><div className="mt-3 min-w-0">{errorsSection}</div></details>}</div>
        <div className="min-w-0 space-y-3"><MetricTile {...tileProps(10, "supabase", c.supabase, "last_clover_import_at")}><div className="space-y-4">{row(c.lastCloverImport, "supabase", "last_clover_import_at", "date")}{row(c.importSource, "supabase", "last_clover_import_source", "text")}<div className="grid grid-cols-2 gap-3">{row(c.pendingSignups, "supabase", "pending_signups")}{row(`${c.lastSeven} · ${c.failedRecords}`, "supabase", "failed_records_7d")}</div></div></MetricTile>{detailsSection && <details className="staff-panel p-4"><summary className="cursor-pointer text-sm font-semibold">{c.existingSystemHelp}</summary><div className="mt-3 min-w-0">{detailsSection}</div></details>}</div>
      </div>
      <div className="min-w-0 space-y-4"><ActionColumn dashboard={dashboard} connections={connections} actions={actions} selectedAction={selectedAction === "collect" ? null : selectedAction} onSelectAction={setSelectedAction} onRequest={onRequest} busy={busy} blocked={writeBlocked} backendPending={backendPending} /><ActionLog actions={actions} loading={loading} onDownload={onDownload} onResume={onResume} identity={identity} busy={busy} /></div>
    </div>
    {children}
    <section className="staff-panel p-4" aria-label={c.tools}><h2 className="text-sm font-semibold">{c.tools}</h2><div className="mt-3 flex flex-wrap gap-x-5 gap-y-3">{Object.entries(staffLinks).map(([key, link]) => <a key={key} className="text-xs font-medium text-brand-dark underline" href={link.href} target="_blank" rel="noopener noreferrer">{link.label} ↗</a>)}</div><p className="mt-3 text-xs text-stone-500">{c.toolAccount}</p></section>
  </div>;
}

function Datum({ label, metric, format = "number", prominent = false, compact = false }: { label: string; metric: OpsMetric | undefined; format?: Format; prominent?: boolean; compact?: boolean }) {
  const number = metric?.value_num;
  const text = format === "money" ? opsCurrency(number) : format === "percent" ? opsPercent(number) : format === "text" ? metric?.value_text || "—" : format === "date" ? staffDisplayDate(metric?.value_text) : format === "up" ? number === 1 ? c.up : number === 0 ? c.down : "—" : opsMetricNumber(number, metric?.source, metric?.metric);
  if (compact) return <span title={metric ? `${staffDisplayDate(metric.collected_at)} · ${metric.period_start || "—"} – ${metric.period_end || "—"}` : c.snapshotMissing}>{text}</span>;
  return <div className="min-w-0"><p className="text-xs text-stone-500">{label}</p><p className={`mt-1 break-words font-semibold ${prominent ? "text-3xl tracking-tight" : "text-lg"}`}>{text}</p>{metric && <p className="mt-1 text-[10px] leading-relaxed text-stone-500">{metric.period_start && <>{staffDisplayDate(metric.period_start)}{metric.period_end && metric.period_end !== metric.period_start ? ` – ${staffDisplayDate(metric.period_end)}` : ""} · </>}{opsAge(metric.collected_at)}</p>}</div>;
}
