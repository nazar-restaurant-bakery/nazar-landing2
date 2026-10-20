import { staffCopy as c } from "../../lib/staffCopy";
export default function AssigneeField({ value, onChange, disabled, id = "assignee" }: { value: string; onChange: (value: string) => void; disabled?: boolean; id?: string }) {
  const known = ["Talip", "Yücel"].includes(value);
  return <div><label htmlFor={id} className="staff-label">{c.owner}</label><select id={id} className="staff-input" disabled={disabled} value={!value ? "" : known ? value : "other"} onChange={event => onChange(event.target.value === "other" ? " " : event.target.value)}><option value="">{c.selectOwner}</option><option>Talip</option><option>Yücel</option><option value="other">{c.other}</option></select>{value && !known && <label className="mt-2 block text-xs">{c.otherOwner}<input className="staff-input" aria-label={c.otherOwner} maxLength={100} disabled={disabled} value={value.trimStart()} onChange={event => onChange(event.target.value || " ")} /></label>}</div>;
}
