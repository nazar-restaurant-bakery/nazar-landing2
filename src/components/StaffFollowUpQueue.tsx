import { useCallback, useEffect, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { crmDisplayDate, crmLocalInput, crmRequestError, safeCrmRequest } from "../lib/crmUi";
import { crmQueues, validCrmQueue, type CrmQueue, type CrmQueueItem, type CrmQueueName } from "../lib/crmQueue";

const flags: Record<string, string> = {
  overdue: "Overdue", missing_owner: "Assignee missing", missing_followup: "Follow-up time missing", decision: "Awaiting Yücel",
};
export default function StaffFollowUpQueue({ client, refreshKey, onChanged }: {
  client: SupabaseClient; refreshKey: unknown; onChanged: () => void;
}) {
  const [queue, setQueue] = useState<CrmQueueName>("open_catering");
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<CrmQueue | null>(null);
  const [reading, setReading] = useState(true);
  const [writing, setWriting] = useState(false);
  const [message, setMessage] = useState("");
  const [draft, setDraft] = useState<{ item: CrmQueueItem; status: string; owner: string; due: string } | null>(null);
  const sequence = useRef(0);
  const alive = useRef(true);
  const writePending = useRef(false);
  const refresh = useCallback(async () => {
    const current = ++sequence.current;
    setReading(true); setData(null);
    const result = await safeCrmRequest(() => client.rpc("crm_follow_up_queue_v1", { p_queue: queue, p_offset: offset }));
    if (!alive.current || current !== sequence.current) return;
    const valid = !result.error && validCrmQueue(result.data, queue, offset);
    if (valid && offset > 0 && offset >= result.data.total) {
      setOffset(Math.max(0, Math.floor((result.data.total - 1) / 25) * 25)); return;
    }
    setData(valid ? result.data : null);
    setReading(false);
  }, [client, queue, offset]);
  useEffect(() => {
    alive.current = true;
    queueMicrotask(() => { if (alive.current) void refresh(); });
    return () => { alive.current = false; sequence.current += 1; };
  }, [refresh, refreshKey]);

  function changeQueue(next: CrmQueueName, page = 0) {
    if (next === queue && page === offset) { setDraft(null); setMessage(""); void refresh(); return; }
    sequence.current += 1;
    setData(null); setDraft(null); setMessage(""); setQueue(next); setOffset(page);
  }
  async function update(item: CrmQueueItem, request?: { status: string; owner: string; due: string }) {
    if (writePending.current || reading) return;
    if (request) {
      const error = crmRequestError(request.status, request.owner, request.due);
      if (error) { setMessage(error); return; }
    }
    writePending.current = true; setWriting(true); setMessage("");
    const result = await safeCrmRequest(() => request
      ? client.rpc("crm_update_catering", { p_request_id: item.id, p_status: request.status,
        p_assigned_to: request.owner.trim(), p_follow_up_at: request.due ? new Date(request.due).toISOString() : null })
      : client.rpc("crm_complete_task_v1", { p_task_id: item.id }));
    writePending.current = false;
    if (!alive.current) return;
    setWriting(false);
    if (result.error || result.data !== true) {
      setMessage("Could not confirm the save. Refresh the queue before retrying."); return;
    }
    setDraft(null); setMessage(request ? "Request saved." : "Task completed.");
    // A completed/closed item can remove the final row on the current page.
    if (offset > 0) changeQueue(queue, 0); else await refresh();
    onChanged();
  }
  const busy = reading || writing;
  return <section aria-label="General follow-up queue" className="mb-5 rounded-xl border border-[#dfe7df] bg-white p-4 sm:p-5">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-lg font-semibold">General follow-up queue</h2>
      <button type="button" disabled={busy} onClick={() => { setMessage(""); setDraft(null); void refresh(); }} className="text-sm font-semibold text-green-800 underline disabled:opacity-50">Refresh queue</button>
    </div>
    <p className="mt-2 text-sm text-stone-600">All open Nazar work. Customer search and filters do not change this queue. Closed requests, completed tasks and test-only customer profiles are excluded. Categories overlap; do not add their counts together.</p>
    <div className="mt-3 flex flex-wrap gap-2" aria-label="Follow-up categories">{crmQueues.map(([key, label]) =>
      <button key={key} type="button" aria-pressed={queue === key} disabled={writing} onClick={() => changeQueue(key)} className={`rounded-lg border px-3 py-2 text-sm disabled:opacity-50 ${queue === key ? "border-green-800 bg-green-800 text-white" : "border-[#dfe7df]"}`}>
        {label}{data ? ` (${data.counts[key]})` : ""}
      </button>)}</div>
    {reading && <p role="status" className="mt-3 text-sm">Loading follow-up queue…</p>}
    {!reading && !data && <p role="status" className="mt-3 text-sm text-red-700">Follow-up queue unavailable. Refresh to retry; totals are unknown.</p>}
    {data && <>
      <p className="mt-3 text-xs text-stone-600">{data.total === 0 ? "0 matching items" : `Showing ${offset + 1}–${Math.min(offset + data.items.length, data.total)} of ${data.total}`} · Checked {crmDisplayDate(data.generated_at)} (your device time). Overdue means a recorded time earlier than this check; no date is shown separately.</p>
      {data.total === 0 && <p className="mt-3 text-sm">No matching open work in this category.</p>}
      <div className="max-h-[32rem] overflow-auto" aria-label="Queue items">{data.items.map(item => <article key={item.id} className="mt-3 rounded-lg border border-[#dfe7df] p-3 text-sm">
        <p><strong>{item.customer_name || "Unnamed customer"}</strong> · {item.title}</p>
        <p className="mt-1 text-stone-600">{item.request_status ? `${item.request_status} · ` : ""}Assigned to: {item.assigned_to?.trim() || "Not assigned"} · Follow-up: {crmDisplayDate(item.due_at)}</p>
        <p className="mt-1 text-xs text-stone-500">Created {crmDisplayDate(item.created_at)} · Reference {item.id.slice(0, 8)}</p>
        <div className="mt-2 flex flex-wrap gap-2">{item.flags.map(flag => <span key={flag} className="rounded bg-amber-100 px-2 py-1 text-xs text-amber-950">{flags[flag]}</span>)}</div>
        {item.kind === "task" && <button type="button" disabled={busy} onClick={() => void update(item)} className="mt-2 font-semibold text-green-800 underline disabled:opacity-50">Mark task done</button>}
        {item.kind === "request" && <button type="button" disabled={busy} onClick={() => { setMessage(""); setDraft({ item, status: item.request_status || "new", owner: item.assigned_to || "", due: crmLocalInput(item.due_at) }); }} className="mt-2 font-semibold text-green-800 underline disabled:opacity-50">Update request</button>}
        {item.kind === "decision" && <p className="mt-2 text-xs text-stone-600">Yücel's response is required. This queue does not record a price/menu decision or send email.</p>}
        {draft?.item.id === item.id && <form onSubmit={event => { event.preventDefault(); void update(item, draft); }} className="mt-3 grid gap-3 sm:grid-cols-2">
          <label>Status<select value={draft.status} onChange={event => setDraft({ ...draft, status: event.target.value })} className="mt-1 w-full rounded-lg border p-2">{["new", "contacted", "quoted", "won", "lost", "closed"].map(status => <option key={status}>{status}</option>)}</select></label>
          <label>Assigned to<input required maxLength={100} value={draft.owner} onChange={event => setDraft({ ...draft, owner: event.target.value })} className="mt-1 w-full rounded-lg border p-2" /></label>
          <label>Next follow-up (your device time)<input type="datetime-local" value={draft.due} onChange={event => setDraft({ ...draft, due: event.target.value })} className="mt-1 w-full rounded-lg border p-2" /></label>
          <div className="flex items-end gap-3"><button disabled={busy} className="rounded-lg bg-green-800 px-3 py-2 text-white disabled:opacity-50">Save queue request</button><button type="button" disabled={busy} onClick={() => setDraft(null)} className="underline">Cancel</button></div>
        </form>}
      </article>)}</div>
      <div className="mt-3 flex gap-4"><button type="button" disabled={busy || offset === 0} onClick={() => changeQueue(queue, Math.max(0, offset - 25))} className="text-sm font-semibold text-green-800 underline disabled:opacity-50">Previous queue page</button><button type="button" disabled={busy || offset + data.items.length >= data.total} onClick={() => changeQueue(queue, offset + 25)} className="text-sm font-semibold text-green-800 underline disabled:opacity-50">Next queue page</button></div>
    </>}
    {message && <p role="status" className="mt-3 text-sm text-amber-900">{message}</p>}
  </section>;
}
