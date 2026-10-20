import type { CrmQueue, CrmQueueItem, CrmQueueName } from "../../lib/crmQueue";
import { staffCopy as c } from "../../lib/staffCopy";
import { staffDateGroup, staffDisplayDate } from "../../lib/staffUi";
import StatusBadge from "../../components/staff/StatusBadge";

type Props = {
  data: CrmQueue | null; loading: boolean; owner: string;
  onOwnerChange: (value: string) => void;
  onPage: (offset: number) => void;
  onQueue: (queue: CrmQueueName) => void;
  queue: CrmQueueName;
  onOpenCustomer: (id: string) => void;
  onOpenRequest: (id: string) => void;
  onComplete: (id: string) => Promise<boolean>;
  busy: boolean; writeBlocked: boolean;
};

const queueLabels = (): [CrmQueueName, string][] => [
  ["open_tasks", c.openTasks], ["overdue_tasks", c.overdueTasks],
  ["open_catering", c.openCatering], ["overdue_catering", c.overdueCatering],
  ["missing_owner", c.missingOwner], ["missing_followup", c.missingFollowup],
  ["pending_decisions", c.awaitingDecision],
];

function itemTitle(item: CrmQueueItem) {
  // The queue's request title is a fixed English server label, not customer text.
  return item.kind === "request" ? c.request : item.title;
}

export default function TasksView({ data, loading, owner, onOwnerChange, onPage, onQueue,
  queue, onOpenCustomer, onOpenRequest, onComplete, busy, writeBlocked }: Props) {
  const disabled = busy || loading;
  const owners = [...new Set(["Talip", "Yücel", ...(data?.items.map(item => item.assigned_to?.trim()).filter((value): value is string => !!value) ?? []), ...(owner ? [owner] : [])])];
  const items = data?.items.filter(item => !owner || item.assigned_to?.trim() === owner) ?? [];
  const now = new Date();
  const groups = ["overdue", "today", "thisWeek", "later", "undated"] as const;
  const flags: Record<string, string> = { overdue: c.overdue, missing_owner: c.missingOwner,
    missing_followup: c.missingFollowup, decision: c.awaitingDecision };

  return <section aria-labelledby="staff-tasks-title" className="min-w-0 space-y-4">
    <div className="staff-panel p-4 sm:p-5">
      <h1 id="staff-tasks-title" className="text-xl font-semibold">{c.tasks}</h1>
      <p className="mt-2 text-sm text-stone-600">{c.queueRealOnly}</p>
      <nav aria-label={c.queueCategories} className="mt-4 flex flex-wrap gap-2">
        {queueLabels().map(([value, label]) => <button key={value} type="button"
          disabled={disabled} aria-pressed={queue === value} onClick={() => onQueue(value)}
          className={queue === value ? "staff-button" : "staff-button staff-secondary"}>
          {label}{data && !loading ? ` (${data.counts[value]})` : ""}
        </button>)}
      </nav>
      <div className="mt-4 max-w-xs">
        <label htmlFor="staff-task-owner-filter" className="staff-label">{c.owner}</label>
        <select id="staff-task-owner-filter" className="staff-input" value={owner}
          disabled={disabled} onChange={event => onOwnerChange(event.target.value)}>
          <option value="">{c.all}</option>
          {owners.map(value => <option key={value} value={value}>{value}</option>)}
        </select>
      </div>
      <p className="mt-2 text-xs text-stone-600">{c.filterPageOnly} {c.knownPage}</p>
      <p className="mt-2 text-xs text-stone-600">{c.queueOverlap}</p>
      {data && !loading && <p className="mt-2 text-xs text-stone-600">
        {c.page} {Math.floor(data.offset / data.page_size) + 1} · {data.items.length} {c.records} · {c.total} {data.total} · {c.asOf} {staffDisplayDate(data.generated_at)}
      </p>}
    </div>

    {loading ? <div className="staff-panel p-4 sm:p-5 space-y-3" role="status" aria-label={c.loading}>
      {[0, 1, 2].map(value => <div key={value} className="h-16 animate-pulse rounded-lg bg-brand-primarySoft" />)}
    </div> : !data ? <div className="staff-panel p-4 sm:p-5" role="status">{c.unavailable}</div>
      : items.length === 0 ? <div className="staff-panel p-4 sm:p-5">{c.noMatchingWork}</div>
        : groups.map(group => {
          const entries = items.filter(item => staffDateGroup(item.due_at, now) === group);
          if (!entries.length) return null;
          return <section key={group} aria-labelledby={`staff-tasks-${group}`} className="staff-panel p-4 sm:p-5">
            <h2 id={`staff-tasks-${group}`} className="font-semibold">{c[group]} <span className="text-sm font-normal text-stone-600">({entries.length})</span></h2>
            <div className="mt-3 divide-y divide-brand-border">{entries.map(item => <article key={`${item.kind}:${item.id}`} className="py-3 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <button type="button" onClick={() => onOpenCustomer(item.customer_id)}
                    className="max-w-full break-words text-left font-semibold text-brand-primary underline underline-offset-2"
                    title={c.openCustomer}>{item.customer_name || c.noName}</button>
                  <p className="mt-1 break-words text-sm">{itemTitle(item)}</p>
                  <p className={`mt-1 text-xs ${group === "overdue" ? "text-red-800" : "text-stone-600"}`}>
                    {c.owner}: {item.assigned_to?.trim() || "—"} · {c.due}: {staffDisplayDate(item.due_at)}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {item.request_status && <StatusBadge kind="request" value={item.request_status} />}
                    {item.flags.map(flag => <span key={flag} className="rounded-lg border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs text-amber-800">{flags[flag] || "—"}</span>)}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {item.kind === "task" ? <button type="button" disabled={disabled || writeBlocked}
                    onClick={() => { void onComplete(item.id); }} className="staff-button staff-secondary">{c.complete}</button>
                    : <button type="button" onClick={() => onOpenRequest(item.request_id || item.id)}
                      className="staff-button staff-secondary">{c.openRequest}</button>}
                </div>
              </div>
            </article>)}</div>
          </section>;
        })}

    {data && !loading && <div className="flex flex-wrap items-center justify-between gap-3">
      <button type="button" className="staff-button staff-secondary" disabled={disabled || data.offset === 0}
        onClick={() => onPage(Math.max(0, data.offset - data.page_size))}>{c.previous}</button>
      <span className="text-xs text-stone-600">{c.knownPage}</span>
      <button type="button" className="staff-button staff-secondary" disabled={disabled || data.offset + data.items.length >= data.total}
        onClick={() => onPage(data.offset + data.page_size)}>{c.next}</button>
    </div>}
  </section>;
}
