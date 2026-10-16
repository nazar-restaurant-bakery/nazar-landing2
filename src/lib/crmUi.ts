export async function safeCrmRequest<T>(request: () => PromiseLike<{ data: T; error: { code?: string } | null }>) {
  try { return await request(); }
  catch { return { data: null, error: { code: "NETWORK_ERROR" } }; }
}

export function crmDisplayDate(value: string | null) {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime())
    ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(parsed)
    : "Invalid date";
}

// The database records an Auth account, not the person using a shared login.
export function crmNoteAuthor(value: unknown) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? `Staff account ${value.toLowerCase().slice(0, 8)}`
    : "Author unavailable";
}

export function crmLocalInput(value: string | null) {
  if (!value) return "";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}T${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
}

export function validCrmTime(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2})?$/.exec(value);
  if (!match) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.getFullYear() === Number(match[1])
    && parsed.getMonth() + 1 === Number(match[2]) && parsed.getDate() === Number(match[3])
    && parsed.getHours() === Number(match[4]) && parsed.getMinutes() === Number(match[5]);
}

export function crmTaskError(title: string, owner: string, due: string) {
  if (!title.trim() || title.trim().length > 300) return "Enter a task between 1 and 300 characters.";
  if (!owner.trim() || owner.trim().length > 100) return "Enter an assignee between 1 and 100 characters.";
  return validCrmTime(due) ? null : "Enter a valid due time.";
}

export function crmRequestError(status: string, owner: string, due: string) {
  if (!["new", "contacted", "quoted", "won", "lost", "closed"].includes(status)) return "Choose a valid request status.";
  if (!owner.trim() || owner.trim().length > 100) return "Enter an assignee between 1 and 100 characters.";
  if (["new", "contacted", "quoted"].includes(status) && !due) return "Set a follow-up time for an open request.";
  return due && !validCrmTime(due) ? "Enter a valid follow-up time." : null;
}

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const nullableText = (v: unknown) => v === null || typeof v === "string";
const count = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
export function validCrmOverview(v: unknown) {
  return record(v) && Array.isArray(v.customers) && Array.isArray(v.requests)
    && v.customers.every(c => record(c) && typeof c.id === "string"
      && [c.name, c.email, c.phone, c.last_source, c.last_signup_at].every(nullableText)
      && typeof c.created_at === "string" && typeof c.email_status === "string"
      && [c.signup_count, c.vip_signup_count, c.kevin_signup_count].every(count)
      && Array.isArray(c.notes) && c.notes.every(n => record(n) && typeof n.body === "string")
      && Array.isArray(c.recent_signups) && c.recent_signups.every(s => record(s) && typeof s.source === "string"))
    && v.requests.every(r => record(r) && typeof r.id === "string" && typeof r.customer_id === "string"
      && [r.name, r.email, r.phone, r.assigned_to, r.follow_up_at].every(nullableText)
      && typeof r.status === "string" && typeof r.created_at === "string");
}

export function validCrmTasks(v: unknown) {
  return Array.isArray(v) && v.every(t => record(t) && typeof t.id === "string"
    && typeof t.title === "string" && typeof t.assigned_to === "string"
    && typeof t.due_at === "string" && nullableText(t.completed_at));
}

export function validCrmDecisions(v: unknown) {
  return record(v) && Array.isArray(v.items) && v.items.every(d => record(d)
    && typeof d.id === "string" && typeof d.request_id === "string" && typeof d.question === "string");
}
