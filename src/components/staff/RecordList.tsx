import { useState } from "react";
import type { Customer, EmailState, Overview, TaskState } from "../../lib/crmData";
import { staffCopy as c, staffEmailLabels } from "../../lib/staffCopy";
import { activityTime, customerName, staffDisplayDate } from "../../lib/staffUi";
import StatusBadge from "./StatusBadge";

type Props = {
  overview: Overview;
  selectedId: string | null;
  onSelect: (id: string) => void;
  tasksByCustomer: Record<string, TaskState>;
  emailStates: Record<string, EmailState>;
};

function latestActivity(customer: Customer, overview: Overview, tasks: TaskState | undefined, email: EmailState | undefined) {
  const dates = [...(tasks?.items || []).flatMap(task => [task.created_at, task.completed_at]), email?.result?.checkedAt];
  return Math.max(activityTime(customer, overview), ...dates.map(value => value ? Date.parse(value) : 0).filter(Number.isFinite));
}

export default function RecordList({ overview, selectedId, onSelect, tasksByCustomer, emailStates }: Props) {
  const [query, setQuery] = useState("");
  const [email, setEmail] = useState("");
  const [source, setSource] = useState("");
  const [openTask, setOpenTask] = useState(false);
  const [catering, setCatering] = useState(false);
  const sources = [...new Set(overview.customers.flatMap(customer => [customer.last_source, ...customer.recent_signups.map(signup => signup.source)]).filter((value): value is string => !!value))].sort();
  const needle = query.trim().toLocaleLowerCase("tr-TR");
  const customers = overview.customers.filter(customer => {
      if (needle && ![customer.name, customer.email, customer.phone].some(value => value?.toLocaleLowerCase("tr-TR").includes(needle))) return false;
      if (email && customer.email_status !== email) return false;
      if (source && customer.last_source !== source && !customer.recent_signups.some(signup => signup.source === source)) return false;
      if (catering && !overview.requests.some(request => request.customer_id === customer.id)) return false;
      const tasks = tasksByCustomer[customer.id];
      // An unloaded/failed list is unknown, never evidence of zero open tasks.
      if (openTask && tasks && !tasks.unavailable && !tasks.items.some(task => !task.completed_at)) return false;
      return true;
    }).sort((a, b) => latestActivity(b, overview, tasksByCustomer[b.id], emailStates[b.id]) - latestActivity(a, overview, tasksByCustomer[a.id], emailStates[a.id]) || customerName(a).localeCompare(customerName(b), "tr"));
  const unknownTasks = openTask && customers.some(customer => !tasksByCustomer[customer.id] || tasksByCustomer[customer.id].unavailable);

  return <section className="staff-panel flex h-full min-h-0 flex-col" aria-label={c.customers}>
    <div className="space-y-3 border-b border-brand-border p-4">
      <div className="flex items-center justify-between gap-2"><h2 className="font-semibold">{c.customers}</h2><span className="text-xs text-stone-500">{customers.length} {c.customerCount}</span></div>
      <label className="block"><span className="sr-only">{c.search}</span><input type="search" className="staff-input" placeholder={c.search} value={query} onChange={event => setQuery(event.target.value)} /></label>
      <details className="text-sm" open={email !== "" || source !== "" || openTask || catering || undefined}>
        <summary className="cursor-pointer font-medium text-brand-dark">{c.moreFilters}</summary>
        <div className="mt-3 space-y-3">
          <label className="block text-xs">{c.emailFilter}<select className="staff-input mt-1" value={email} onChange={event => setEmail(event.target.value)}><option value="">{c.all}</option>{["subscribed", "pending_review", "not_subscribed", "unsubscribed"].map(status => <option key={status} value={status}>{staffEmailLabels[status]}</option>)}</select></label>
          <label className="block text-xs">{c.sourceFilter}<select className="staff-input mt-1" value={source} onChange={event => setSource(event.target.value)}><option value="">{c.all}</option>{sources.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
          <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={openTask} onChange={event => setOpenTask(event.target.checked)} />{c.openTaskFilter}</label>
          <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={catering} onChange={event => setCatering(event.target.checked)} />{c.cateringFilter}</label>
        </div>
      </details>
      {unknownTasks && <p className="text-xs text-stone-600" role="status">{c.taskFilterUnknown}</p>}
    </div>
    <div className="max-h-[65vh] overflow-y-auto p-2 lg:max-h-[calc(100vh-270px)]">
      {customers.map(customer => {
        const latest = latestActivity(customer, overview, tasksByCustomer[customer.id], emailStates[customer.id]);
        return <button key={customer.id} type="button" aria-current={selectedId === customer.id ? "true" : undefined} onClick={() => onSelect(customer.id)} className={`mb-1 block w-full rounded-lg border p-3 text-left transition-colors ${selectedId === customer.id ? "border-brand bg-brand-primarySoft" : "border-transparent hover:border-brand-border hover:bg-brand-bg"}`}>
          <strong className="block break-words text-sm">{customerName(customer)}</strong>
          <span className="my-1 block break-all text-xs text-stone-600">{customer.email || customer.phone || "—"}</span>
          <StatusBadge value={customer.email_status} />
          <span className="mt-2 block text-[11px] text-stone-500">{c.latestActivity}: {latest ? staffDisplayDate(new Date(latest).toISOString()) : "—"}</span>
        </button>;
      })}
      {!customers.length && <p className="p-3 text-sm text-stone-600">{c.noCustomers}</p>}
    </div>
  </section>;
}
