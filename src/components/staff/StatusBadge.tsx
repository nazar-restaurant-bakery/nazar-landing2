import { staffEmailLabels, staffStatuses } from "../../lib/staffCopy";
export default function StatusBadge({ value, kind = "email" }: { value: string; kind?: "email" | "request" }) {
  const label = (kind === "request" ? staffStatuses : staffEmailLabels)[value] || value || "—";
  const color = ["subscribed", "confirmed", "won"].includes(value) ? "bg-brand-primarySoft text-brand-dark border-brand-border"
    : ["unsubscribed", "suppressed"].includes(value) ? "bg-red-50 text-red-800 border-red-200"
      : ["pending_review", "pending"].includes(value) ? "bg-amber-50 text-amber-800 border-amber-200"
        : kind === "request" && ["new", "contacted", "quoted"].includes(value) ? "bg-blue-50 text-blue-800 border-blue-200" : "bg-stone-50 text-stone-600 border-stone-200";
  return <span className={`inline-flex max-w-full items-center rounded-lg border px-2 py-0.5 text-xs font-medium ${color}`}>{label}</span>;
}
