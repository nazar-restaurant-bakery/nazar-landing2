import { useState, type FormEvent } from "react";
import type { EmailState, Overview, TaskState } from "../../lib/crmData";
import { staffCopy as c } from "../../lib/staffCopy";
import { customerName, staffInputIso, staffTaskError } from "../../lib/staffUi";
import AssigneeField from "../../components/staff/AssigneeField";
import RecordList from "../../components/staff/RecordList";
import RecordCard from "../../components/staff/RecordCard";
import Timeline from "../../components/staff/Timeline";

export interface CustomersViewProps {
  overview: Overview;
  selectedId: string | null;
  onSelect: (id: string) => void;
  tasksByCustomer: Record<string, TaskState>;
  tasksLoading: boolean;
  emailStates: Record<string, EmailState>;
  onRefreshEmail: (id: string) => void;
  onAddNote: (customerId: string, body: string) => Promise<boolean>;
  onCreateTask: (customerId: string, title: string, owner: string, due: string) => Promise<boolean>;
  onCompleteTask: (id: string) => Promise<boolean>;
  onOpenRequest: (id: string) => void;
  busy: boolean;
  writeBlocked: boolean;
}
type Draft = { note: string; title: string; owner: string; due: string; taskOpen: boolean; error: string };
const blankDraft = (): Draft => ({ note: "", title: "", owner: "", due: "", taskOpen: false, error: "" });

export default function CustomersView(props: CustomersViewProps) {
  const { overview, selectedId, onSelect, tasksByCustomer, tasksLoading, emailStates, onRefreshEmail, onAddNote, onCreateTask, onCompleteTask, onOpenRequest, busy, writeBlocked } = props;
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [view, setView] = useState<{ id: string | null; value: "list" | "profile" | "timeline" }>({ id: selectedId, value: selectedId ? "timeline" : "list" });
  const [submitting, setSubmitting] = useState(false);
  const customer = overview.customers.find(item => item.id === selectedId);
  const mobileView = customer ? (view.id === selectedId ? view.value : "timeline") : "list";
  const draft = customer ? drafts[customer.id] || blankDraft() : blankDraft();
  const disabled = busy || submitting || writeBlocked;
  const requests = overview.requests.filter(request => request.customer_id === customer?.id);
  const patch = (customerId: string, values: Partial<Draft>) => setDrafts(previous => ({ ...previous, [customerId]: { ...(previous[customerId] || blankDraft()), ...values } }));
  async function addNote(event: FormEvent) {
    event.preventDefault();
    if (!customer || disabled) return;
    const customerId = customer.id;
    if (!draft.note.trim() || draft.note.trim().length > 2000) { patch(customerId, { error: c.noteError }); return; }
    patch(customerId, { error: "" }); setSubmitting(true);
    try { if (await onAddNote(customerId, draft.note.trim())) patch(customerId, { note: "" }); }
    catch { patch(customerId, { error: c.unknownSave }); }
    finally { setSubmitting(false); }
  }
  async function createTask(event: FormEvent) {
    event.preventDefault();
    if (!customer || disabled) return;
    const customerId = customer.id;
    const error = staffTaskError(draft.title, draft.owner, draft.due);
    if (error) { patch(customerId, { error }); return; }
    patch(customerId, { error: "" }); setSubmitting(true);
    try {
      if (await onCreateTask(customerId, draft.title.trim(), draft.owner.trim(), staffInputIso(draft.due)!)) patch(customerId, { title: "", owner: "", due: "", taskOpen: false });
    } catch { patch(customerId, { error: c.unknownSave }); }
    finally { setSubmitting(false); }
  }
  return <section aria-label={c.customers} className="min-w-0">
    <div className="mb-3 flex min-w-0 flex-wrap items-center gap-2 lg:hidden" aria-label={c.selectedCustomer}>
      {(["list", "profile", "timeline"] as const).map(item => <button type="button" key={item} className={`staff-button ${mobileView === item ? "" : "staff-secondary"} ${item === "profile" ? "md:hidden" : ""}`} disabled={!customer && item !== "list"} onClick={() => setView({ id: selectedId, value: item })} aria-pressed={mobileView === item}>{item === "list" ? `← ${c.list}` : c[item]}</button>)}
    </div>
    <div className="grid min-w-0 items-start gap-4 md:grid-cols-[minmax(0,1fr)_290px] lg:grid-cols-[260px_minmax(0,1fr)_290px]">
      <div className={`${mobileView === "list" ? "block md:col-span-2" : "hidden"} lg:col-span-1 lg:block`}><RecordList overview={overview} selectedId={selectedId} onSelect={id => { onSelect(id); setView({ id, value: "timeline" }); }} tasksByCustomer={tasksByCustomer} emailStates={emailStates} /></div>
      {customer ? <>
        <section className={`staff-panel ${mobileView === "timeline" ? "block" : "hidden"} ${mobileView !== "list" ? "md:block" : ""} lg:block`}>
          <header className="border-b border-brand-border px-4 py-3"><p className="text-xs text-stone-500">{c.selectedCustomer}</p><h2 className="mt-1 break-words font-semibold">{customerName(customer)}</h2></header>
          <div className="border-b border-brand-border bg-brand-bg p-4">
            <form onSubmit={addNote}><label htmlFor="customer-note" className="staff-label">{c.addNote}</label><textarea id="customer-note" className="staff-input min-h-20 resize-y" maxLength={2000} value={draft.note} disabled={busy || submitting} onChange={event => patch(customer.id, { note: event.target.value, error: "" })} placeholder={c.notePlaceholder} /><div className="mt-2 flex flex-wrap gap-2"><button type="submit" className="staff-button" disabled={disabled || !draft.note.trim()}>{submitting ? c.saving : c.addNote}</button><button type="button" className="staff-button staff-secondary" disabled={busy || submitting} onClick={() => patch(customer.id, { taskOpen: !draft.taskOpen, error: "" })} aria-expanded={draft.taskOpen}>{c.createTask}</button></div></form>
            {draft.taskOpen && <form onSubmit={createTask} className="mt-4 space-y-3 rounded-lg border border-brand-border bg-white p-3" aria-label={c.createTask}><label htmlFor="customer-task-title" className="block text-xs font-semibold">{c.taskTitle}<input id="customer-task-title" className="staff-input mt-1" required maxLength={300} value={draft.title} disabled={busy || submitting} onChange={event => patch(customer.id, { title: event.target.value, error: "" })} /></label><AssigneeField id="customer-task-owner" value={draft.owner} disabled={busy || submitting} onChange={owner => patch(customer.id, { owner, error: "" })} /><label htmlFor="customer-task-due" className="block text-xs font-semibold">{c.due}<input id="customer-task-due" className="staff-input mt-1" type="datetime-local" required value={draft.due} disabled={busy || submitting} onChange={event => patch(customer.id, { due: event.target.value, error: "" })} /></label><div className="flex gap-2"><button type="submit" className="staff-button" disabled={disabled}>{submitting ? c.saving : c.createTask}</button><button type="button" className="staff-button staff-secondary" disabled={busy || submitting} onClick={() => patch(customer.id, { taskOpen: false, error: "" })}>{c.cancel}</button></div></form>}
            {(draft.error || writeBlocked) && <p className="mt-3 text-sm text-red-800" role="alert">{draft.error || c.refreshFirst}</p>}
          </div>
          <Timeline customer={customer} requests={requests} tasks={tasksByCustomer[customer.id]} tasksLoading={tasksLoading} emailState={emailStates[customer.id]} onCompleteTask={onCompleteTask} onOpenRequest={onOpenRequest} busy={busy || submitting} writeBlocked={writeBlocked} />
        </section>
        <div className={`${mobileView === "profile" ? "block" : "hidden"} ${mobileView !== "list" ? "md:block" : ""} lg:block`}><RecordCard customer={customer} requests={requests} tasks={tasksByCustomer[customer.id]} tasksLoading={tasksLoading} emailState={emailStates[customer.id]} onRefreshEmail={onRefreshEmail} onOpenRequest={onOpenRequest} onCompleteTask={onCompleteTask} busy={busy || submitting} writeBlocked={writeBlocked} /></div>
      </> : <div className="staff-panel p-8 text-sm text-stone-600 md:col-span-2 lg:col-span-2">{c.selectCustomer}</div>}
    </div>
    <p className="mt-4 text-xs text-stone-500">{c.knownHistory}</p>
  </section>;
}
