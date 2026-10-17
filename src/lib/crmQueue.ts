export const crmQueues = [
  ["open_catering", "Open catering"],
  ["overdue_catering", "Overdue catering"],
  ["missing_owner", "Missing assignee"],
  ["missing_followup", "Missing follow-up time"],
  ["open_tasks", "Open tasks"],
  ["overdue_tasks", "Overdue tasks"],
  ["pending_decisions", "Awaiting Yücel"],
] as const;
export type CrmQueueName = typeof crmQueues[number][0];
export type CrmQueueItem = {
  kind: "request" | "task" | "decision"; id: string; request_id: string | null;
  customer_id: string; customer_name: string | null; title: string;
  request_status: string | null; assigned_to: string | null;
  due_at: string | null; created_at: string; flags: string[];
};
export type CrmQueue = {
  generated_at: string; queue: CrmQueueName; offset: number; page_size: number;
  total: number; counts: Record<CrmQueueName, number>; items: CrmQueueItem[];
};
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const id = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const date = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));
const nullableText = (v: unknown) => v === null || typeof v === "string";
export function validCrmQueue(v: unknown, queue: CrmQueueName, offset: number): v is CrmQueue {
  if (!object(v) || v.queue !== queue || v.offset !== offset || v.page_size !== 25
    || !date(v.generated_at) || !count(v.total) || !object(v.counts)
    || !crmQueues.every(([key]) => count((v.counts as Record<string, unknown>)[key]))
    || v.counts[queue] !== v.total || !Array.isArray(v.items)
    || v.items.length !== Math.min(25, Math.max(0, v.total - offset))) return false;
  const expectedKind = queue.includes("tasks") ? "task" : queue === "pending_decisions" ? "decision" : "request";
  return new Set(v.items.map(item => object(item) ? item.id : null)).size === v.items.length
    && v.items.every(item => object(item) && item.kind === expectedKind && id(item.id) && id(item.customer_id)
      && (expectedKind === "task" ? item.request_id === null : id(item.request_id))
      && nullableText(item.customer_name) && typeof item.title === "string"
      && nullableText(item.assigned_to) && (item.due_at === null || date(item.due_at)) && date(item.created_at)
      && (expectedKind === "task" ? item.request_status === null : ["new", "contacted", "quoted"].includes(String(item.request_status)))
      && Array.isArray(item.flags) && item.flags.every(flag => ["overdue", "missing_owner", "missing_followup", "decision"].includes(String(flag))));
}
