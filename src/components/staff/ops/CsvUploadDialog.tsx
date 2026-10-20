import { useState, type FormEvent } from "react";
import { opsCopy as c } from "../../../lib/staffCopy";

export default function CsvUploadDialog({ busy, blocked, onUpload, onClose }: { busy: boolean; blocked: boolean; onUpload: (payload: Record<string, unknown>) => Promise<boolean>; onClose: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [reading, setReading] = useState(false);
  const [error, setError] = useState("");
  const disabled = busy || blocked || reading;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (disabled) return;
    if (!file || !/\.csv$/i.test(file.name) || file.size === 0 || file.size > 1_000_000) { setError(c.csvInvalid); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || !Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)) || new Date(start).toISOString().slice(0, 10) !== start || new Date(end).toISOString().slice(0, 10) !== end || end < start) { setError(c.chooseRequired); return; }
    setReading(true); setError("");
    try {
      const csv = await file.text();
      if (await onUpload({ csv, fileName: file.name, periodStart: start, periodEnd: end })) onClose();
    } catch { setError(c.unknownAction); }
    finally { setReading(false); }
  }
  return <form onSubmit={submit} className="mt-3 space-y-3 rounded-lg border border-brand-border bg-white p-3" aria-label={c.uploadTitle}>
    <h3 className="text-sm font-semibold">{c.uploadTitle}</h3><p className="text-xs text-stone-500">{c.uploadHelp}</p>
    <label className="block text-xs font-medium">{c.csvFile}<input className="staff-input mt-1 !text-xs" type="file" accept=".csv,text/csv" disabled={disabled} onChange={event => { const selected = event.target.files?.[0] || null; setFile(selected); setError(selected && (!/\.csv$/i.test(selected.name) || !selected.size || selected.size > 1_000_000) ? c.csvInvalid : ""); }} /></label>
    <p className="text-[11px] text-stone-500">{c.uploadLimit}</p><fieldset className="grid min-w-0 grid-cols-1 gap-3"><legend className="mb-1 text-xs font-semibold">{c.csvPeriod}</legend><label className="block min-w-0 text-xs">{c.csvStart}<input type="date" required className="staff-input mt-1" disabled={disabled} value={start} max={end || undefined} onChange={event => setStart(event.target.value)} /></label><label className="block min-w-0 text-xs">{c.csvEnd}<input type="date" required className="staff-input mt-1" disabled={disabled} value={end} min={start || undefined} onChange={event => setEnd(event.target.value)} /></label></fieldset>
    <p className="text-[11px] text-stone-500">{c.csvNoPreview}</p>{error && <p className="text-xs text-red-800" role="alert">{error}</p>}<div className="flex flex-wrap gap-2"><button type="submit" className="staff-button" disabled={disabled || !file}>{reading ? c.working : c.csvSubmit}</button><button type="button" className="staff-button staff-secondary" disabled={busy || reading} onClick={onClose}>{c.cancel}</button></div>
  </form>;
}
