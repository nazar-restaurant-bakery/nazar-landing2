import type { ReactNode } from "react";
import type { CateringRequest, Customer, EmailState, TaskState } from "../../lib/crmData";
import { staffCopy as c } from "../../lib/staffCopy";
import { staffDisplayDate } from "../../lib/staffUi";
import StatusBadge from "./StatusBadge";

type Props = { customer: Customer; requests: CateringRequest[]; tasks: TaskState | undefined; tasksLoading: boolean; emailState: EmailState | undefined; onCompleteTask: (id: string) => Promise<boolean>; onOpenRequest: (id: string) => void; busy: boolean; writeBlocked: boolean };
type Event = { id: string; date: string | null; title: string; icon: string; content: ReactNode };

export default function Timeline({ customer, requests, tasks, tasksLoading, emailState, onCompleteTask, onOpenRequest, busy, writeBlocked }: Props) {
  const events: Event[] = [
    ...customer.recent_signups.map(signup => ({ id: `signup-${signup.id}`, date: signup.created_at, title: c.signup, icon: "↗", content: <><p className="break-words">{c.sourceFilter}: {signup.source || "—"}</p>{signup.campaign && <p className="break-words">{c.campaign}: {signup.campaign}</p>}<p className="mt-2 text-xs text-stone-500">{c.consentEmail}: — · {c.consentSms}: —</p></> })),
    ...customer.notes.map(note => ({ id: `note-${note.id}`, date: note.created_at, title: c.note, icon: "✎", content: <><p className="whitespace-pre-wrap break-words">{note.body}</p><p className="mt-2 text-xs text-stone-500">{note.author_id && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(note.author_id) ? `${c.staffAccount} ${note.author_id.slice(0, 8)}` : `${c.staffAccount}: —`}</p></> })),
    ...requests.map(request => ({ id: `request-${request.id}`, date: request.created_at, title: c.request, icon: "▦", content: <><StatusBadge value={request.status} kind="request" /><p className="mt-2">{c.eventDate}: {staffDisplayDate(request.event_date)} · {c.guests}: {request.guests ?? "—"}</p><button className="mt-2 text-xs font-semibold text-brand-dark underline" type="button" onClick={() => onOpenRequest(request.id)}>{c.catering}</button></> })),
    ...(tasks?.unavailable ? [] : tasks?.items || []).map(task => ({ id: `task-${task.id}`, date: task.completed_at || task.created_at || task.due_at, title: c.tasks, icon: "✓", content: <><p className={`break-words font-medium ${task.completed_at ? "text-stone-500 line-through" : ""}`}>{task.title}</p><p className="mt-1">{c.owner}: {task.assigned_to || "—"}</p><p className="mt-1">{c.due}: {staffDisplayDate(task.due_at)}</p>{!task.created_at && !task.completed_at && <p className="mt-1 text-xs text-stone-500">{c.taskCreatedUnknown}</p>}<div className="mt-2 flex items-center justify-between gap-2"><span className="text-xs text-stone-500">{task.completed_at ? c.completed : c.open}</span>{!task.completed_at && <button type="button" disabled={busy || writeBlocked} onClick={() => void onCompleteTask(task.id)} className="staff-button staff-secondary">{c.complete}</button>}</div></> })),
  ];
  const result = emailState?.result;
  if (result?.checkedAt && result.status !== "unavailable") events.push({ id: "klaviyo-current", date: result.checkedAt, title: c.observation, icon: "@", content: <><StatusBadge value={result.status} /><p className="mt-2 text-xs text-stone-500">{result.synced ? c.observationSaved : c.observationUnsaved}</p></> });
  if (!result?.synced && result?.saved) events.push({ id: "klaviyo-saved", date: result.saved.checkedAt, title: c.previousObservation, icon: "@", content: <><StatusBadge value={result.saved.status} /><p className="mt-2 text-xs text-stone-500">{c.previousObservation}</p></> });
  events.sort((a, b) => (Date.parse(b.date || "") || 0) - (Date.parse(a.date || "") || 0));

  return <div className="p-4" aria-label={c.timeline}>
    <div className="mb-4 flex items-baseline justify-between gap-2"><h3 className="font-semibold">{c.timeline}</h3><span className="text-xs text-stone-500">{events.length}</span></div>
    <p className="mb-4 rounded-lg border border-brand-border bg-brand-bg p-3 text-xs text-stone-600">{c.consentUnavailable}</p>
    {tasksLoading && !tasks && <div className="staff-skeleton mb-3" role="status" aria-label={c.loading} />}
    {tasks?.unavailable && <p role="status" className="mb-3 text-sm text-stone-600">{c.taskUnavailable}</p>}
    <ol className="space-y-3">{events.map(event => <li key={event.id} className="flex min-w-0 gap-3"><span className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-brand-border bg-brand-primarySoft text-sm text-brand-dark" aria-hidden="true">{event.icon}</span><article className="min-w-0 flex-1 rounded-lg border border-brand-border p-3 text-sm"><div className="mb-2 flex flex-wrap items-baseline justify-between gap-1"><h4 className="font-semibold">{event.title}</h4><time className="text-[11px] text-stone-500">{staffDisplayDate(event.date)}</time></div>{event.content}</article></li>)}</ol>
    {!events.length && <p className="text-sm text-stone-600">{c.noActivity}</p>}
  </div>;
}
