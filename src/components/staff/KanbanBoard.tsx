import type { CateringRequest } from "../../lib/crmData";
import { staffCopy as c, staffStatuses } from "../../lib/staffCopy";
import { customerName, staffDisplayDate } from "../../lib/staffUi";
import StatusBadge from "./StatusBadge";

export default function KanbanBoard({ requests, selectedId, onSelect, onMove, disabled }: {
  requests: CateringRequest[]; selectedId: string | null; onSelect: (id: string) => void;
  onMove: (id: string, status: string) => void; disabled: boolean;
}) {
  return <div className="min-w-0 overflow-x-auto pb-2" aria-label={c.kanban}>
    <div className="grid min-w-[1100px] grid-cols-6 gap-3">
      {Object.entries(staffStatuses).map(([status, label]) => <section key={status} data-status={status} aria-label={label}
        onDragOver={event => { if (!disabled && event.dataTransfer.types.includes("text/plain")) event.preventDefault(); }}
        onDrop={event => { event.preventDefault(); if (!disabled) { const id = event.dataTransfer.getData("text/plain"); if (requests.some(request => request.id === id)) onMove(id, status); } }}
        className="min-h-72 rounded-lg border border-brand-border bg-brand-bg p-2">
        <h3 className="mb-3 flex items-center justify-between text-xs font-semibold">{label}<span className="rounded bg-white px-1.5 py-0.5">{requests.filter(r => r.status === status).length}</span></h3>
        <div className="space-y-2">{requests.filter(request => request.status === status).map(request => <article key={request.id} draggable={!disabled}
          onDragStart={event => { if (disabled) { event.preventDefault(); return; } event.dataTransfer.setData("text/plain", request.id); event.dataTransfer.effectAllowed = "move"; }}
          className={`rounded-lg border bg-white p-3 text-xs ${selectedId === request.id ? "border-brand" : "border-brand-border"}`} data-request-id={request.id}>
          <button type="button" onClick={() => onSelect(request.id)} className="block w-full break-words text-left font-semibold">{customerName(request)}</button>
          <p className="mt-2">{c.eventDate}: {staffDisplayDate(request.event_date)}</p><p>{c.guests}: {request.guests ?? "—"}</p>
          <p className="mt-2 text-stone-600">{c.owner}: {request.assigned_to || "—"}</p>
          <p className={request.follow_up_at && Date.parse(request.follow_up_at) < Date.now() && ["new", "contacted", "quoted"].includes(request.status) ? "mt-1 text-red-800" : "mt-1 text-stone-600"}>{c.due}: {staffDisplayDate(request.follow_up_at)}</p>
          {(request.guests ?? 0) > 50 && <p className="mt-2 rounded-lg bg-amber-50 p-1.5 text-amber-800">{c.capacity}</p>}
          <label className="mt-3 block"><span className="sr-only">{c.moveStatus} · {customerName(request)}</span><select aria-label={`${c.moveStatus} · ${customerName(request)}`} className="staff-input !p-1 !text-xs" value={request.status} disabled={disabled} onChange={event => onMove(request.id, event.target.value)}>{Object.entries(staffStatuses).map(([key, text]) => <option key={key} value={key}>{text}</option>)}</select></label>
        </article>)}</div>
      </section>)}
    </div>
  </div>;
}

export function CateringList({ requests, selectedId, onSelect }: { requests: CateringRequest[]; selectedId: string | null; onSelect: (id: string) => void }) {
  return <div className="space-y-2">{requests.map(request => <button type="button" key={request.id} onClick={() => onSelect(request.id)} className={`staff-panel grid w-full gap-2 p-3 text-left sm:grid-cols-[1fr_1fr_auto] ${selectedId === request.id ? "!border-brand" : ""}`}><span><strong className="block text-sm">{customerName(request)}</strong><span className="text-xs text-stone-600">{request.assigned_to || "—"} · {request.guests ?? "—"} {c.guests}</span></span><span className="text-xs">{staffDisplayDate(request.event_date)}<span className="block text-stone-600">{staffDisplayDate(request.follow_up_at)}</span></span><span><StatusBadge value={request.status} kind="request" />{(request.guests ?? 0) > 50 && <span className="mt-1 block text-xs text-amber-800">{c.capacity}</span>}</span></button>)}</div>;
}
