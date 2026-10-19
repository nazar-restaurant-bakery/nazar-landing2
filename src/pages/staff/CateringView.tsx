import { useState, type FormEvent } from "react";
import type { CateringDecision, CateringNotification, CateringRequest } from "../../lib/crmData";
import { staffCopy as c, staffStatuses } from "../../lib/staffCopy";
import { customerName, staffDateInput, staffDisplayDate, staffRequestError } from "../../lib/staffUi";
import AssigneeField from "../../components/staff/AssigneeField";
import KanbanBoard, { CateringList } from "../../components/staff/KanbanBoard";

export default function CateringView({ requests, selectedId, onSelect, decisions, notifications, busy, writeBlocked, onUpdate, onQuestion }: {
  requests: CateringRequest[]; selectedId: string | null; onSelect: (id: string) => void;
  decisions: CateringDecision[] | null; notifications: CateringNotification[] | null; busy: boolean; writeBlocked: boolean;
  onUpdate: (id: string, status: string, owner: string, due: string) => Promise<boolean>;
  onQuestion: (id: string, question: string) => Promise<boolean>;
}) {
  const [mode, setMode] = useState<"kanban" | "list">("kanban");
  const [move, setMove] = useState<{ id: string; status: string } | null>(null);
  const selected = requests.find(request => request.id === selectedId);
  async function changeStatus(id: string, status: string) {
    const request = requests.find(item => item.id === id);
    if (!request || request.status === status || busy || writeBlocked) return;
    const due = staffDateInput(request.follow_up_at);
    const error = staffRequestError(status, request.assigned_to || "", due);
    if (error) { onSelect(id); setMove({ id, status }); return; }
    const success = await onUpdate(id, status, request.assigned_to || "", due);
    if (!success) { onSelect(id); setMove({ id, status }); }
  }
  return <section aria-label={c.catering} className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-xl font-semibold">{c.catering}</h1><p className="mt-1 text-xs text-stone-600">{c.knownHistory}</p></div><div className="flex gap-2">{(["kanban", "list"] as const).map(value => <button type="button" key={value} aria-pressed={mode === value} className={`staff-button ${mode !== value ? "staff-secondary" : ""}`} onClick={() => setMode(value)}>{value === "kanban" ? c.kanban : c.list}</button>)}</div></div>
    {!requests.length && <p className="staff-panel p-5 text-sm text-stone-600">{c.noRequests}</p>}
    {mode === "kanban" ? <KanbanBoard requests={requests} selectedId={selectedId} onSelect={onSelect} onMove={(id, status) => void changeStatus(id, status)} disabled={busy || writeBlocked} /> : <CateringList requests={requests} selectedId={selectedId} onSelect={onSelect} />}
    {selected ? <RequestPanel key={`${selected.id}:${move?.id === selected.id ? move.status : ""}`} request={selected} initialStatus={move?.id === selected.id ? move.status : selected.status} decisions={decisions} notification={notifications === null ? null : notifications.find(n => n.request_id === selected.id)} busy={busy} writeBlocked={writeBlocked} onUpdate={async (...args) => { const saved = await onUpdate(...args); if (saved) setMove(null); return saved; }} onQuestion={onQuestion} /> : <p className="staff-panel p-5 text-sm text-stone-600">{c.selectRequest}</p>}
  </section>;
}

function RequestPanel({ request, initialStatus, decisions, notification, busy, writeBlocked, onUpdate, onQuestion }: {
  request: CateringRequest; initialStatus: string; decisions: CateringDecision[] | null; notification: CateringNotification | null | undefined;
  busy: boolean; writeBlocked: boolean; onUpdate: (id: string, status: string, owner: string, due: string) => Promise<boolean>; onQuestion: (id: string, question: string) => Promise<boolean>;
}) {
  const [status, setStatus] = useState(initialStatus);
  const [owner, setOwner] = useState(request.assigned_to || "");
  const [due, setDue] = useState(staffDateInput(request.follow_up_at));
  const [question, setQuestion] = useState("");
  const [validation, setValidation] = useState("");
  const pending = decisions?.find(item => item.request_id === request.id && !item.recorded_at);
  async function save(event: FormEvent) {
    event.preventDefault(); const error = staffRequestError(status, owner, due); setValidation(error || "");
    if (!error) await onUpdate(request.id, status, owner.trim(), due);
  }
  async function ask(event: FormEvent) {
    event.preventDefault(); if (!question.trim() || question.trim().length > 1000) { setValidation(c.questionError); return; }
    if (pending || decisions === null) return;
    if (await onQuestion(request.id, question.trim())) setQuestion("");
  }
  return <aside aria-label={c.request} className="staff-panel grid gap-6 p-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,1fr)] lg:p-5">
    <div className="min-w-0"><h2 className="break-words text-lg font-semibold">{customerName(request)}</h2><p className="mt-1 break-all text-xs text-stone-600">{request.email || "—"} · {request.phone || "—"}</p><dl className="mt-4 grid grid-cols-2 gap-3 text-sm"><div><dt className="text-xs text-stone-500">{c.eventDate}</dt><dd>{staffDisplayDate(request.event_date)}</dd></div><div><dt className="text-xs text-stone-500">{c.guests}</dt><dd>{request.guests ?? "—"}</dd></div></dl>{(request.guests ?? 0) > 50 && <p className="mt-3 rounded-lg bg-amber-50 p-2 text-sm text-amber-800">{c.capacity}</p>}<h3 className="mt-4 text-sm font-semibold">{c.message}</h3><p className="mt-2 whitespace-pre-wrap break-words rounded-lg bg-brand-bg p-3 text-sm">{request.message || "—"}</p><h3 className="mt-4 text-sm font-semibold">{c.notification}</h3><p className="mt-1 text-sm">{notification === null ? "—" : !notification?.tracked ? c.notificationUnknown : notification.sent_at ? `${c.notificationSent} · ${staffDisplayDate(notification.sent_at)}` : notification.error ? c.notificationFailed : c.notificationPending}</p></div>
    <div className="min-w-0"><form onSubmit={save} className="grid gap-3 sm:grid-cols-2"><label><span className="staff-label">{c.status}</span><select className="staff-input" value={status} disabled={busy} onChange={event => setStatus(event.target.value)}>{Object.entries(staffStatuses).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><AssigneeField id="request-owner" value={owner} onChange={setOwner} disabled={busy} /><label className="sm:col-span-2"><span className="staff-label">{c.due}</span><input type="datetime-local" className="staff-input" value={due} disabled={busy} onChange={event => setDue(event.target.value)} /></label><div className="sm:col-span-2"><button className="staff-button" disabled={busy || writeBlocked}>{busy ? c.saving : c.save}</button></div></form>
      {validation && <p role="alert" className="mt-2 text-sm text-red-800">{validation}</p>}
      <div className="mt-5 border-t border-brand-border pt-4"><h3 className="text-sm font-semibold">{c.decision}</h3>{decisions === null ? <p className="mt-2 text-sm text-amber-800">{c.decisionUnavailable}</p> : pending ? <div className="mt-2 rounded-lg bg-amber-50 p-3 text-sm"><p className="whitespace-pre-wrap break-words">{pending.question}</p><p className="mt-2 text-xs text-amber-800">{c.pendingDecision}</p><button type="button" className="staff-button staff-secondary mt-2" disabled>{c.askDecision}</button></div> : <form onSubmit={ask} className="mt-2 space-y-2"><label><span className="staff-label">{c.decisionQuestion}</span><textarea className="staff-input" maxLength={1000} value={question} disabled={busy} onChange={event => setQuestion(event.target.value)} /></label><button className="staff-button staff-secondary" disabled={busy || writeBlocked || !question.trim()}>{c.askDecision}</button></form>}{decisions?.filter(item => item.request_id === request.id && item.recorded_at).map(item => <div key={item.id} className="mt-3 rounded-lg bg-brand-bg p-3 text-sm"><p className="text-xs text-stone-600">{c.recordedDecision} · {staffDisplayDate(item.recorded_at)}</p><p className="mt-1 whitespace-pre-wrap break-words">{item.question}</p><p className="mt-2 whitespace-pre-wrap break-words font-medium">{item.decision || "—"}</p></div>)}</div>
    </div>
  </aside>;
}
